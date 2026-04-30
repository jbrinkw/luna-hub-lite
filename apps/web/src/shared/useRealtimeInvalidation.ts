import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from './supabase';
import { useAuth } from './auth/AuthProvider';
import { realtimeHealth, type ChannelStatus } from './realtimeHealth';

interface RealtimeSub {
  schema: string;
  table: string;
  filter?: string;
  queryKeys: readonly (readonly unknown[])[];
}

/**
 * Auto-reconnect policy on TIMED_OUT / CHANNEL_ERROR / CLOSED. Exponential
 * backoff: 1s, 3s, 9s. After 3 failed attempts we stop retrying and leave
 * the banner up; user clicks "Reconnect" (or a network-online event) to
 * force a resubscribe.
 */
const RECONNECT_DELAYS_MS = [1_000, 3_000, 9_000];

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
 *
 * **Health detection.** Channel health is driven entirely by the
 * `channel.subscribe((status, err) => ...)` callback, which surfaces
 * `SUBSCRIBED` / `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED` from supabase-js's
 * Phoenix-channel state machine. Terminal errors trigger the
 * exponential auto-reconnect ladder (1s/3s/9s, 3 attempts). The earlier
 * design also ran a 30s broadcast-self heartbeat per channel as a
 * "silent stall" probe, but it sent through `/realtime/v1/api/broadcast`
 * (which requires a fresh JWT and counts toward broadcast quota) and
 * could not actually detect the publication-gap failure mode it was
 * designed for — broadcasts and postgres_changes go through different
 * server paths, so a broken publication leaves the broadcast path
 * working and the heartbeat happy. Once the pgTAP
 * `realtime_publication_completeness` gate started enforcing publication
 * membership at CI time, the heartbeat became net-negative: it could not
 * detect the failure it claimed to and was the source of the post-idle
 * 401 storm in the browser console (heartbeat keeps firing on a dead
 * channel with a stale JWT). Removed in favor of state-machine-driven
 * health.
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
    // Test env: `supabase` is mocked without a `.channel` method. Skip all
    // Realtime wiring entirely so non-Realtime unit tests don't need to
    // stub the whole Realtime surface (channel + realtime + removeChannel).
    if (typeof (supabase as any).channel !== 'function') return;

    // Guard so late async callbacks (onClose reconnect, timers) don't fire
    // after this effect's cleanup.
    let cancelled = false;

    // Map key = `${channelName}:${schema}.${table}`; value = per-channel runtime.
    type ChannelRuntime = {
      key: string;
      sub: RealtimeSub;
      channel: ReturnType<typeof supabase.channel>;
      reconnectAttempt: number;
      reconnectTimer?: ReturnType<typeof setTimeout>;
    };

    const runtimes = new Map<string, ChannelRuntime>();

    const buildChannel = (sub: RealtimeSub): ChannelRuntime => {
      const perTableName = `${channelName}:${sub.schema}.${sub.table}`;

      const channel = supabase.channel(perTableName);

      const rt: ChannelRuntime = {
        key: perTableName,
        sub,
        channel,
        reconnectAttempt: 0,
      };

      channel.on(
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
          // refetch: the default `refetchType: 'active'` silently skips
          // queries whose observers aren't settled yet (e.g. during route
          // transitions), which was hiding updates for pages that had
          // just mounted when the event fired. `'all'` guarantees the
          // refetch fires regardless of observer state.
          const current = subsRef.current.find((s) => s.schema === sub.schema && s.table === sub.table) ?? sub;
          for (const key of current.queryKeys) {
            queryClient.invalidateQueries({ queryKey: [...key], refetchType: 'all' });
          }
        },
      );

      realtimeHealth.register(perTableName, () => forceReconnect(rt));

      channel.subscribe((status, err) => {
        if (cancelled) return;
        // Supabase-js emits statuses as the strings we track directly.
        realtimeHealth.setStatus(perTableName, status as ChannelStatus, err?.message);

        if (status === 'SUBSCRIBED') {
          rt.reconnectAttempt = 0;
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          scheduleReconnect(rt);
        }
      });

      return rt;
    };

    const scheduleReconnect = (rt: ChannelRuntime) => {
      if (cancelled) return;
      if (rt.reconnectAttempt >= RECONNECT_DELAYS_MS.length) return;
      const delay = RECONNECT_DELAYS_MS[rt.reconnectAttempt];
      rt.reconnectAttempt += 1;
      if (rt.reconnectTimer) clearTimeout(rt.reconnectTimer);
      rt.reconnectTimer = setTimeout(() => {
        if (cancelled) return;
        forceReconnect(rt);
      }, delay);
    };

    const forceReconnect = (rt: ChannelRuntime) => {
      if (cancelled) return;
      // unsubscribe() returns a Promise in recent supabase-js — we don't
      // await it because the hook needs to build a fresh channel on the
      // same effect tick, and unsubscribe() ignores stale errors gracefully.
      try {
        rt.channel.unsubscribe();
        // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: channel.unsubscribe() throws when channel is already in a terminal state — best-effort cleanup
      } catch {}
      if (rt.reconnectTimer) clearTimeout(rt.reconnectTimer);
      supabase.removeChannel(rt.channel);

      const fresh = buildChannel(rt.sub);
      fresh.reconnectAttempt = rt.reconnectAttempt;
      runtimes.set(rt.key, fresh);
    };

    // One channel per subscription — see docblock above for why we don't
    // multiplex.
    for (const sub of subsRef.current) {
      const rt = buildChannel(sub);
      runtimes.set(rt.key, rt);
    }

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
          // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: connect() throws when already connected or during shutdown races — safe to swallow per Supabase realtime-js docs
        } catch {}
      }, 300);
    };
    // Private API access: `RealtimeClient.stateChangeCallbacks.close` is an
    // undocumented internal of `@supabase/realtime-js`. There's no public
    // socket-close hook on `RealtimeClient` (no `onClose()` method exists as
    // of supabase-js current). If supabase renames or removes this in any
    // patch/minor release, the assignment would silently no-op and the
    // reconnect-on-close handler would never fire. Guard with a runtime
    // shape check + loud `console.error` so we get a fingerprint instead of
    // a silent regression. The companion canary test
    // `apps/web/src/__tests__/unit/shared/realtime-private-api-canary.test.ts`
    // pins the property shape so we catch breaks at CI time on dependency
    // bump, before they ship.
    type RealtimeWithCallbacks = {
      stateChangeCallbacks?: {
        close?: Array<(e: unknown) => void>;
      };
    };
    const rt = supabase.realtime as unknown as RealtimeWithCallbacks;
    const closeCallbacks = rt?.stateChangeCallbacks?.close;
    if (Array.isArray(closeCallbacks)) {
      closeCallbacks.push(onSocketClose);
    } else {
      console.error(
        '[useRealtimeInvalidation] supabase.realtime.stateChangeCallbacks.close is not an array — ' +
          'the private API shape changed. Reconnect-on-close handler not registered. ' +
          'Update useRealtimeInvalidation to use a supported event API.',
      );
    }

    return () => {
      cancelled = true;
      if (Array.isArray(closeCallbacks)) {
        const idx = closeCallbacks.indexOf(onSocketClose);
        if (idx >= 0) closeCallbacks.splice(idx, 1);
      }
      for (const runtime of runtimes.values()) {
        if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
        realtimeHealth.unregister(runtime.key);
        supabase.removeChannel(runtime.channel);
      }
      runtimes.clear();
    };
  }, [user, channelName, queryClient]);
}
