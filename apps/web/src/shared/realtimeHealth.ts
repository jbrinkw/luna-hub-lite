/**
 * realtimeHealth — singleton store tracking Supabase Realtime WebSocket health.
 *
 * Motivation: a broken Realtime WS is visually identical to "everything fine".
 * `navigator.onLine` is true, pages render happily, but no `postgres_changes`
 * events ever arrive so data goes stale. Example failure modes that this store
 * catches and surfaces:
 *
 *   - Table accidentally dropped from the `supabase_realtime` publication
 *     (server responds `status: error`, channel transitions CHANNEL_ERROR).
 *   - Auth token expired mid-session — WS closes with policy violation.
 *   - Network blip or OS resume — socket closed, reconnect logic failed.
 *   - Supabase server restart during a publication migration.
 *
 * Detection = two signals per channel:
 *
 *   1. **Status** from `channel.subscribe((status, err) => ...)`:
 *        SUBSCRIBED | TIMED_OUT | CHANNEL_ERROR | CLOSED
 *   2. **Broadcast echo heartbeat**: every 30s we emit a self-addressed
 *      broadcast on the same channel and listen for its echo (via
 *      `config.broadcast.self = true`). If three consecutive heartbeats fail
 *      to echo back, we flip to `degraded`. This validates the full WS path
 *      without hitting Postgres (no write cost; see ALTERNATIVE in the task
 *      brief — broadcast-self is strictly cheaper than a Postgres write).
 *
 * A channel is `healthy` iff its last status is SUBSCRIBED AND the most
 * recent heartbeat echoed back. Any non-SUBSCRIBED terminal status, or
 * 3 consecutive missed heartbeats, flips it to `degraded`. The aggregate
 * `isAnyDegraded()` returns true if *any* registered channel is degraded —
 * that's what the UI banner watches.
 */

export type ChannelStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CHANNEL_ERROR' | 'CLOSED' | 'CONNECTING';

export interface ChannelHealth {
  key: string;
  status: ChannelStatus;
  missedHeartbeats: number;
  lastHeartbeatAt: number | null;
  degraded: boolean;
  lastError?: string;
}

type Listener = () => void;

const channels = new Map<string, ChannelHealth>();
const listeners = new Set<Listener>();
// Forced-reconnect handlers — the hook registers one per channel so the UI
// banner can trigger a subscribe() cycle across every tracked channel.
const reconnectors = new Map<string, () => void>();

function emit() {
  for (const l of listeners) l();
}

function recompute(key: string) {
  const h = channels.get(key);
  if (!h) return;
  const statusOk = h.status === 'SUBSCRIBED';
  const heartbeatOk = h.missedHeartbeats < 3;
  h.degraded = !(statusOk && heartbeatOk);
}

export const realtimeHealth = {
  register(key: string, reconnect: () => void): void {
    if (!channels.has(key)) {
      channels.set(key, {
        key,
        status: 'CONNECTING',
        missedHeartbeats: 0,
        lastHeartbeatAt: null,
        degraded: true, // degraded until first SUBSCRIBED arrives
      });
    }
    reconnectors.set(key, reconnect);
    emit();
  },

  unregister(key: string): void {
    channels.delete(key);
    reconnectors.delete(key);
    emit();
  },

  setStatus(key: string, status: ChannelStatus, err?: string): void {
    const h = channels.get(key);
    if (!h) return;
    h.status = status;
    h.lastError = err;
    if (status === 'SUBSCRIBED') {
      // Fresh subscribe — reset heartbeat miss counter so we don't stay
      // degraded forever after a recovery.
      h.missedHeartbeats = 0;
    }
    recompute(key);
    emit();
  },

  markHeartbeatSent(key: string): void {
    const h = channels.get(key);
    if (!h) return;
    h.missedHeartbeats += 1;
    recompute(key);
    emit();
  },

  markHeartbeatEcho(key: string): void {
    const h = channels.get(key);
    if (!h) return;
    h.missedHeartbeats = 0;
    h.lastHeartbeatAt = Date.now();
    recompute(key);
    emit();
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getSnapshot(): ReadonlyMap<string, ChannelHealth> {
    return channels;
  },

  isAnyDegraded(): boolean {
    for (const h of channels.values()) {
      if (h.degraded) return true;
    }
    return false;
  },

  reconnectAll(): void {
    for (const r of reconnectors.values()) {
      try {
        r();
      } catch {
        /* swallow — individual reconnect failures are handled inside the hook */
      }
    }
  },

  /** Test-only: wipe state between tests to avoid cross-test leakage. */
  _resetForTests(): void {
    channels.clear();
    reconnectors.clear();
    listeners.clear();
  },
};
