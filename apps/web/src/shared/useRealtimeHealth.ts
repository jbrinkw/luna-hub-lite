import { useSyncExternalStore, useCallback } from 'react';
import { realtimeHealth } from './realtimeHealth';
import { supabase } from './supabase';

/**
 * Short delay between `disconnect()` and `connect()` so the lib finishes
 * its internal state transition into 'disconnected' before we kick a new
 * connect — calling connect synchronously after disconnect can race the
 * shutdown handler. Tuned to match the same value used in
 * `useRealtimeInvalidation`'s onSocketClose debounce. Exported for tests.
 */
export const RECONNECT_SETTLE_MS = 300;

/**
 * React-facing subscription to the realtime health singleton. Returns
 * `{ degraded, reconnect }` where `degraded` flips to true as soon as ANY
 * tracked channel transitions to a terminal status (CHANNEL_ERROR /
 * TIMED_OUT / CLOSED) or fails to reach SUBSCRIBED before its
 * initial-connect grace window expires, and `reconnect` force-resubscribes
 * every tracked channel.
 *
 * `reconnect` does TWO things, in order:
 *   1. **Hard-resets the underlying Realtime socket** via
 *      `supabase.realtime.disconnect()` + `connect()`. This was the missing
 *      piece in the original implementation — `realtimeHealth.reconnectAll()`
 *      only re-subscribes registered channels, but if the underlying
 *      WebSocket itself is dead (which is the most common cause of a
 *      degraded banner — TIMED_OUT, CHANNEL_ERROR, CLOSED all imply socket
 *      issues), simply re-subscribing on a dead socket will sit forever in
 *      CONNECTING and the banner never clears. Disconnecting first forces
 *      the lib to throw away its broken socket and build a fresh one.
 *   2. **Fans out per-channel reconnectors** via `realtimeHealth.reconnectAll()`.
 *      This rebuilds each `supabase.channel(...)` so the freshly-connected
 *      socket has a clean set of subscriptions.
 *
 * Returns a Promise that resolves once both steps have been kicked off
 * (the actual SUBSCRIBED transition arrives asynchronously over the wire).
 * Callers can await this to know when to drop a "Reconnecting…" UI state.
 *
 * Implemented with `useSyncExternalStore` so it participates correctly in
 * concurrent-rendering tear-off checks — the store is a plain singleton
 * (not React state) so a hand-rolled `useEffect + useState` pair would
 * race on the initial render path.
 */
export function useRealtimeHealth() {
  const degraded = useSyncExternalStore(
    realtimeHealth.subscribe,
    () => realtimeHealth.isAnyDegraded(),
    () => false,
  );

  const reconnect = useCallback(async (): Promise<void> => {
    // 1. Hard-reset the socket. Both calls are wrapped because they may
    //    throw during shutdown races (e.g. disconnect() while already
    //    disconnecting). Failures here should NOT abort step 2 — the
    //    per-channel reconnect is independently useful.
    try {
      supabase.realtime.disconnect();
      // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: Supabase realtime disconnect throws during state transitions (e.g. already disconnecting) — best-effort
    } catch {}
    // Brief pause so the lib settles into 'disconnected' before connect.
    await new Promise<void>((resolve) => setTimeout(resolve, RECONNECT_SETTLE_MS));
    try {
      supabase.realtime.connect();
      // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: Supabase realtime connect() throws when already connecting/connected — best-effort
    } catch {}
    // 2. Re-subscribe every tracked channel on the freshly-connected socket.
    realtimeHealth.reconnectAll();
  }, []);

  return {
    degraded,
    reconnect,
  };
}
