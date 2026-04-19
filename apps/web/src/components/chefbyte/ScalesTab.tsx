import { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Check, ChevronDown, ChevronRight, Pencil } from 'lucide-react';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface LiveShelfDevice {
  device_id: string;
  user_id: string;
  device_name: string;
  import_key_hash: string;
  is_active: boolean;
  last_heartbeat_ts: string | null;
  pending_review_count: number;
  lan_ip: string | null;
  created_at: string;
}

interface ScalePairing {
  pairing_id: string;
  user_id: string;
  device_id: string;
  scale_id: string;
  kind: 'live_shelf' | 'live_scale' | 'catch_all';
  product_id: string | null;
  first_seen_at: string;
  last_heartbeat_ts: string | null;
}

interface ProductOption {
  product_id: string;
  name: string;
}

/* ------------------------------------------------------------------ */
/*  Shared class strings — match SettingsPage.tsx conventions          */
/* ------------------------------------------------------------------ */

const inputCls =
  'w-full px-3 py-2.5 border border-border-strong rounded-md text-sm box-border focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary';
const labelCls = 'block mb-1 font-semibold text-[13px] text-text-secondary';
const cardCls = 'border border-border rounded-lg p-3 mb-2 bg-surface';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Relative time string ("5s ago", "2m ago", "1h ago", "3d ago"). */
function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const now = Date.now();
  const then = new Date(iso).getTime();
  const deltaSec = Math.max(0, Math.floor((now - then) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  return `${Math.floor(deltaHr / 24)}d ago`;
}

/** Stale = no heartbeat in > 60s. Used to color the heartbeat label. */
function isStale(iso: string | null): boolean {
  if (!iso) return true;
  return Date.now() - new Date(iso).getTime() > 60_000;
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Validate a LAN IP or hostname. Accepts:
 *   - IPv4 dotted quad: "192.168.0.181"
 *   - Simple hostname (no scheme, no port, no slash): "my-pi.local"
 * Rejects anything containing a scheme, colon, slash, whitespace, or control chars.
 * This shields the inventory "Review" deep-link from protocol injection (e.g.
 * "javascript://evil.com") since the stored value is interpolated into an href.
 */
export function isValidLanIp(value: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 253) return false;
  // Explicit deny-list: no schemes, ports, slashes, whitespace, or angle brackets.
  if (/[:/\s<>\\?#@]/.test(trimmed)) return false;
  // Allow: IPv4 dotted quad OR alphanumeric hostname with dots and hyphens.
  return /^(?:\d{1,3}\.){3}\d{1,3}$|^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(trimmed);
}

/** Generate a URL-safe 32-byte random key (64 hex chars). */
function generateImportKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const kindLabel: Record<ScalePairing['kind'], string> = {
  live_shelf: 'live shelf',
  live_scale: 'live scale',
  catch_all: 'catch-all',
};

/* ================================================================== */
/*  ScalesTab                                                          */
/* ================================================================== */

export function ScalesTab() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  /* ---- UI state ---- */
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newShelfLocation, setNewShelfLocation] = useState('');
  const [generated, setGenerated] = useState<{ device_id: string; raw_key: string } | null>(null);
  const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [editingNameValue, setEditingNameValue] = useState('');
  const [editingIpId, setEditingIpId] = useState<string | null>(null);
  const [editingIpValue, setEditingIpValue] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [regenTarget, setRegenTarget] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      /* no-op */
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Queries                                                          */
  /* ---------------------------------------------------------------- */

  const { data: devices = [], isLoading: devicesLoading } = useQuery({
    queryKey: queryKeys.liveShelfDevices(user!.id),
    queryFn: async () => {
      const { data, error: err } = await chefbyte()
        .from('live_shelf_devices')
        .select('*')
        .eq('user_id', user!.id)
        .order('created_at');
      if (err) throw err;
      return (data ?? []) as LiveShelfDevice[];
    },
    enabled: !!user,
    // Heartbeat freshness matters; refetch every 15s to keep relative times honest.
    refetchInterval: 15_000,
  });

  const { data: pairings = [], isLoading: pairingsLoading } = useQuery({
    queryKey: queryKeys.scalePairings(user!.id),
    queryFn: async () => {
      const { data, error: err } = await chefbyte()
        .from('scale_pairings')
        .select('*')
        .eq('user_id', user!.id)
        .order('first_seen_at');
      if (err) throw err;
      return (data ?? []) as ScalePairing[];
    },
    enabled: !!user,
    refetchInterval: 15_000,
  });

  const { data: products = [] } = useQuery({
    queryKey: queryKeys.products(user!.id),
    queryFn: async () => {
      const { data, error: err } = await chefbyte()
        .from('products')
        .select('product_id,name')
        .eq('user_id', user!.id)
        .not('name', 'ilike', '[MEAL]%')
        .order('name');
      if (err) throw err;
      return (data ?? []) as ProductOption[];
    },
    enabled: !!user,
  });

  /* ---- Realtime: refresh on device heartbeat / pending_review_count changes ---- */
  useRealtimeInvalidation('chef-scales', [
    {
      schema: 'chefbyte',
      table: 'live_shelf_devices',
      queryKeys: [queryKeys.liveShelfDevices(user!.id)],
    },
    {
      schema: 'chefbyte',
      table: 'scale_pairings',
      queryKeys: [queryKeys.scalePairings(user!.id)],
    },
  ]);

  /* ---------------------------------------------------------------- */
  /*  Derived: pairings grouped by device_id                           */
  /* ---------------------------------------------------------------- */

  const pairingsByDevice = useMemo(() => {
    const map = new Map<string, ScalePairing[]>();
    for (const p of pairings) {
      const list = map.get(p.device_id) ?? [];
      list.push(p);
      map.set(p.device_id, list);
    }
    return map;
  }, [pairings]);

  const productMap = useMemo(() => new Map(products.map((p) => [p.product_id, p.name])), [products]);

  /* ---------------------------------------------------------------- */
  /*  Mutations                                                        */
  /* ---------------------------------------------------------------- */

  const invalidateDevices = () => queryClient.invalidateQueries({ queryKey: queryKeys.liveShelfDevices(user!.id) });

  const addDeviceMutation = useMutation({
    mutationFn: async () => {
      if (!user || !newName.trim()) throw new Error('Device name required');
      const rawKey = generateImportKey();
      const keyHash = await sha256Hex(rawKey);
      const displayName = newShelfLocation.trim() ? `${newName.trim()} — ${newShelfLocation.trim()}` : newName.trim();
      const { data, error: err } = await chefbyte()
        .from('live_shelf_devices')
        .insert({
          user_id: user.id,
          device_name: displayName,
          import_key_hash: keyHash,
        })
        .select('device_id')
        .single();
      if (err) throw err;
      if (!data || !data.device_id) throw new Error('Insert returned no data');
      return { device_id: data.device_id as string, raw_key: rawKey };
    },
    onError: (err: any) => setError(err.message ?? String(err)),
    onSuccess: (result) => {
      setGenerated(result);
      setNewName('');
      setNewShelfLocation('');
      setShowAdd(false);
      setError(null);
      invalidateDevices();
    },
  });

  const regenKeyMutation = useMutation({
    mutationFn: async (deviceId: string) => {
      const rawKey = generateImportKey();
      const keyHash = await sha256Hex(rawKey);
      const { error: err } = await chefbyte()
        .from('live_shelf_devices')
        .update({ import_key_hash: keyHash })
        .eq('device_id', deviceId);
      if (err) throw err;
      return { device_id: deviceId, raw_key: rawKey };
    },
    onError: (err: any) => setError(err.message ?? String(err)),
    onSuccess: (result) => {
      setGenerated(result);
      setRegenTarget(null);
      setError(null);
      invalidateDevices();
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ deviceId, isActive }: { deviceId: string; isActive: boolean }) => {
      const { error: err } = await chefbyte()
        .from('live_shelf_devices')
        .update({ is_active: isActive })
        .eq('device_id', deviceId);
      if (err) throw err;
    },
    onError: (err: any) => setError(err.message ?? String(err)),
    onSuccess: () => {
      setRevokeTarget(null);
      invalidateDevices();
    },
  });

  const renameDeviceMutation = useMutation({
    mutationFn: async ({ deviceId, name }: { deviceId: string; name: string }) => {
      const { error: err } = await chefbyte()
        .from('live_shelf_devices')
        .update({ device_name: name })
        .eq('device_id', deviceId);
      if (err) throw err;
    },
    onError: (err: any) => setError(err.message ?? String(err)),
    onSuccess: () => {
      setEditingNameId(null);
      setEditingNameValue('');
      invalidateDevices();
    },
  });

  const updateLanIpMutation = useMutation({
    mutationFn: async ({ deviceId, lanIp }: { deviceId: string; lanIp: string | null }) => {
      // Reject anything that could be weaponized into a non-http(s) href
      // (e.g. "javascript://evil.com"). Empty/null clears the field and is OK.
      if (lanIp !== null && !isValidLanIp(lanIp)) {
        throw new Error(
          'Invalid LAN IP. Use an IPv4 address (e.g. 192.168.0.181) or a hostname — no scheme, port, or slashes.',
        );
      }
      const { error: err } = await chefbyte()
        .from('live_shelf_devices')
        .update({ lan_ip: lanIp })
        .eq('device_id', deviceId);
      if (err) throw err;
    },
    onError: (err: any) => setError(err.message ?? String(err)),
    onSuccess: () => {
      setEditingIpId(null);
      setEditingIpValue('');
      invalidateDevices();
    },
  });

  const deleteDeviceMutation = useMutation({
    mutationFn: async (deviceId: string) => {
      const { error: err } = await chefbyte().from('live_shelf_devices').delete().eq('device_id', deviceId);
      if (err) throw err;
    },
    onError: (err: any) => setError(err.message ?? String(err)),
    onSuccess: () => {
      setDeleteTarget(null);
      invalidateDevices();
      queryClient.invalidateQueries({ queryKey: queryKeys.scalePairings(user!.id) });
    },
  });

  const pairScaleMutation = useMutation({
    mutationFn: async ({ pairingId, productId }: { pairingId: string; productId: string | null }) => {
      const { error: err } = await chefbyte()
        .from('scale_pairings')
        .update({ product_id: productId })
        .eq('pairing_id', pairingId);
      if (err) throw err;
    },
    onError: (err: any) => setError(err.message ?? String(err)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scalePairings(user!.id) });
    },
  });

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  const loading = devicesLoading || pairingsLoading;

  return (
    <div data-testid="scales-tab" className="p-5">
      {/* Section Header */}
      <div className="mb-4 pb-3 border-b border-border">
        <h2 className="m-0 text-lg font-bold text-text">Live Shelf Scales</h2>
        <p className="m-0 mt-1 text-sm text-text-secondary">
          Register Raspberry Pi shelf devices and pair their scales to products
        </p>
      </div>

      {error && (
        <p className="text-danger-text bg-danger-subtle px-3.5 py-2.5 rounded-md border border-danger mb-4">{error}</p>
      )}

      {/* ---- Add device ---- */}
      <div data-testid="add-shelf-device-section" className={cardCls}>
        <div className={`flex justify-between items-center ${showAdd ? 'mb-4' : ''}`}>
          <h3 className="m-0 text-base font-bold text-text">Add Device</h3>
          <button
            className={`text-white border-none rounded-md cursor-pointer font-semibold text-[13px] px-3.5 py-1.5 ${
              showAdd ? 'bg-text-secondary' : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
            onClick={() => setShowAdd((v) => !v)}
            data-testid="toggle-add-shelf-device"
          >
            {showAdd ? 'Cancel' : '+ New'}
          </button>
        </div>
        {showAdd && (
          <div data-testid="add-shelf-device-form" className="flex flex-col gap-3">
            <div>
              <label className={labelCls}>Device Name</label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                data-testid="shelf-device-name-input"
                className={inputCls}
                placeholder="e.g. Kitchen Pi"
              />
            </div>
            <div>
              <label className={labelCls}>Shelf Location (optional)</label>
              <input
                value={newShelfLocation}
                onChange={(e) => setNewShelfLocation(e.target.value)}
                data-testid="shelf-device-location-input"
                className={inputCls}
                placeholder="e.g. Top shelf, pantry..."
              />
            </div>
            <button
              className="bg-emerald-600 text-white border-none w-full py-3 rounded-md cursor-pointer font-semibold text-sm hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
              onClick={() => addDeviceMutation.mutate()}
              disabled={!newName.trim() || addDeviceMutation.isPending}
              data-testid="generate-shelf-device-btn"
            >
              Generate Device
            </button>
          </div>
        )}
      </div>

      {/* ---- Generated key modal-ish display ---- */}
      {generated && (
        <div
          data-testid="generated-shelf-device-info"
          className="border-2 border-success rounded-lg p-3 mb-2 bg-success-subtle"
        >
          <h3 className="m-0 mb-3 text-base font-bold text-success-text">Import Key Generated</h3>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <strong>Device ID:</strong>
            <code className="bg-border px-1.5 py-0.5 rounded text-[13px]">{generated.device_id}</code>
            <button
              onClick={() => copyToClipboard(generated.device_id, 'shelf-device-id')}
              data-testid="copy-shelf-device-id-btn"
              className="inline-flex items-center gap-1 px-2 py-1 bg-surface border border-border-strong rounded text-xs cursor-pointer hover:bg-surface-hover transition-colors"
            >
              {copiedKey === 'shelf-device-id' ? (
                <>
                  <Check className="w-3 h-3 text-success-text" /> <span className="text-success-text">Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" /> Copy
                </>
              )}
            </button>
          </div>
          <div className="flex items-start gap-2 mb-2 flex-wrap">
            <strong className="shrink-0">Import Key:</strong>
            <code className="bg-border px-1.5 py-0.5 rounded text-[13px] break-all min-w-0 flex-1">
              {generated.raw_key}
            </code>
            <button
              onClick={() => copyToClipboard(generated.raw_key, 'shelf-import-key')}
              data-testid="copy-shelf-import-key-btn"
              className="inline-flex items-center gap-1 px-2 py-1 bg-surface border border-border-strong rounded text-xs cursor-pointer hover:bg-surface-hover transition-colors shrink-0"
            >
              {copiedKey === 'shelf-import-key' ? (
                <>
                  <Check className="w-3 h-3 text-success-text" /> <span className="text-success-text">Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" /> Copy
                </>
              )}
            </button>
          </div>
          <p className="text-danger-text m-0 mb-3 text-sm font-semibold">
            Save this key now — you will not be able to see it again!
          </p>
          <button
            className="bg-text-secondary text-white border-none rounded-md cursor-pointer font-semibold text-[13px] px-3.5 py-1.5 hover:bg-text-tertiary"
            onClick={() => setGenerated(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ---- Device list ---- */}
      {loading ? (
        <p className="text-text-tertiary italic">Loading devices...</p>
      ) : devices.length === 0 ? (
        <p data-testid="no-shelf-devices" className="text-text-tertiary italic mt-4">
          No devices registered yet. Add one above to pair a Raspberry Pi.
        </p>
      ) : (
        <>
          <div className="mb-3 mt-4 pb-2 border-b border-border-light">
            <span className="text-sm font-semibold text-text-secondary">
              {devices.length} device{devices.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div data-testid="shelf-device-list">
            {devices.map((d) => {
              const isExpanded = expandedDeviceId === d.device_id;
              const stale = isStale(d.last_heartbeat_ts);
              const devicePairings = pairingsByDevice.get(d.device_id) ?? [];
              return (
                <div key={d.device_id} data-testid={`shelf-device-${d.device_id}`} className={cardCls}>
                  {/* Header row */}
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="flex-1 min-w-0">
                      {editingNameId === d.device_id ? (
                        <div className="flex items-center gap-2">
                          <input
                            value={editingNameValue}
                            onChange={(e) => setEditingNameValue(e.target.value)}
                            className={`${inputCls} max-w-xs`}
                            data-testid={`shelf-device-name-edit-${d.device_id}`}
                          />
                          <button
                            className="bg-emerald-600 text-white border-none px-3 py-1.5 rounded-md text-[13px] font-semibold hover:bg-emerald-700"
                            onClick={() =>
                              renameDeviceMutation.mutate({
                                deviceId: d.device_id,
                                name: editingNameValue.trim() || d.device_name,
                              })
                            }
                          >
                            Save
                          </button>
                          <button
                            className="bg-surface border border-border text-text-secondary px-3 py-1.5 rounded-md text-[13px] font-semibold hover:bg-surface-hover"
                            onClick={() => {
                              setEditingNameId(null);
                              setEditingNameValue('');
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <h4 className="m-0 text-base font-semibold truncate">{d.device_name}</h4>
                          <button
                            className="bg-transparent border-none text-text-tertiary hover:text-text cursor-pointer p-1"
                            onClick={() => {
                              setEditingNameId(d.device_id);
                              setEditingNameValue(d.device_name);
                            }}
                            data-testid={`rename-shelf-device-${d.device_id}`}
                            aria-label="Rename device"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[0.85em] text-text-secondary">
                        <span
                          className={stale ? 'text-warning-text font-semibold' : ''}
                          data-testid={`shelf-heartbeat-${d.device_id}`}
                        >
                          Last heartbeat: {relativeTime(d.last_heartbeat_ts)}
                        </span>
                        <span>
                          Status:{' '}
                          <span className={`font-semibold ${d.is_active ? 'text-success-text' : 'text-danger-text'}`}>
                            {d.is_active ? 'Active' : 'Revoked'}
                          </span>
                        </span>
                        {d.pending_review_count > 0 && (
                          <span
                            className="inline-flex items-center rounded-full bg-warning-subtle text-warning-text border border-warning px-2 py-0.5 text-xs font-semibold"
                            data-testid={`shelf-pending-badge-${d.device_id}`}
                          >
                            {d.pending_review_count} pending review
                          </span>
                        )}
                      </div>
                      {/* LAN IP */}
                      <div className="flex items-center gap-2 mt-1.5 text-[0.85em] text-text-secondary">
                        <span>LAN IP:</span>
                        {editingIpId === d.device_id ? (
                          <>
                            <input
                              value={editingIpValue}
                              onChange={(e) => setEditingIpValue(e.target.value)}
                              className={`${inputCls} max-w-[180px] py-1 text-[13px]`}
                              placeholder="192.168.0.181"
                              data-testid={`shelf-lan-ip-edit-${d.device_id}`}
                            />
                            <button
                              className="bg-emerald-600 text-white border-none px-2 py-1 rounded text-xs font-semibold hover:bg-emerald-700"
                              onClick={() =>
                                updateLanIpMutation.mutate({
                                  deviceId: d.device_id,
                                  lanIp: editingIpValue.trim() || null,
                                })
                              }
                            >
                              Save
                            </button>
                            <button
                              className="bg-surface border border-border text-text-secondary px-2 py-1 rounded text-xs font-semibold hover:bg-surface-hover"
                              onClick={() => {
                                setEditingIpId(null);
                                setEditingIpValue('');
                              }}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="font-mono">{d.lan_ip || '—'}</span>
                            <button
                              className="bg-transparent border-none text-text-tertiary hover:text-text cursor-pointer p-1"
                              onClick={() => {
                                setEditingIpId(d.device_id);
                                setEditingIpValue(d.lan_ip ?? '');
                              }}
                              data-testid={`edit-shelf-lan-ip-${d.device_id}`}
                              aria-label="Edit LAN IP"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Action row */}
                  <div className="flex flex-wrap gap-2 mt-3">
                    <button
                      onClick={() => setRegenTarget(d.device_id)}
                      data-testid={`regen-shelf-key-${d.device_id}`}
                      className="bg-transparent border border-border text-text-secondary cursor-pointer font-semibold text-[13px] px-2 py-1 rounded hover:bg-surface-hover"
                    >
                      Regenerate Key
                    </button>
                    {d.is_active ? (
                      <button
                        onClick={() => setRevokeTarget(d.device_id)}
                        data-testid={`revoke-shelf-device-${d.device_id}`}
                        className="bg-transparent border-none text-danger-text cursor-pointer font-semibold text-[13px] px-2 py-1 hover:text-red-700"
                      >
                        Revoke
                      </button>
                    ) : (
                      <button
                        onClick={() => toggleActiveMutation.mutate({ deviceId: d.device_id, isActive: true })}
                        data-testid={`reactivate-shelf-device-${d.device_id}`}
                        className="bg-transparent border-none text-success-text cursor-pointer font-semibold text-[13px] px-2 py-1 hover:text-emerald-700"
                      >
                        Reactivate
                      </button>
                    )}
                    <button
                      onClick={() => setDeleteTarget(d.device_id)}
                      data-testid={`delete-shelf-device-${d.device_id}`}
                      className="bg-transparent border-none text-danger-text cursor-pointer font-semibold text-[13px] px-2 py-1 hover:text-red-700"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setExpandedDeviceId(isExpanded ? null : d.device_id)}
                      data-testid={`toggle-shelf-scales-${d.device_id}`}
                      className="inline-flex items-center gap-1 bg-transparent border-none text-chef-accent cursor-pointer font-semibold text-[13px] px-2 py-1 hover:text-emerald-700"
                    >
                      {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      {isExpanded ? 'Hide' : 'Show'} Scales ({devicePairings.length})
                    </button>
                  </div>

                  {/* Expanded scales list */}
                  {isExpanded && (
                    <div
                      className="mt-3 border-t border-border-light pt-3 flex flex-col gap-2"
                      data-testid={`shelf-scales-${d.device_id}`}
                    >
                      {devicePairings.length === 0 ? (
                        <p className="text-text-tertiary italic text-sm m-0">
                          No scales seen yet. Once the Pi sends its first heartbeat, its scales will appear here.
                        </p>
                      ) : (
                        devicePairings.map((s) => (
                          <div
                            key={s.pairing_id}
                            data-testid={`scale-pairing-${s.pairing_id}`}
                            className="border border-border-light rounded-md bg-surface-sunken p-3"
                          >
                            <div className="flex items-center gap-2 flex-wrap">
                              <code className="bg-border px-1.5 py-0.5 rounded text-[12px]">{s.scale_id}</code>
                              <span
                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                                  s.kind === 'live_scale'
                                    ? 'bg-success-subtle text-success-text border border-success'
                                    : s.kind === 'live_shelf'
                                      ? 'bg-info-subtle text-info-text border border-blue-400'
                                      : 'bg-surface border border-border text-text-secondary'
                                }`}
                              >
                                {kindLabel[s.kind]}
                              </span>
                              <span className="text-[0.85em] text-text-secondary ml-auto">
                                Heartbeat: {relativeTime(s.last_heartbeat_ts)}
                              </span>
                            </div>
                            <div className="mt-2 text-sm">
                              {s.kind === 'live_scale' ? (
                                <div className="flex items-center gap-2 flex-wrap">
                                  <label className="text-text-secondary text-[13px]">Product:</label>
                                  <select
                                    value={s.product_id ?? ''}
                                    onChange={(e) =>
                                      pairScaleMutation.mutate({
                                        pairingId: s.pairing_id,
                                        productId: e.target.value || null,
                                      })
                                    }
                                    className={`${inputCls} flex-1 min-w-[180px] max-w-sm py-1.5 text-[13px]`}
                                    data-testid={`scale-product-picker-${s.pairing_id}`}
                                  >
                                    <option value="">Pair to product →</option>
                                    {products.map((p) => (
                                      <option key={p.product_id} value={p.product_id}>
                                        {p.name}
                                      </option>
                                    ))}
                                  </select>
                                  {s.product_id && (
                                    <span className="text-xs text-text-tertiary">
                                      {productMap.get(s.product_id) ?? 'Unknown product'}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-text-tertiary italic text-[13px]">
                                  Auto-classified via camera
                                </span>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ---- Confirmation dialogs ---- */}

      {regenTarget !== null && (
        <ConfirmDialog
          title="Regenerate Import Key"
          body="This invalidates the current key on the Pi immediately. You will need to copy the new key to the device. Continue?"
          confirmLabel="Regenerate"
          onCancel={() => setRegenTarget(null)}
          onConfirm={() => regenKeyMutation.mutate(regenTarget)}
          destructive
        />
      )}

      {revokeTarget !== null && (
        <ConfirmDialog
          title="Revoke Device"
          body="The Pi will stop being able to post events until reactivated. Continue?"
          confirmLabel="Revoke"
          onCancel={() => setRevokeTarget(null)}
          onConfirm={() => toggleActiveMutation.mutate({ deviceId: revokeTarget, isActive: false })}
          destructive
        />
      )}

      {deleteTarget !== null && (
        <ConfirmDialog
          title="Delete Device"
          body="This removes the device and all its scale pairings. Scale events already applied to stock stay put. Continue?"
          confirmLabel="Delete"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => deleteDeviceMutation.mutate(deleteTarget)}
          destructive
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Minimal confirmation dialog — matches SettingsPage style           */
/* ------------------------------------------------------------------ */

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  destructive,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Focus the Cancel button on mount so Enter doesn't accidentally confirm
  // a destructive action, and Escape has a clear target to close from.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Escape closes the dialog. Keydown on window so it fires regardless of
  // which focusable element is active inside the modal.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  // Tab boundary trap: Shift+Tab from first → last, Tab from last → first.
  const onContainerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const first = cancelRef.current;
    const last = confirmRef.current;
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]"
      onClick={onCancel}
      onKeyDown={onContainerKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
    >
      <div className="bg-surface rounded-xl shadow-xl p-5 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="m-0 mb-3 text-lg font-bold">{title}</h3>
        <p className="text-text-secondary m-0 mb-5">{body}</p>
        <div className="flex gap-2 justify-end">
          <button
            ref={cancelRef}
            className="bg-surface text-text-secondary border border-border px-4 py-2 rounded-md cursor-pointer font-semibold text-sm hover:bg-surface-hover"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            className={`text-white border-none px-4 py-2 rounded-md cursor-pointer font-semibold text-sm ${
              destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
