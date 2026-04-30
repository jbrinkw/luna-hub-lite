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
 *     The pgTAP `realtime_publication_completeness` gate catches this at CI
 *     time now; this store still surfaces any runtime regression.
 *   - Auth token expired mid-session — WS closes with policy violation.
 *   - Network blip or OS resume — socket closed, reconnect logic failed.
 *   - Supabase server restart during a publication migration.
 *
 * Detection = single signal per channel: the `status` argument from
 * `channel.subscribe((status, err) => ...)`:
 *   SUBSCRIBED | TIMED_OUT | CHANNEL_ERROR | CLOSED | CONNECTING.
 *
 * The earlier design also ran a 30s broadcast-self heartbeat as a "silent
 * stall" probe but it could not actually detect the publication-gap failure
 * mode it was designed for (broadcast and postgres_changes traverse different
 * server paths) and was the source of a post-idle 401 storm in the browser
 * console — the heartbeat kept firing on dead channels with stale JWTs.
 * Removed in favor of state-machine-driven health; see the equivalent
 * docblock in useRealtimeInvalidation.ts for the full justification.
 *
 * **Initial-connect grace window.** A freshly registered channel starts in
 * `CONNECTING` and typically reaches `SUBSCRIBED` within a few hundred ms.
 * To avoid a banner flash on every page load, a channel is NOT considered
 * degraded during the first `INITIAL_CONNECT_GRACE_MS` after registration
 * unless a terminal-error status arrives. After the grace window expires,
 * if the channel still hasn't reached `SUBSCRIBED`, it flips to `degraded`
 * and the banner appears.
 *
 * Once a channel has reached `SUBSCRIBED` at least once, the grace window
 * no longer applies — any subsequent terminal status flips it to degraded
 * immediately so mid-session disconnects surface promptly.
 *
 * A channel is `healthy` iff it's currently SUBSCRIBED (or within the
 * initial-connect grace window with no terminal error). Any non-SUBSCRIBED
 * terminal status (after grace) flips it to `degraded`. The aggregate
 * `isAnyDegraded()` returns true if *any* registered channel is degraded —
 * that's what the UI banner watches.
 */

export type ChannelStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CHANNEL_ERROR' | 'CLOSED' | 'CONNECTING';

export interface ChannelHealth {
  key: string;
  status: ChannelStatus;
  /** Wall-clock ms when register() was called — used to enforce grace window. */
  registeredAt: number;
  /** Has this channel ever reached SUBSCRIBED? Once true, grace window no longer applies. */
  everSubscribed: boolean;
  degraded: boolean;
  lastError?: string;
}

/**
 * How long after `register()` a channel may remain in `CONNECTING` (or any
 * non-terminal non-SUBSCRIBED state) without being treated as degraded.
 * Tuned to comfortably outlast a typical Supabase Realtime connect (~200-
 * 800ms in healthy conditions) while still surfacing a truly-stuck channel
 * promptly. Intentionally exported so tests can read it without redefining.
 */
export const INITIAL_CONNECT_GRACE_MS = 3_000;

type Listener = () => void;

const channels = new Map<string, ChannelHealth>();
const listeners = new Set<Listener>();
// Forced-reconnect handlers — the hook registers one per channel so the UI
// banner can trigger a subscribe() cycle across every tracked channel.
const reconnectors = new Map<string, () => void>();
// Per-channel timers that fire when the initial-connect grace window
// expires. Stored so we can cancel them if the channel reaches SUBSCRIBED
// (or unregisters) before the grace window elapses.
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function emit() {
  for (const l of listeners) l();
}

function isTerminalError(status: ChannelStatus): boolean {
  return status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED';
}

/**
 * Recompute `degraded` for a single channel from its current status and
 * grace-window state.
 *
 * Decision matrix:
 *   - Status SUBSCRIBED → healthy
 *   - Terminal error (CHANNEL_ERROR/TIMED_OUT/CLOSED) → degraded
 *   - Otherwise (CONNECTING, etc.):
 *       within grace window AND never errored → healthy ("connecting…")
 *       beyond grace window OR has previously subscribed → degraded
 */
function recompute(key: string, now: number = Date.now()) {
  const h = channels.get(key);
  if (!h) return;
  if (h.status === 'SUBSCRIBED') {
    h.degraded = false;
    return;
  }
  if (isTerminalError(h.status)) {
    h.degraded = true;
    return;
  }
  // Non-terminal, non-SUBSCRIBED (e.g. CONNECTING). Healthy iff we're still
  // inside the initial-connect grace window AND the channel has never been
  // SUBSCRIBED before (a re-CONNECTING after disconnect should NOT get a
  // fresh grace window — that would mask mid-session disconnects).
  const withinGrace = !h.everSubscribed && now - h.registeredAt < INITIAL_CONNECT_GRACE_MS;
  h.degraded = !withinGrace;
}

function clearGraceTimer(key: string) {
  const t = graceTimers.get(key);
  if (t) {
    clearTimeout(t);
    graceTimers.delete(key);
  }
}

export const realtimeHealth = {
  register(key: string, reconnect: () => void): void {
    if (!channels.has(key)) {
      const now = Date.now();
      channels.set(key, {
        key,
        status: 'CONNECTING',
        registeredAt: now,
        everSubscribed: false,
        degraded: false, // within grace window, treat as healthy ("connecting…")
      });
      // Schedule a wake-up so listeners re-evaluate when grace expires.
      // If the channel reaches SUBSCRIBED before this fires, the timer is
      // cleared in setStatus(); if it doesn't, the channel flips to
      // degraded and the banner appears.
      const timer = setTimeout(() => {
        graceTimers.delete(key);
        const h = channels.get(key);
        if (!h) return;
        recompute(key);
        emit();
      }, INITIAL_CONNECT_GRACE_MS);
      graceTimers.set(key, timer);
    }
    reconnectors.set(key, reconnect);
    emit();
  },

  unregister(key: string): void {
    clearGraceTimer(key);
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
      // Pin everSubscribed so future disconnects do NOT get a fresh grace
      // window — mid-session disconnects must surface promptly.
      h.everSubscribed = true;
      clearGraceTimer(key);
    }
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
    // Recompute on read so a channel whose grace window has *just* expired
    // surfaces as degraded even if no setTimeout has fired yet (e.g. tests
    // that manipulate Date.now() without advancing timers, or a pathological
    // tab that was throttled by the browser).
    const now = Date.now();
    for (const h of channels.values()) {
      recompute(h.key, now);
      if (h.degraded) return true;
    }
    return false;
  },

  reconnectAll(): void {
    for (const r of reconnectors.values()) {
      try {
        r();
        // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: individual reconnect failures are caught and handled inside each hook — swallow to keep iterating
      } catch {}
    }
  },

  /** Test-only: wipe state between tests to avoid cross-test leakage. */
  _resetForTests(): void {
    for (const t of graceTimers.values()) clearTimeout(t);
    graceTimers.clear();
    channels.clear();
    reconnectors.clear();
    listeners.clear();
  },
};
