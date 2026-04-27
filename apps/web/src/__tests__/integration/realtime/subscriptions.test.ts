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
 * Tables in the publication today (migrations grepped 2026-04-25):
 *   - chefbyte.live_shelf_devices
 *   - chefbyte.scale_pairings
 *   - chefbyte.event_overrides
 *   - chefbyte.livetrack_import_sessions
 *
 * If a new table joins the publication, add it here. If a table is
 * DROPPED from the publication the corresponding test here will time
 * out, which is the desired failure mode.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createTestUser, cleanupUser } from '../../test-helpers';
import { adminClient, SUPABASE_URL, SUPABASE_ANON_KEY } from '../../setup.integration';

/** Wait for a channel to reach SUBSCRIBED status. */
function waitForSubscription(channel: any, timeoutMs = 10_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Subscribe timeout')), timeoutMs);
    channel.subscribe((status: string, err?: Error) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timer);
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
  const timeout = opts.timeoutMs ?? 10_000;

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
  });

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
      channelName: `rt-cdc-shelf-${Date.now()}`,
      schema: 'chefbyte',
      table: 'live_shelf_devices',
      event: 'INSERT',
      filter: `user_id=eq.${userId}`,
      timeoutMs: 15_000,
    });

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

      const payload = await probe.received;
      expect(payload.eventType).toBe('INSERT');
      expect(payload.new.device_id).toBe(inserted!.device_id);
      expect(payload.new.user_id).toBe(userId);
      expect(payload.new.device_name).toBe('Test Shelf');

      // Cleanup
      await adminClient.schema('chefbyte').from('live_shelf_devices').delete().eq('device_id', inserted!.device_id);
    } finally {
      probe.cleanup();
    }
  }, 20_000);

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
      channelName: `rt-cdc-shelf-upd-${Date.now()}`,
      schema: 'chefbyte',
      table: 'live_shelf_devices',
      event: 'UPDATE',
      filter: `user_id=eq.${userId}`,
      timeoutMs: 15_000,
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
  }, 20_000);

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
      channelName: `rt-cdc-pairings-${Date.now()}`,
      schema: 'chefbyte',
      table: 'scale_pairings',
      event: 'INSERT',
      filter: `user_id=eq.${userId}`,
      timeoutMs: 15_000,
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
  }, 20_000);

  // ---------------------------------------------------------------
  // event_overrides — no FK requirements, user-scoped
  // ---------------------------------------------------------------

  it('delivers INSERT events on chefbyte.event_overrides', async () => {
    const userClient = await makeRealtimeClient();
    const probe = captureNextEvent(userClient, {
      channelName: `rt-cdc-overrides-${Date.now()}`,
      schema: 'chefbyte',
      table: 'event_overrides',
      event: 'INSERT',
      filter: `user_id=eq.${userId}`,
      timeoutMs: 15_000,
    });

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

      const payload = await probe.received;
      expect(payload.eventType).toBe('INSERT');
      expect(payload.new.override_id).toBe(inserted!.override_id);
      expect(payload.new.client_event_id).toBe(clientEventId);

      await adminClient.schema('chefbyte').from('event_overrides').delete().eq('override_id', inserted!.override_id);
    } finally {
      probe.cleanup();
    }
  }, 20_000);

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
      channelName: `rt-cdc-lti-${Date.now()}`,
      schema: 'chefbyte',
      table: 'livetrack_import_sessions',
      event: 'INSERT',
      filter: `user_id=eq.${userId}`,
      timeoutMs: 15_000,
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
  }, 20_000);

  // ---------------------------------------------------------------
  // RLS filter — user A cannot receive user B's events
  // ---------------------------------------------------------------

  it('does NOT deliver events for other users (RLS + filter)', async () => {
    const userClient = await makeRealtimeClient();
    const otherUser = await createTestUser('rt-cdc-other');

    try {
      // Subscribe userClient (user A) filtered by their own user_id.
      const channel = userClient.channel(`rt-cdc-rls-${Date.now()}`);
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
      await waitForSubscription(channel, 15_000);

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
      otherUser.client.removeAllChannels();
      await cleanupUser(otherUser.userId);
    }
  }, 20_000);
});
