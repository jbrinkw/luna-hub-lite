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
 */

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Ban, AlertTriangle } from 'lucide-react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ListSkeleton } from '@/components/ui/Skeleton';
import { Alert } from '@/components/ui/Alert';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte } from '@/shared/supabase';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';

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

  const queryKey = useMemo(() => ['chef-reviews', user?.id ?? 'anon'] as const, [user?.id]);

  const { data, isLoading, error } = useQuery({
    queryKey,
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async (): Promise<ReviewRow[]> => {
      const res = await chefbyte()
        .from('review_queue')
        .select(
          'review_id, pi_review_id, kind, status, proposed, images, created_at, resolved_at, user_response, pi_event_id',
        )
        .eq('user_id', user!.id)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });
      if (res.error) throw res.error;
      return (res.data ?? []) as ReviewRow[];
    },
  });

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
