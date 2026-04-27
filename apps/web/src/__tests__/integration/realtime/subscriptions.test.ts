/**
 * Supabase Realtime Integration Tests
 *
 * Rewritten 2026-04-25 per the legacy-test-fidelity audit §2.5 — the
 * prior file deliberately skipped postgres_changes coverage ("CDC
 * extension doesn't reliably deliver events for non-public schemas in
 * the local Supabase setup") and only covered broadcast + presence,
 * which the production app does not use for user data.
 *
 * The gap that cost us: commit 9011487 added live_shelf_devices and
 * scale_pairings to `supabase_realtime` — a regression that DROPPED
 * those tables from the publication was caught only by Playwright
 * specs. This test now runs the same probe pattern at integration
 * tier so the regression surfaces in a cheaper, faster layer.
 *
 * Every user-scoped table the UI subscribes to via
 * `useRealtimeInvalidation` that is ALSO in the `supabase_realtime`
 * publication gets a round-trip assertion here:
 *
 *   1. Subscribe with an authenticated supabase-js client.
 *   2. Insert / update / delete a row via adminClient (service_role).
 *   3. Assert the event payload is delivered to the subscriber within
 *      a reasonable timeout.
 *
 * Tables in the publication today (migrations grepped 2026-04-27):
 *   - chefbyte.live_shelf_devices
 *   - chefbyte.scale_pairings
 *   - chefbyte.event_overrides
 *   - chefbyte.livetrack_import_sessions
 *   - chefbyte.food_logs    (added 20260427070000 — MacroPage realtime)
 *   - chefbyte.temp_items   (added 20260427070000 — MacroPage realtime)
 *
 * If a new table joins the publication, add it here. If a table is
 * DROPPED from the publication the corresponding test here will time
 * out, which is the desired failure mode.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createTestUser, cleanupUser } from '../../test-helpers';
import { adminClient, SUPABASE_URL, SUPABASE_ANON_KEY } from '../../setup.integration';

/**
 * Wait for a channel to reach SUBSCRIBED status, then yield the event
 * loop briefly so the realtime server has a chance to commit the
 * subscription registration.
 *
 * Why the post-SUBSCRIBED settle delay: SUBSCRIBED fires when the
 * `phx_join` ok-reply lands, but the WAL position the realtime server
 * uses for delivery is captured slightly after the reply. Insert events
 * fired in the same microtask as the SUBSCRIBED resolve can race ahead
 * of that capture and never deliver. A 100ms yield is well below the
 * insert-to-delivery latency budget (typically <1s on the local stack)
 * and large enough to absorb scheduler jitter under verify:full load
 * (vitest unit suite running in adjacent steps drives ~100% CPU).
 *
 * Why the bumped per-test timeoutMs (30s, callers): the FIRST realtime
 * subscription per fresh client requires a full websocket handshake +
 * `phx_join` reply, which can take >15s under verify:full load when the
 * preceding step (vitest unit suite) saturated CPU. Subsequent
 * subscriptions on the same client warm up the socket and complete in
 * <500ms. 30s is a defensible upper bound (3-5x slow handshake) without
 * masking a genuinely-broken realtime stack — the e2e harness's similar
 * checks complete in <2s on warm stacks.
 *
 * The flake this guards against: chefbyte.event_overrides /
 * live_shelf_devices intermittently times out at 15s under load. Local
 * repro is rare in isolation but surfaces inside `pnpm verify:full`
 * step 5 after step 4 saturates the machine. Caught it on a verify:full
 * dry-run 2026-04-27 (commit 34895f0~..) — first INSERT timed out at
 * 15.178s; the four subsequent tests each completed in <300ms.
 */
function waitForSubscription(channel: any, timeoutMs = 30_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Subscribe timeout')), timeoutMs);
    channel.subscribe(async (status: string, err?: Error) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timer);
        // Settle delay — see fn-level comment.
        await new Promise((r) => setTimeout(r, 100));
        resolve(status);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        clearTimeout(timer);
        reject(err ?? new Error(`subscribe returned ${status}`));
      }
    });
  });
}

/**
 * Subscribe to a postgres_changes channel and return a promise that
 * resolves with the first matching payload.
 */
function captureNextEvent(
  client: any,
  opts: {
    channelName: string;
    schema: string;
    table: string;
    event?: 'INSERT' | 'UPDATE' | 'DELETE' | '*';
    filter?: string;
    timeoutMs?: number;
    predicate?: (payload: any) => boolean;
  },
): { ready: Promise<void>; received: Promise<any>; cleanup: () => void } {
  const channel = client.channel(opts.channelName);
  const timeout = opts.timeoutMs ?? 30_000;

  const received = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`event timeout: ${opts.schema}.${opts.table}`)), timeout);
    channel.on(
      'postgres_changes',
      {
        event: opts.event ?? '*',
        schema: opts.schema,
        table: opts.table,
        ...(opts.filter ? { filter: opts.filter } : {}),
      },
      (payload: any) => {
        if (opts.predicate && !opts.predicate(payload)) return;
        clearTimeout(timer);
        resolve(payload);
      },
    );
  });

  const ready = waitForSubscription(channel, timeout);

  return {
    ready: ready.then(() => undefined),
    received,
    cleanup: () => {
      client.removeChannel(channel);
    },
  };
}

describe('Realtime Subscriptions — postgres_changes CDC', () => {
  let userId: string;
  let userEmail: string;
  let userPassword: string;

  // Each test creates a fresh client on a fresh WebSocket. Reusing a
  // single client across many rapid subscribe-unsubscribe cycles in
  // supabase-js 2.98 is flaky — the socket caches per-channel state and
  // a prior TIMED_OUT can poison the next subscribe. Fresh clients
  // avoid that entirely at the cost of ~100ms handshake per test.
  let activeClients: ReturnType<typeof createClient>[] = [];

  async function makeRealtimeClient() {
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: { params: { eventsPerSecond: 10 } },
    });
    // Sign in so RLS-filtered subscriptions deliver events.
    await client.auth.signInWithPassword({ email: userEmail, password: userPassword });
    activeClients.push(client);
    return client;
  }

  beforeAll(async () => {
    const user = await createTestUser('rt-cdc');
    userId = user.userId;
    userEmail = user.email;
    userPassword = 'test-password-123';

    // Pre-warm the realtime server. The very first websocket connection
    // to a cold Supabase realtime stack (Phoenix + Elixir + Postgres
    // replication slot allocation) can take >30s under verify:full load
    // because step 4 (`pnpm test`) saturates CPU and the realtime server
    // hasn't had to open any postgres_changes binding yet. Subsequent
    // connections reuse the pool and complete in <500ms.
    //
    // Pre-warming here pays the cold-start cost upfront in beforeAll so
    // the first per-test subscribe doesn't blow its 30s probe timeout.
    //
    // Retry tolerance: a `supabase db reset` immediately before
    // verify:full triggers a realtime container restart + tenant
    // migrations. During that window:
    //   * /api/ping returns 200 (the HTTP plug is up)
    //   * websocket /socket fails with CHANNEL_ERROR (tenants_loader
    //     can't query the still-migrating realtime schema)
    //
    // The window is 5-15s typical, occasionally up to 60s when the host
    // is also running step 4 of verify:full. Five retries with
    // exponential backoff (1, 2, 4, 8, 16s = 31s total backoff) covers
    // the window without masking a permanently-broken stack.
    const warmClient = user.client;
    let lastErr: Error | null = null;
    const backoffMs = [1000, 2000, 4000, 8000, 16000];
    for (let attempt = 0; attempt < backoffMs.length; attempt++) {
      const warmChannel = warmClient.channel(`rt-warmup-${crypto.randomUUID()}`);
      warmChannel.on(
        'postgres_changes',
        { event: 'INSERT', schema: 'chefbyte', table: 'live_shelf_devices', filter: `user_id=eq.${userId}` },
        () => {
          /* discard — we just want the binding registered */
        },
      );
      try {
        await waitForSubscription(warmChannel, 20_000);
        warmClient.removeChannel(warmChannel);
        lastErr = null;
        break;
      } catch (err: any) {
        warmClient.removeChannel(warmChannel);
        lastErr = err;
        // Force-disconnect so the next attempt opens a fresh socket
        // (otherwise supabase-js will reuse the dead one).
        try {
          (warmClient as any).realtime?.disconnect?.();
        } catch {
          /* ignore */
        }
        if (attempt < backoffMs.length - 1) {
          await new Promise((r) => setTimeout(r, backoffMs[attempt]));
        }
      }
    }
    if (lastErr) {
      throw new Error(`realtime pre-warm failed after ${backoffMs.length} attempts: ${lastErr.message}`);
    }
  }, 180_000);

  afterEach(async () => {
    for (const c of activeClients) {
      c.removeAllChannels();
      try {
        c.realtime.disconnect();
      } catch {
        /* ignore */
      }
    }
    activeClients = [];
  });

  afterAll(async () => {
    if (userId) await cleanupUser(userId);
  });

  // ---------------------------------------------------------------
  // live_shelf_devices — primary regression target
  // ---------------------------------------------------------------

  it('delivers INSERT events on chefbyte.live_shelf_devices', async () => {
    const userClient = await makeRealtimeClient();
    const probe = captureNextEvent(userClient, {
      channelName: `rt-cdc-shelf-${crypto.randomUUID()}`,
      schema: 'chefbyte',
      table: 'live_shelf_devices',
      event: 'INSERT',
      filter: `user_id=eq.${userId}`,
      timeoutMs: 30_000,
    });

    let insertedDeviceId: string | null = null;
    try {
      await probe.ready;

      const { data: inserted, error } = await adminClient
        .schema('chefbyte')
        .from('live_shelf_devices')
        .insert({
          user_id: userId,
          device_name: 'Test Shelf',
          import_key_hash: `hash_${crypto.randomUUID()}`,
        })
        .select('device_id, device_name')
        .single();
      expect(error).toBeNull();
      insertedDeviceId = inserted!.device_id;

      const payload = await probe.received;
      expect(payload.eventType).toBe('INSERT');
      expect(payload.new.device_id).toBe(inserted!.device_id);
      expect(payload.new.user_id).toBe(userId);
      expect(payload.new.device_name).toBe('Test Shelf');
    } finally {
      probe.cleanup();
      // Delete the seeded row even if the assertion above failed, so a
      // flake doesn't leave WAL noise the next run has to wade through.
      if (insertedDeviceId) {
        await adminClient.schema('chefbyte').from('live_shelf_devices').delete().eq('device_id', insertedDeviceId);
      }
    }
  }, 35_000);

  it('delivers UPDATE events on chefbyte.live_shelf_devices', async () => {
    // Seed a row first, then open the probe, then update.
    const { data: seeded } = await adminClient
      .schema('chefbyte')
      .from('live_shelf_devices')
      .insert({
        user_id: userId,
        device_name: 'Update Shelf',
        import_key_hash: `hash_${crypto.randomUUID()}`,
      })
      .select('device_id')
      .single();

    const userClient = await makeRealtimeClient();
    const probe = captureNextEvent(userClient, {
      channelName: `rt-cdc-shelf-upd-${crypto.randomUUID()}`,
      schema: 'chefbyte',
      table: 'live_shelf_devices',
      event: 'UPDATE',
      filter: `user_id=eq.${userId}`,
      timeoutMs: 30_000,
      // Event may fire for other rows — filter to the seeded device.
      predicate: (payload) => payload.new?.device_id === seeded!.device_id,
    });

    try {
      await probe.ready;

      const { error: updErr } = await adminClient
        .schema('chefbyte')
        .from('live_shelf_devices')
        .update({ device_name: 'Renamed Shelf' })
        .eq('device_id', seeded!.device_id);
      expect(updErr).toBeNull();

      const payload = await probe.received;
      expect(payload.eventType).toBe('UPDATE');
      expect(payload.new.device_name).toBe('Renamed Shelf');
    } finally {
      probe.cleanup();
      await adminClient.schema('chefbyte').from('live_shelf_devices').delete().eq('device_id', seeded!.device_id);
    }
  }, 35_000);

  // ---------------------------------------------------------------
  // scale_pairings — pairs to a device row via FK
  // ---------------------------------------------------------------

  it('delivers INSERT events on chefbyte.scale_pairings', async () => {
    // Need a parent live_shelf_device for the FK.
    const { data: device } = await adminClient
      .schema('chefbyte')
      .from('live_shelf_devices')
      .insert({
        user_id: userId,
        device_name: 'Pairings Shelf',
        import_key_hash: `hash_${crypto.randomUUID()}`,
      })
      .select('device_id')
      .single();

    const userClient = await makeRealtimeClient();
    const probe = captureNextEvent(userClient, {
      channelName: `rt-cdc-pairings-${crypto.randomUUID()}`,
      schema: 'chefbyte',
      table: 'scale_pairings',
      event: 'INSERT',
      filter: `user_id=eq.${userId}`,
      timeoutMs: 30_000,
    });

    try {
      await probe.ready;

      const { data: inserted, error } = await adminClient
        .schema('chefbyte')
        .from('scale_pairings')
        .insert({
          user_id: userId,
          device_id: device!.device_id,
          scale_id: 'scale_test_1',
          kind: 'live_scale',
        })
        .select('pairing_id')
        .single();
      expect(error).toBeNull();

      const payload = await probe.received;
      expect(payload.eventType).toBe('INSERT');
      expect(payload.new.pairing_id).toBe(inserted!.pairing_id);
      expect(payload.new.scale_id).toBe('scale_test_1');
    } finally {
      probe.cleanup();
      await adminClient.schema('chefbyte').from('live_shelf_devices').delete().eq('device_id', device!.device_id); // CASCADE deletes pairings
    }
  }, 35_000);

  // ---------------------------------------------------------------
  // event_overrides — no FK requirements, user-scoped
  // ---------------------------------------------------------------

  it('delivers INSERT events on chefbyte.event_overrides', async () => {
    const userClient = await makeRealtimeClient();
    const probe = captureNextEvent(userClient, {
      channelName: `rt-cdc-overrides-${crypto.randomUUID()}`,
      schema: 'chefbyte',
      table: 'event_overrides',
      event: 'INSERT',
      filter: `user_id=eq.${userId}`,
      timeoutMs: 30_000,
    });

    let insertedOverrideId: string | null = null;
    try {
      await probe.ready;

      const clientEventId = `evt_${crypto.randomUUID()}`;
      const { data: inserted, error } = await adminClient
        .schema('chefbyte')
        .from('event_overrides')
        .insert({
          user_id: userId,
          client_event_id: clientEventId,
          is_voided: true,
        })
        .select('override_id')
        .single();
      expect(error).toBeNull();
      insertedOverrideId = inserted!.override_id;

      const payload = await probe.received;
      expect(payload.eventType).toBe('INSERT');
      expect(payload.new.override_id).toBe(inserted!.override_id);
      expect(payload.new.client_event_id).toBe(clientEventId);
    } finally {
      probe.cleanup();
      if (insertedOverrideId) {
        await adminClient.schema('chefbyte').from('event_overrides').delete().eq('override_id', insertedOverrideId);
      }
    }
  }, 35_000);

  // ---------------------------------------------------------------
  // livetrack_import_sessions — needs parent device FK
  // ---------------------------------------------------------------

  it('delivers INSERT events on chefbyte.livetrack_import_sessions', async () => {
    const { data: device } = await adminClient
      .schema('chefbyte')
      .from('live_shelf_devices')
      .insert({
        user_id: userId,
        device_name: 'LiveTrack Shelf',
        import_key_hash: `hash_${crypto.randomUUID()}`,
      })
      .select('device_id')
      .single();

    const userClient = await makeRealtimeClient();
    const probe = captureNextEvent(userClient, {
      channelName: `rt-cdc-lti-${crypto.randomUUID()}`,
      schema: 'chefbyte',
      table: 'livetrack_import_sessions',
      event: 'INSERT',
      filter: `user_id=eq.${userId}`,
      timeoutMs: 30_000,
    });

    try {
      await probe.ready;

      const { data: inserted, error } = await adminClient
        .schema('chefbyte')
        .from('livetrack_import_sessions')
        .insert({
          user_id: userId,
          device_id: device!.device_id,
          state: 'waiting_barcode',
        })
        .select('session_id')
        .single();
      expect(error).toBeNull();

      const payload = await probe.received;
      expect(payload.eventType).toBe('INSERT');
      expect(payload.new.session_id).toBe(inserted!.session_id);
      expect(payload.new.state).toBe('waiting_barcode');
    } finally {
      probe.cleanup();
      await adminClient.schema('chefbyte').from('live_shelf_devices').delete().eq('device_id', device!.device_id);
    }
  }, 35_000);

  // ---------------------------------------------------------------
  // food_logs — MacroPage realtime path
  //
  // Regression target: 2026-04-27 — Pi shelf-event-driven food_logs
  // INSERTs (apply_shelf_event for `consumed`) landed in the cloud DB
  // but the user's MacroPage tab never updated because food_logs
  // wasn't in the realtime publication. Migration
  // 20260427070000_food_logs_realtime_publication.sql added the
  // table; this test fails if a future migration drops it.
  // ---------------------------------------------------------------

  it('delivers INSERT events on chefbyte.food_logs', async () => {
    // food_logs FKs to a chefbyte.products row owned by the user.
    const { data: product, error: productErr } = await adminClient
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Realtime Probe Product',
        servings_per_container: 1,
        calories_per_serving: 100,
        protein_per_serving: 10,
        carbs_per_serving: 15,
        fat_per_serving: 3,
      })
      .select('product_id')
      .single();
    expect(productErr).toBeNull();

    const userClient = await makeRealtimeClient();
    const probe = captureNextEvent(userClient, {
      channelName: `rt-cdc-foodlogs-${crypto.randomUUID()}`,
      schema: 'chefbyte',
      table: 'food_logs',
      event: 'INSERT',
      filter: `user_id=eq.${userId}`,
      timeoutMs: 30_000,
    });

    let insertedLogId: string | null = null;
    try {
      await probe.ready;

      const clientEventId = `food-rt-${crypto.randomUUID()}`;
      const { data: inserted, error } = await adminClient
        .schema('chefbyte')
        .from('food_logs')
        .insert({
          user_id: userId,
          product_id: product!.product_id,
          logical_date: '2026-04-27',
          qty_consumed: 0.5,
          unit: 'serving',
          calories: 50,
          carbs: 7.5,
          protein: 5,
          fat: 1.5,
          source_client_event_id: clientEventId,
        })
        .select('log_id')
        .single();
      expect(error).toBeNull();
      insertedLogId = inserted!.log_id;

      const payload = await probe.received;
      expect(payload.eventType).toBe('INSERT');
      expect(payload.new.log_id).toBe(inserted!.log_id);
      expect(payload.new.user_id).toBe(userId);
      expect(payload.new.product_id).toBe(product!.product_id);
      expect(Number(payload.new.calories)).toBe(50);
    } finally {
      probe.cleanup();
      if (insertedLogId) {
        await adminClient.schema('chefbyte').from('food_logs').delete().eq('log_id', insertedLogId);
      }
      await adminClient.schema('chefbyte').from('products').delete().eq('product_id', product!.product_id);
    }
  }, 35_000);

  // ---------------------------------------------------------------
  // temp_items — MacroPage realtime path (manual quick-add macros)
  // ---------------------------------------------------------------

  it('delivers INSERT events on chefbyte.temp_items', async () => {
    const userClient = await makeRealtimeClient();
    const probe = captureNextEvent(userClient, {
      channelName: `rt-cdc-tempitems-${crypto.randomUUID()}`,
      schema: 'chefbyte',
      table: 'temp_items',
      event: 'INSERT',
      filter: `user_id=eq.${userId}`,
      timeoutMs: 30_000,
    });

    let insertedTempId: string | null = null;
    try {
      await probe.ready;

      const { data: inserted, error } = await adminClient
        .schema('chefbyte')
        .from('temp_items')
        .insert({
          user_id: userId,
          name: 'Realtime Probe Snack',
          logical_date: '2026-04-27',
          calories: 200,
          carbs: 25,
          protein: 8,
          fat: 6,
        })
        .select('temp_id')
        .single();
      expect(error).toBeNull();
      insertedTempId = inserted!.temp_id;

      const payload = await probe.received;
      expect(payload.eventType).toBe('INSERT');
      expect(payload.new.temp_id).toBe(inserted!.temp_id);
      expect(payload.new.name).toBe('Realtime Probe Snack');
      expect(Number(payload.new.calories)).toBe(200);
    } finally {
      probe.cleanup();
      if (insertedTempId) {
        await adminClient.schema('chefbyte').from('temp_items').delete().eq('temp_id', insertedTempId);
      }
    }
  }, 35_000);

  // ---------------------------------------------------------------
  // RLS filter — user A cannot receive user B's events
  // ---------------------------------------------------------------

  it('does NOT deliver events for other users (RLS + filter)', async () => {
    const userClient = await makeRealtimeClient();
    const otherUser = await createTestUser('rt-cdc-other');

    try {
      // Subscribe userClient (user A) filtered by their own user_id.
      const channel = userClient.channel(`rt-cdc-rls-${crypto.randomUUID()}`);
      let deliveredForOther = false;
      channel.on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'chefbyte',
          table: 'live_shelf_devices',
          filter: `user_id=eq.${userId}`,
        },
        (payload: any) => {
          if (payload.new?.user_id === otherUser.userId) {
            deliveredForOther = true;
          }
        },
      );
      await waitForSubscription(channel, 30_000);

      // Insert a row for userB — should NOT arrive on userA's channel.
      const { data: otherDevice } = await adminClient
        .schema('chefbyte')
        .from('live_shelf_devices')
        .insert({
          user_id: otherUser.userId,
          device_name: 'Other User Shelf',
          import_key_hash: `hash_${crypto.randomUUID()}`,
        })
        .select('device_id')
        .single();

      // Wait 2s — if the filter is wrong we'd see it by now.
      await new Promise((r) => setTimeout(r, 2_000));

      expect(deliveredForOther).toBe(false);

      userClient.removeChannel(channel);
      await adminClient.schema('chefbyte').from('live_shelf_devices').delete().eq('device_id', otherDevice!.device_id);
    } finally {
      // otherUser.client may not have an open websocket (no subscribe()
      // was called on it in this test) but defensively close it like the
      // active-clients afterEach does, in case future edits add a probe
      // through it.
      otherUser.client.removeAllChannels();
      try {
        (otherUser.client as any).realtime?.disconnect?.();
      } catch {
        /* ignore */
      }
      await cleanupUser(otherUser.userId);
    }
  }, 35_000);
});
