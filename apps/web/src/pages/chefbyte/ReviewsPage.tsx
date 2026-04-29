/**
 * ReviewsPage (`/chef/reviews`)
 *
 * Cloud mirror of the Pi-side ``review_queue`` (sync-audit finding #5).
 * Lists pending reviews emitted by the Pi for human-in-the-loop
 * resolution: low-confidence classifications, weight mismatches,
 * unpaired removes, etc.
 *
 * The user picks Accept (resolved) or Reject (dismissed); both flips
 * propagate back to the Pi via the ``review_sync_poller`` running on
 * the Pi side.
 *
 * Realtime: subscribes to chefbyte.review_queue postgres_changes so
 * Pi-driven creates + Pi-side resolutions both land live.
 *
 * Image rendering (approach (a) — direct LAN fetch):
 * The Pi serves before/after JPEGs at http://<lan_ip>:8000/event/<event_id>/<frame>.jpg
 * (see hardware/live-shelf/server/web/routes.py event_image route). The
 * cloud row's ``images`` JSONB carries Pi-relative paths
 * (``events/<event_id>/<frame>.jpg``); we look up the device's lan_ip
 * from chefbyte.live_shelf_devices, validate it via isValidLanIp (XSS
 * fence), and build absolute URLs. Off-LAN operators silently get a
 * gray placeholder + tooltip — no cloud storage cost. This matches the
 * existing EventViewerPage image flow (same pattern, same security
 * gates).
 */

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Ban, AlertTriangle, ImageOff } from 'lucide-react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ListSkeleton } from '@/components/ui/Skeleton';
import { Alert } from '@/components/ui/Alert';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte } from '@/shared/supabase';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';
import { isValidLanIp } from '@/components/chefbyte/ScalesTab';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ReviewKind =
  | 'unknown_item_add'
  | 'low_confidence'
  | 'weight_mismatch'
  | 'unpaired_remove'
  | 'multi_match'
  | 'failed_intake'
  | 'sensor_anomaly';

export type ReviewStatus = 'pending' | 'resolved' | 'dismissed';

export interface ReviewRow {
  review_id: string;
  pi_review_id: string;
  kind: ReviewKind;
  status: ReviewStatus;
  proposed: Record<string, unknown> | null;
  images: string[] | null;
  created_at: string;
  resolved_at: string | null;
  user_response: Record<string, unknown> | null;
  pi_event_id: string | null;
  /** HTTPS cloud URL for before image. Null until Pi uploads. */
  before_image_url: string | null;
  /** HTTPS cloud URL for after image. Null until Pi uploads. */
  after_image_url: string | null;
}

interface DeviceLite {
  device_id: string;
  lan_ip: string | null;
  last_heartbeat_ts: string | null;
}

/**
 * Translate a Pi-relative image path (``events/<event_id>/before.jpg``)
 * to an absolute URL the browser can fetch from the Pi LAN web server
 * (``http://<lan_ip>:8000/event/<event_id>/before.jpg``).
 *
 * Exported pure for testability — same XSS fence approach as
 * InventoryPage's review-deep-link helper:
 *   - lanIp is re-validated via isValidLanIp before interpolation
 *   - relative path must be ``events/<id>/<frame.jpg>`` shape; anything
 *     else (absolute URL, ../, control chars) is rejected and the
 *     caller falls back to the placeholder
 *
 * Returns null when either input is unsafe — caller renders a gray
 * placeholder with the "image unavailable" tooltip.
 */
export function buildPiImageUrl(lanIp: string | null, relativePath: string | null): string | null {
  if (!lanIp || !relativePath) return null;
  if (!isValidLanIp(lanIp)) return null;
  // Accept ``events/<event_id>/<filename>`` only. event_id and filename
  // each must be a single segment with no path traversal characters.
  // The Pi route allow-lists filenames to {before.jpg, after.jpg,
  // session.mp4} so any drift here is caught server-side too.
  const m = /^events\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(relativePath);
  if (!m) return null;
  const eventId = m[1];
  const filename = m[2];
  return `http://${lanIp}:8000/event/${encodeURIComponent(eventId)}/${encodeURIComponent(filename)}`;
}

const KIND_LABELS: Record<ReviewKind, string> = {
  unknown_item_add: 'Unknown item added',
  low_confidence: 'Low-confidence classifier',
  weight_mismatch: 'Weight mismatch',
  unpaired_remove: 'Unpaired remove',
  multi_match: 'Multiple matches',
  failed_intake: 'Failed intake',
  sensor_anomaly: 'Sensor anomaly',
};

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export function ReviewsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [overrideText, setOverrideText] = useState<Record<string, string>>({});
  // Tracks per-image fetch failures so we render a placeholder + tooltip
  // instead of a broken image icon when the operator is off-LAN.
  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});

  const queryKey = useMemo(() => ['chef-reviews', user?.id ?? 'anon'] as const, [user?.id]);
  const devicesKey = useMemo(() => ['chef-reviews-devices', user?.id ?? 'anon'] as const, [user?.id]);

  const { data, isLoading, error } = useQuery({
    queryKey,
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async (): Promise<ReviewRow[]> => {
      const res = await chefbyte()
        .from('review_queue')
        .select(
          'review_id, pi_review_id, kind, status, proposed, images, created_at, resolved_at, user_response, pi_event_id, before_image_url, after_image_url',
        )
        .eq('user_id', user!.id)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });
      if (res.error) throw res.error;
      return (res.data ?? []) as ReviewRow[];
    },
  });

  // Devices: needed to resolve the Pi LAN IP for image URLs. Mirrors the
  // EventViewerPage pattern — pick the most recently heart-beating device
  // that has a non-empty lan_ip.
  const { data: devices } = useQuery({
    queryKey: devicesKey,
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<DeviceLite[]> => {
      const res = await chefbyte()
        .from('live_shelf_devices')
        .select('device_id, lan_ip, last_heartbeat_ts')
        .eq('user_id', user!.id);
      if (res.error) throw res.error;
      return (res.data ?? []) as DeviceLite[];
    },
  });

  const lanIp = useMemo(() => {
    const list = devices ?? [];
    const fresh = [...list]
      .filter((d) => d.lan_ip && d.lan_ip.trim() !== '' && isValidLanIp(d.lan_ip))
      .sort((a, b) => {
        const ta = a.last_heartbeat_ts ? new Date(a.last_heartbeat_ts).getTime() : 0;
        const tb = b.last_heartbeat_ts ? new Date(b.last_heartbeat_ts).getTime() : 0;
        return tb - ta;
      });
    return fresh[0]?.lan_ip ?? null;
  }, [devices]);

  // Realtime push: any Pi-driven create or another-tab resolution
  // refetches the pending list immediately.
  useRealtimeInvalidation('chef-reviews-rt', [{ schema: 'chefbyte', table: 'review_queue', queryKeys: [queryKey] }]);

  const resolveMutation = useMutation({
    mutationFn: async (args: {
      review_id: string;
      status: 'resolved' | 'dismissed';
      user_response: Record<string, unknown> | null;
    }) => {
      const { data: row, error: rpcErr } = await chefbyte().rpc('resolve_review', {
        p_review_id: args.review_id,
        p_status: args.status,
        p_user_response: args.user_response,
      });
      if (rpcErr) throw rpcErr;
      return row;
    },
    // Optimistic remove from the list — list shows pending only.
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ReviewRow[]>(queryKey);
      queryClient.setQueryData<ReviewRow[]>(queryKey, (old) =>
        (old ?? []).filter((r) => r.review_id !== args.review_id),
      );
      return { previous };
    },
    onError: (_err, _args, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const handleAccept = (row: ReviewRow) => {
    const txt = (overrideText[row.review_id] ?? '').trim();
    const userResponse: Record<string, unknown> = txt ? { decision: 'accept', override: txt } : { decision: 'accept' };
    resolveMutation.mutate({
      review_id: row.review_id,
      status: 'resolved',
      user_response: userResponse,
    });
  };

  const handleReject = (row: ReviewRow) => {
    resolveMutation.mutate({
      review_id: row.review_id,
      status: 'dismissed',
      user_response: { decision: 'reject' },
    });
  };

  return (
    <ChefLayout title="Reviews">
      <div className="space-y-4" data-testid="reviews-page">
        <header>
          <h1 className="text-xl font-semibold text-text">Pending reviews</h1>
          <p className="text-sm text-text-secondary mt-1">
            Items the Pi flagged for human review — low-confidence classifications, weight mismatches, etc. Accept to
            confirm, Reject to dismiss. Decisions sync back to the Pi.
          </p>
        </header>

        {error ? <Alert variant="error">Failed to load reviews: {(error as Error).message}</Alert> : null}

        {isLoading ? <ListSkeleton count={3} /> : null}

        {!isLoading && (data ?? []).length === 0 ? (
          <div
            className="rounded-lg border border-border bg-surface p-6 text-center text-text-secondary"
            data-testid="reviews-empty"
          >
            No pending reviews.
          </div>
        ) : null}

        <ul className="space-y-3" data-testid="reviews-list">
          {(data ?? []).map((row) => (
            <li
              key={row.review_id}
              className="rounded-lg border border-border bg-surface p-4 shadow-sm"
              data-testid={`review-row-${row.review_id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-warning-text" />
                    <span className="text-sm font-semibold text-text">{KIND_LABELS[row.kind]}</span>
                    <span className="text-xs text-text-tertiary">{new Date(row.created_at).toLocaleString()}</span>
                  </div>

                  {/* Image strip — priority: cloud HTTPS > LAN fallback > placeholder.
                      Cloud URLs (before_image_url / after_image_url) are set by the Pi
                      after uploading to Supabase Storage; they work everywhere with no
                      mixed-content blocking. LAN fallback only fires when cloud URLs are
                      null AND the operator has a valid lan_ip (on-LAN only). */}
                  {(Array.isArray(row.images) && row.images.length > 0) ||
                  row.before_image_url ||
                  row.after_image_url ? (
                    <div className="mt-2 flex flex-wrap gap-2" data-testid={`review-images-${row.review_id}`}>
                      {/* Build a unified image list: cloud URLs take priority per slot;
                          fall back to the images[] LAN paths for any slot without a cloud URL. */}
                      {(['before', 'after'] as const).map((slot, idx) => {
                        const cloudUrl = slot === 'before' ? row.before_image_url : row.after_image_url;
                        const relPath = Array.isArray(row.images)
                          ? (row.images.find((p) => p.endsWith(`${slot}.jpg`)) ?? null)
                          : null;
                        // Cloud URL: use directly (HTTPS, no mixed-content).
                        const resolvedUrl: string | null = cloudUrl ?? buildPiImageUrl(lanIp, relPath);
                        const errKey = `${row.review_id}::${idx}`;
                        const failed = imageErrors[errKey] === true;
                        const altLabel = slot === 'before' ? 'Before' : 'After';

                        if (!resolvedUrl || failed) {
                          return (
                            <div
                              key={errKey}
                              className="w-24 h-24 rounded-lg border border-border bg-surface-sunken flex flex-col items-center justify-center text-text-tertiary"
                              title={
                                !resolvedUrl
                                  ? lanIp
                                    ? 'Image not available yet'
                                    : 'Image unavailable — connect to the Pi network or wait for cloud upload'
                                  : 'Image unavailable'
                              }
                              data-testid={`review-image-placeholder-${row.review_id}-${idx}`}
                            >
                              <ImageOff className="h-5 w-5" />
                              <span className="mt-0.5 text-[10px] uppercase tracking-wide">{altLabel}</span>
                            </div>
                          );
                        }
                        return (
                          <figure key={errKey} className="flex flex-col items-center">
                            <img
                              src={resolvedUrl}
                              alt={altLabel}
                              loading="lazy"
                              className="w-24 h-24 rounded-lg object-cover border border-border bg-surface-sunken"
                              onError={() => setImageErrors((s) => ({ ...s, [errKey]: true }))}
                              data-testid={`review-image-${row.review_id}-${idx}`}
                            />
                            <figcaption className="mt-0.5 text-[10px] uppercase tracking-wide text-text-tertiary">
                              {altLabel}
                            </figcaption>
                          </figure>
                        );
                      })}
                    </div>
                  ) : null}

                  {row.proposed ? (
                    <pre
                      className="mt-2 max-h-40 overflow-auto rounded bg-surface-sunken p-2 text-xs text-text-secondary whitespace-pre-wrap"
                      data-testid={`review-proposed-${row.review_id}`}
                    >
                      {JSON.stringify(row.proposed, null, 2)}
                    </pre>
                  ) : null}

                  <label className="mt-2 block text-xs text-text-secondary">
                    Override (optional, sent as <code>user_response.override</code>):
                    <input
                      type="text"
                      className="mt-1 w-full rounded border border-border bg-surface-sunken px-2 py-1 text-sm text-text"
                      placeholder="e.g. correct product id or note"
                      value={overrideText[row.review_id] ?? ''}
                      onChange={(e) => setOverrideText((s) => ({ ...s, [row.review_id]: e.target.value }))}
                      data-testid={`review-override-${row.review_id}`}
                    />
                  </label>
                </div>

                <div className="flex flex-col gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleAccept(row)}
                    disabled={resolveMutation.isPending}
                    className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                    data-testid={`review-accept-${row.review_id}`}
                  >
                    <Check className="h-4 w-4" />
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => handleReject(row)}
                    disabled={resolveMutation.isPending}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-surface-hover disabled:opacity-60"
                    data-testid={`review-reject-${row.review_id}`}
                  >
                    <Ban className="h-4 w-4" />
                    Reject
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </ChefLayout>
  );
}
