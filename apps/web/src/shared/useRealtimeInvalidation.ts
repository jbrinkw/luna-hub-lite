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
 * Heartbeat cadence. Every `HEARTBEAT_MS` the hook emits a broadcast-self
 * ping on each channel and expects the same channel to deliver it back.
 * Three consecutive misses flips the channel to `degraded` in the health
 * store. 30s is chosen to balance (a) how quickly a silent-death banner
 * surfaces (~90s worst-case) against (b) the number of WS frames we send
 * when idle. Broadcast is free — no Postgres write — so we can afford this.
 *
 * NOTE: this is in MILLIS; unit tests fake-time through it via
 * `vi.useFakeTimers()` and advance in increments of this constant.
 */
export const HEARTBEAT_MS = 30_000;

/**
 * Auto-reconnect policy on TIMED_OUT / CHANNEL_ERROR / CLOSED. Exponential
 * backoff: 1s, 3s, 9s. After 3 failed attempts we stop retrying and leave
 * the banner up; user clicks "Reconnect" (or a network-online event) to
 * force a resubscribe.
 */
const RECONNECT_DELAYS_MS = [1_000, 3_000, 9_000];

interface HeartbeatState {
  // How many consecutive heartbeat pings went unanswered. Reset on every echo.
  missed: number;
  // Latest nonce we sent — used to ignore stale echoes from a prior cycle.
  nonce: number;
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
 *
 * **Silent-death detection.** Even with the socket-close hook above, a
 * broken publication or a dropped subscription can leave the socket
 * *open* while no postgres_changes events are ever delivered. We wire
 * three complementary signals into the `realtimeHealth` store:
 *
 *   1. Status from `channel.subscribe((status, err) => ...)`.
 *   2. Broadcast-echo heartbeat (every HEARTBEAT_MS) — validates the WS
 *      path without a Postgres write. `config.broadcast.self = true` is
 *      set so the channel delivers our own broadcast back to us.
 *   3. Exponential auto-reconnect on CHANNEL_ERROR / TIMED_OUT / CLOSED.
 *
 * Consumers don't need to opt in — just calling the hook as before wires
 * all of this up. `AppProvider` reads `realtimeHealth.isAnyDegraded()` and
 * shows a banner in `OfflineIndicator` when any tracked channel is down.
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
      heartbeat: HeartbeatState;
      heartbeatTimer?: ReturnType<typeof setInterval>;
      reconnectAttempt: number;
      reconnectTimer?: ReturnType<typeof setTimeout>;
    };

    const runtimes = new Map<string, ChannelRuntime>();

    const buildChannel = (sub: RealtimeSub): ChannelRuntime => {
      const perTableName = `${channelName}:${sub.schema}.${sub.table}`;

      // broadcast.self = true means our own broadcast is echoed back to us,
      // which is what we want for the heartbeat probe.
      const channel = supabase.channel(perTableName, {
        config: { broadcast: { self: true } },
      });

      const heartbeat: HeartbeatState = { missed: 0, nonce: 0 };

      const rt: ChannelRuntime = {
        key: perTableName,
        sub,
        channel,
        heartbeat,
        reconnectAttempt: 0,
      };

      channel
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
            // refetch: the default `refetchType: 'active'` silently skips
            // queries whose observers aren't settled yet (e.g. during route
            // transitions), which was hiding updates for pages that had
            // just mounted when the event fired. `'all'` guarantees the
            // refetch fires regardless of observer state.
            const current = subsRef.current.find((s) => s.schema === sub.schema && s.table === sub.table) ?? sub;
            for (const key of current.queryKeys) {
              queryClient.invalidateQueries({ queryKey: [...key], refetchType: 'all' });
            }
            // A real postgres_changes event is also implicit proof that the
            // channel is alive — reset the heartbeat counter.
            realtimeHealth.markHeartbeatEcho(perTableName);
          },
        )
        .on('broadcast', { event: 'rt-heartbeat' }, (payload: { payload?: { nonce?: number } }) => {
          // Accept only echoes from the most recent heartbeat nonce — stale
          // echoes (from a previous subscribe cycle) must not mask a newly
          // broken channel.
          if (payload?.payload?.nonce === heartbeat.nonce) {
            heartbeat.missed = 0;
            realtimeHealth.markHeartbeatEcho(perTableName);
          }
        });

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

      rt.heartbeatTimer = setInterval(() => {
        if (cancelled) return;
        heartbeat.nonce += 1;
        heartbeat.missed += 1;
        realtimeHealth.markHeartbeatSent(perTableName);
        channel
          .send({
            type: 'broadcast',
            event: 'rt-heartbeat',
            payload: { nonce: heartbeat.nonce, at: Date.now() },
          })
          .catch(() => {
            /* send() rejects when the channel is in an error state — the
             * missed counter already ticked, so the health store picks it
             * up. Nothing to do here. */
          });
      }, HEARTBEAT_MS);

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
      if (rt.heartbeatTimer) clearInterval(rt.heartbeatTimer);
      if (rt.reconnectTimer) clearTimeout(rt.reconnectTimer);
      supabase.removeChannel(rt.channel);

      const fresh = buildChannel(rt.sub);
      fresh.reconnectAttempt = rt.reconnectAttempt;
      runtimes.set(rt.key, fresh);
    };

    // One channel per subscription — see docblock above for why we don't
    // multiplex.
    /* eslint-disable react-hooks/immutability -- runtimes Map is local to this effect */
    for (const sub of subsRef.current) {
      const rt = buildChannel(sub);
      runtimes.set(rt.key, rt);
    }
    /* eslint-enable react-hooks/immutability */

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
        if (runtime.heartbeatTimer) clearInterval(runtime.heartbeatTimer);
        if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
        realtimeHealth.unregister(runtime.key);
        supabase.removeChannel(runtime.channel);
      }
      runtimes.clear();
    };
  }, [user, channelName, queryClient]);
}
