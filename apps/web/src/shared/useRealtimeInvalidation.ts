import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from './supabase';
import { useAuth } from './auth/AuthProvider';

interface RealtimeSub {
  schema: string;
  table: string;
  filter?: string;
  queryKeys: readonly (readonly unknown[])[];
}

/**
 * Subscribe to Supabase Realtime postgres_changes and invalidate specific
 * TanStack Query keys when rows change. Replaces the old pattern of
 * "Realtime event → refetch all page data".
 *
 * **Channel-per-table.** Each `RealtimeSub` lives on its OWN underlying
 * channel (name = `${channelName}:${schema}.${table}`). Consolidating
 * multiple tables onto one shared channel is tempting but dangerous: if
 * ANY of the tables isn't in the Supabase realtime publication, the
 * server responds with `status: error` for the whole channel and *every*
 * subscription on that channel goes silent — including the ones for
 * tables that ARE published. We hit exactly this in production when
 * `chefbyte.live_shelf_devices` wasn't yet in the publication: stock_lots
 * and products events stopped being delivered to the inventory page even
 * though those tables were published correctly. Splitting per-table
 * isolates the failure so a missing publication on one table no longer
 * knocks out its neighbors.
 *
 * **Reconnect resilience.** Supabase's `realtime.disconnect()` and server-
 * side idle-close transitions the socket to disconnected WITHOUT
 * reconnecting automatically (auto-reconnect in supabase-js only triggers
 * for sockets that failed mid-handshake — explicit disconnects and clean
 * closes are left alone on purpose). We hook the underlying WebSocket's
 * `close` event via `stateChangeCallbacks.close` to trigger a reconnect,
 * which supabase-js then uses to rejoin every registered channel
 * automatically. Without this, a tab that gets backgrounded or suffers
 * a brief network blip stops receiving realtime events until manual
 * reload.
 */
export function useRealtimeInvalidation(channelName: string, subscriptions: RealtimeSub[]) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const subsRef = useRef(subscriptions);

  useEffect(() => {
    subsRef.current = subscriptions;
  });

  useEffect(() => {
    if (!user) return;

    // Guard so late async callbacks (onClose reconnect) don't fire after
    // this effect's cleanup.
    let cancelled = false;

    // One channel per subscription — see docblock above for why we don't
    // multiplex.
    const channels = subsRef.current.map((sub) => {
      const perTableName = `${channelName}:${sub.schema}.${sub.table}`;
      const channel = supabase
        .channel(perTableName)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: sub.schema,
            table: sub.table,
            filter: sub.filter ?? `user_id=eq.${user.id}`,
          },
          () => {
            // Read the latest subscriptions from the ref in case the caller
            // re-rendered with new keys after mount. Invalidate AND force a
            // refetch: the default ``refetchType: 'active'`` silently skips
            // queries whose observers aren't settled yet (e.g. during route
            // transitions), which was hiding updates for pages that had
            // just mounted when the event fired. ``'all'`` guarantees the
            // refetch fires regardless of observer state.
            const current = subsRef.current.find((s) => s.schema === sub.schema && s.table === sub.table) ?? sub;
            for (const key of current.queryKeys) {
              queryClient.invalidateQueries({ queryKey: [...key], refetchType: 'all' });
            }
          },
        );
      channel.subscribe();
      return channel;
    });

    // Wire a socket-level close listener so a disconnect (explicit or
    // network-induced) kicks a reconnect. Each effect run installs its
    // own callback reference and removes it on cleanup, so StrictMode's
    // double-invoke doesn't leak.
    const onSocketClose = () => {
      if (cancelled) return;
      // Debounce with a short delay: the close event fires on the same
      // tick the socket closes, and calling connect() synchronously can
      // race with the lib's own state transition into 'disconnected'.
      setTimeout(() => {
        if (cancelled) return;
        try {
          supabase.realtime.connect();
        } catch {
          /* connect() is safe to call when already connected; swallow
           * any race errors thrown during shutdown */
        }
      }, 300);
    };
    const rt = supabase.realtime as unknown as {
      stateChangeCallbacks: { close: Array<(e: unknown) => void> };
    };
    rt.stateChangeCallbacks.close.push(onSocketClose);

    return () => {
      cancelled = true;
      // Remove our close callback — leaving it attached would leak a
      // reference to the outer effect's channel closures across remounts.
      const idx = rt.stateChangeCallbacks.close.indexOf(onSocketClose);
      if (idx >= 0) rt.stateChangeCallbacks.close.splice(idx, 1);
      for (const channel of channels) {
        supabase.removeChannel(channel);
      }
    };
  }, [user, channelName, queryClient]);
}
