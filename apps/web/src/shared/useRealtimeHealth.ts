import { useSyncExternalStore } from 'react';
import { realtimeHealth } from './realtimeHealth';

/**
 * React-facing subscription to the realtime health singleton. Returns
 * `{ degraded, reconnect }` where `degraded` flips to true as soon as ANY
 * tracked channel loses its SUBSCRIBED status or misses three consecutive
 * heartbeats, and `reconnect` force-resubscribes every tracked channel.
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
  return {
    degraded,
    reconnect: () => realtimeHealth.reconnectAll(),
  };
}
