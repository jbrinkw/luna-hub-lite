/**
 * Realtime Invalidation Harness — Integration Tests
 *
 * Verifies the full-stack invalidation contract:
 *   Postgres row change → Realtime WS event → queryClient.invalidateQueries
 *
 * This is the class of bug the unit tests (which stub supabase.channel)
 * cannot catch: "subscription registered but never delivers because the
 * table isn't in the supabase_realtime publication."
 *
 * Approach: we wire the same invalidation logic that useRealtimeInvalidation
 * uses in production (subscribe to postgres_changes on a real WS, call
 * queryClient.invalidateQueries in the callback) using a live subscriber
 * client. A separate "writer" client (service_role) fires the mutation.
 * We then assert that queryClient.getQueryState(key).isInvalidated === true.
 *
 * Why not render the hook directly:
 *   The integration vitest config uses environment: 'node'. Rendering
 *   React hooks requires jsdom + the @testing-library/react transform.
 *   Rather than duplicate the hook's test surface (already covered by
 *   the unit suite), we test the OBSERVABLE CONTRACT — "real Supabase
 *   postgres_changes events reach the JS callback layer and the cache
 *   is invalidated" — without DOM machinery.
 *
 * Test matrix (5 cases, named A–E):
 *   A. INSERT on stock_lots → cache key invalidated
 *   B. UPDATE on stock_lots → cache key invalidated
 *   C. Client DELETE on stock_lots → cache key invalidated.
 *      Post-G1 the DELETE is converted to a soft-delete UPDATE by the
 *      stock_lots_no_hard_delete trigger; the test subscribes with
 *      event: '*' so either signal triggers invalidation.
 *   D. Unsubscribe then mutate → cache NOT invalidated (cleanup check)
 *   E. Two subs to same key, one removed → other still invalidates
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { adminClient } from '../../setup.integration';
import { createTestUser, cleanupUser } from '../../test-helpers';

// ─── Config ───────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;

/**
 * How long to wait for a queryClient invalidation after a mutation.
 * Realtime event round-trip on local stack: typically <500ms.
 * Budget 10s to tolerate CPU saturation under pnpm verify:full.
 */
const INVALIDATION_TIMEOUT_MS = 10_000;

/**
 * Post-SUBSCRIBED settle delay. The WAL capture position is committed
 * slightly after the phx_join reply; mutations fired in the same
 * microtask can race ahead of it. 150ms is consistent with the
 * companion subscriptions.test.ts value.
 */
const SETTLE_MS = 150;

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

/**
 * Poll until queryClient.getQueryState(key).isInvalidated is true.
 */
function waitForInvalidation(queryClient: QueryClient, key: unknown[], timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function poll() {
      const state = queryClient.getQueryState(key);
      if (state?.isInvalidated) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        const s = queryClient.getQueryState(key);
        reject(
          new Error(
            `Key ${JSON.stringify(key)} not invalidated within ${timeoutMs}ms. ` +
              `state=${JSON.stringify({ isInvalidated: s?.isInvalidated, status: s?.status })}`,
          ),
        );
        return;
      }
      setTimeout(poll, 50);
    }
    poll();
  });
}

/**
 * Subscribe a raw channel and wait for SUBSCRIBED status + settle delay.
 */
function waitForSubscribed(channel: ReturnType<SupabaseClient['channel']>, timeoutMs = 25_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subscribe timeout')), timeoutMs);
    channel.subscribe(async (status: string, err?: Error) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        resolve();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        clearTimeout(timer);
        reject(err ?? new Error(`channel ${status}`));
      }
    });
  });
}

/**
 * Wire a postgres_changes subscription that calls queryClient.invalidateQueries
 * on every event — exactly the contract useRealtimeInvalidation provides.
 *
 * Retries up to 3 times on TIMED_OUT / CHANNEL_ERROR before failing.
 * Supabase Realtime sends TIMED_OUT when the Realtime server's Phoenix
 * channel join times out or when the connection is in a transient state
 * (e.g. right after another channel on the same socket was removed).
 *
 * Returns a cleanup function that removes the channel.
 */
async function subscribeAndInvalidate(opts: {
  client: SupabaseClient;
  channelName: string;
  schema: string;
  table: string;
  filter: string;
  queryClient: QueryClient;
  queryKey: unknown[];
}): Promise<() => void> {
  const maxAttempts = 3;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Use a fresh channel name on each retry — a TIMED_OUT channel may
    // have left stale state on the server side that would cause the same
    // channel name to be rejected again immediately.
    const channelName = attempt === 0 ? opts.channelName : `${opts.channelName}-retry${attempt}`;
    const channel = opts.client.channel(channelName);

    // When filter is empty, omit the key entirely — supabase-js treats
    // an empty string as a malformed filter and may reject the subscription.
    const changesOpts: Record<string, unknown> = {
      event: '*',
      schema: opts.schema,
      table: opts.table,
    };
    if (opts.filter) changesOpts.filter = opts.filter;

    channel.on('postgres_changes', changesOpts as any, () => {
      opts.queryClient.invalidateQueries({ queryKey: opts.queryKey, refetchType: 'all' });
    });

    try {
      await waitForSubscribed(channel, 25_000);
      return () => {
        opts.client.removeChannel(channel);
      };
    } catch (err: any) {
      opts.client.removeChannel(channel);
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        // Back off briefly before retry — gives Realtime server time to
        // recover from a transient TIMED_OUT / CHANNEL_ERROR state.
        await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
      }
    }
  }

  throw lastErr ?? new Error('subscribeAndInvalidate: all attempts failed');
}

// ─── Suite ────────────────────────────────────────────────────────────────

describe('Realtime invalidation harness — postgres_changes → QueryClient.invalidateQueries', () => {
  let userId: string;
  let userEmail: string;
  let userPassword: string;
  let subscriberClient: SupabaseClient;
  let productId: string;
  let locationId: string;

  const insertedLotIds: string[] = [];

  beforeAll(async () => {
    const user = await createTestUser('rt-inv');
    userId = user.userId;
    userEmail = user.email;
    userPassword = 'test-password-123';

    // Subscriber client: authenticated so RLS filter delivers events.
    subscriberClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: { params: { eventsPerSecond: 10 } },
    });
    await subscriberClient.auth.signInWithPassword({ email: userEmail, password: userPassword });

    // Activate chefbyte so locations are seeded.
    await (user.client as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });

    // Product for stock_lots FK.
    const { data: prod, error: prodErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'RT Inv Harness Product',
        servings_per_container: 4,
        calories_per_serving: 100,
        carbs_per_serving: 10,
        protein_per_serving: 5,
        fat_per_serving: 2,
      })
      .select('product_id')
      .single();
    if (prodErr) throw new Error(`seed product: ${prodErr.message}`);
    productId = prod.product_id;

    // Location: activate_app already seeded some.
    const { data: loc, error: locErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('locations')
      .select('location_id')
      .eq('user_id', userId)
      .limit(1)
      .single();
    if (locErr) throw new Error(`find location: ${locErr.message}`);
    locationId = loc.location_id;

    // Pre-warm the Realtime stack with exponential backoff retries.
    // Same pattern as subscriptions.test.ts: the first WS handshake can
    // take >15s on a cold local Supabase (container restart / migrations).
    // We retry up to 5 times so the cold-start cost is paid in beforeAll,
    // not inside per-test timeouts.
    const backoffMs = [1000, 2000, 4000, 8000, 16000];
    let lastWarmErr: Error | null = null;
    for (let attempt = 0; attempt < backoffMs.length; attempt++) {
      const warmChannel = subscriberClient.channel(`rt-inv-warm-${crypto.randomUUID()}`);
      warmChannel.on(
        'postgres_changes',
        { event: 'INSERT', schema: 'chefbyte', table: 'stock_lots', filter: `user_id=eq.${userId}` },
        () => {},
      );
      try {
        await waitForSubscribed(warmChannel, 20_000);
        subscriberClient.removeChannel(warmChannel);
        lastWarmErr = null;
        break;
      } catch (err: any) {
        subscriberClient.removeChannel(warmChannel);
        lastWarmErr = err;
        try {
          (subscriberClient as any).realtime?.disconnect?.();
          // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: Supabase realtime disconnect throws on concurrent shutdown — best-effort
        } catch {}
        if (attempt < backoffMs.length - 1) {
          await new Promise((r) => setTimeout(r, backoffMs[attempt]));
        }
      }
    }
    if (lastWarmErr) {
      throw new Error(`Realtime pre-warm failed: ${lastWarmErr.message}`);
    }
  }, 180_000);

  afterEach(async () => {
    if (insertedLotIds.length > 0) {
      await (adminClient as any).schema('chefbyte').from('stock_lots').delete().in('lot_id', insertedLotIds);
      insertedLotIds.length = 0;
    }
  });

  afterAll(async () => {
    subscriberClient.removeAllChannels();
    try {
      (subscriberClient as any).realtime?.disconnect?.();
      // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: Supabase realtime disconnect throws on concurrent shutdown in afterAll — best-effort
    } catch {}
    if (productId) {
      await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', productId);
    }
    if (userId) await cleanupUser(userId);
  });

  // ─── Case A: INSERT → cache key invalidated ─────────────────────────

  it('A: INSERT into chefbyte.stock_lots invalidates the query key', async () => {
    const queryClient = makeQueryClient();
    const queryKey = ['stockLots', userId, 'insert'];

    // Seed the cache so getQueryState is defined.
    queryClient.setQueryData(queryKey, []);

    const cleanup = await subscribeAndInvalidate({
      client: subscriberClient,
      channelName: `rt-inv-insert-${crypto.randomUUID()}`,
      schema: 'chefbyte',
      table: 'stock_lots',
      filter: `user_id=eq.${userId}`,
      queryClient,
      queryKey,
    });

    try {
      // Unique expires_on per test avoids the stock_lots_merge_key unique
      // index conflict — the G1 trigger soft-deletes rows on cleanup
      // (qty=0 + deleted_at=now()) but the unique index spans tombstones,
      // so repeated NULL-expires_on inserts under the same product+location
      // collide across tests.
      const { data: inserted, error } = await (adminClient as any)
        .schema('chefbyte')
        .from('stock_lots')
        .insert({
          user_id: userId,
          product_id: productId,
          location_id: locationId,
          qty_containers: 1,
          expires_on: '2099-01-01',
        })
        .select('lot_id')
        .single();
      expect(error).toBeNull();
      insertedLotIds.push(inserted.lot_id);

      await waitForInvalidation(queryClient, queryKey, INVALIDATION_TIMEOUT_MS);
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    } finally {
      cleanup();
    }
  }, 35_000);

  // ─── Case B: UPDATE → cache key invalidated ─────────────────────────

  it('B: UPDATE on chefbyte.stock_lots invalidates the query key', async () => {
    // Unique expires_on per test — see Case A for rationale (G1 soft-delete +
    // merge-key collision across tombstones).
    const { data: seeded, error: seedErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .insert({
        user_id: userId,
        product_id: productId,
        location_id: locationId,
        qty_containers: 2,
        expires_on: '2099-01-02',
      })
      .select('lot_id')
      .single();
    expect(seedErr).toBeNull();
    insertedLotIds.push(seeded.lot_id);

    const queryClient = makeQueryClient();
    const queryKey = ['stockLots', userId, 'update'];
    queryClient.setQueryData(queryKey, []);

    const cleanup = await subscribeAndInvalidate({
      client: subscriberClient,
      channelName: `rt-inv-update-${crypto.randomUUID()}`,
      schema: 'chefbyte',
      table: 'stock_lots',
      filter: `user_id=eq.${userId}`,
      queryClient,
      queryKey,
    });

    try {
      const { error: updErr } = await (adminClient as any)
        .schema('chefbyte')
        .from('stock_lots')
        .update({ qty_containers: 3 })
        .eq('lot_id', seeded.lot_id);
      expect(updErr).toBeNull();

      await waitForInvalidation(queryClient, queryKey, INVALIDATION_TIMEOUT_MS);
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    } finally {
      cleanup();
    }
  }, 35_000);

  // ─── Case C: DELETE → cache key invalidated ─────────────────────────
  //
  // NOTE: DELETE events with a user_id= filter require REPLICA IDENTITY FULL
  // on the table (so Realtime can evaluate the filter on the deleted row).
  // chefbyte.stock_lots uses DEFAULT replica identity (PK-only), which means
  // filtered DELETE postgres_changes events are not delivered. This matches
  // production behavior — the useRealtimeInvalidation hook's DELETE path is
  // effectively a no-op for these tables until REPLICA IDENTITY FULL is set.
  //
  // To still verify that DELETE CDC events reach the JS layer and trigger
  // cache invalidation, we subscribe WITHOUT a user_id filter. The admin
  // client deletes a stock_lots row (default PK-only replica identity is
  // sufficient for unfiltered DELETE subscriptions). This probes the
  // "DELETE event → invalidateQueries" path end-to-end.

  // ─── Case C: DELETE → cache key invalidated (post-G1 = soft-delete UPDATE)
  //
  // POST-G1 NOTE (stock_lots_no_hard_delete migration, 2026-05-15): the
  // BEFORE-DELETE trigger on chefbyte.stock_lots converts every DELETE
  // into an UPDATE (qty=0 + deleted_at=now()) so the Pi's snapshot poller
  // sees a tombstone via the updated_at bump. As a result, a `.delete()`
  // call no longer emits a postgres_changes DELETE event — it emits an
  // UPDATE event. We subscribe with `event: '*'` (the default in
  // subscribeAndInvalidate) so either signal triggers invalidation. The
  // intent of this test is "DELETE-by-user → cache invalidated," which
  // still holds end-to-end.
  it('C: client-issued DELETE on chefbyte.stock_lots invalidates the query key', async () => {
    // Unique expires_on per test — see Case A.
    const { data: seeded, error: seedErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .insert({
        user_id: userId,
        product_id: productId,
        location_id: locationId,
        qty_containers: 1,
        expires_on: '2099-01-03',
      })
      .select('lot_id')
      .single();
    expect(seedErr).toBeNull();
    // Test soft-deletes this row itself via the trigger; cleanup is best-effort.
    insertedLotIds.push(seeded.lot_id);

    const queryClient = makeQueryClient();
    const queryKey = ['stockLots', userId, 'delete'];
    queryClient.setQueryData(queryKey, []);

    // No filter: kept from the original test for parity. With the G1
    // trigger the event arrives as UPDATE rather than DELETE, but
    // `event: '*'` catches both.
    const cleanup = await subscribeAndInvalidate({
      client: subscriberClient,
      channelName: `rt-inv-delete-${crypto.randomUUID()}`,
      schema: 'chefbyte',
      table: 'stock_lots',
      filter: '', // empty string = no filter (see subscribeAndInvalidate)
      queryClient,
      queryKey,
    });

    try {
      const { error: delErr } = await (adminClient as any)
        .schema('chefbyte')
        .from('stock_lots')
        .delete()
        .eq('lot_id', seeded.lot_id);
      expect(delErr).toBeNull();

      await waitForInvalidation(queryClient, queryKey, INVALIDATION_TIMEOUT_MS);
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    } finally {
      cleanup();
    }
  }, 35_000);

  // ─── Case D: unsubscribe → no invalidation after mutation ───────────

  it('D: after unsubscribing, a mutation does NOT invalidate the cache key', async () => {
    const queryClient = makeQueryClient();
    const queryKey = ['stockLots', userId, 'cleanup'];
    queryClient.setQueryData(queryKey, []);

    const cleanup = await subscribeAndInvalidate({
      client: subscriberClient,
      channelName: `rt-inv-cleanup-${crypto.randomUUID()}`,
      schema: 'chefbyte',
      table: 'stock_lots',
      filter: `user_id=eq.${userId}`,
      queryClient,
      queryKey,
    });

    // Unsubscribe BEFORE the mutation.
    cleanup();
    await new Promise((r) => setTimeout(r, 300)); // allow ACK to settle

    // Unique expires_on per test — see Case A.
    const { data: inserted, error: insertErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .insert({
        user_id: userId,
        product_id: productId,
        location_id: locationId,
        qty_containers: 1,
        expires_on: '2099-01-04',
      })
      .select('lot_id')
      .single();
    expect(insertErr).toBeNull();
    insertedLotIds.push(inserted.lot_id);

    // Wait 2s — a live channel would have delivered the event well within this.
    await new Promise((r) => setTimeout(r, 2_000));

    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBeFalsy();
  }, 15_000);

  // ─── Case E: two subs same key, first removed, second still delivers ─

  it('E: removing one of two subscriptions — the remaining one still invalidates', async () => {
    const queryClient = makeQueryClient();
    const queryKey = ['stockLots', userId, 'dual'];
    queryClient.setQueryData(queryKey, []);

    // Open first subscription.
    const cleanup1 = await subscribeAndInvalidate({
      client: subscriberClient,
      channelName: `rt-inv-dual-1-${crypto.randomUUID()}`,
      schema: 'chefbyte',
      table: 'stock_lots',
      filter: `user_id=eq.${userId}`,
      queryClient,
      queryKey,
    });

    // Open second subscription to the same query key.
    const cleanup2 = await subscribeAndInvalidate({
      client: subscriberClient,
      channelName: `rt-inv-dual-2-${crypto.randomUUID()}`,
      schema: 'chefbyte',
      table: 'stock_lots',
      filter: `user_id=eq.${userId}`,
      queryClient,
      queryKey,
    });

    // Remove the first subscription.
    cleanup1();
    await new Promise((r) => setTimeout(r, 300));

    // Reset cache state so we can detect a fresh invalidation.
    queryClient.setQueryData(queryKey, []);
    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBeFalsy();

    try {
      // Unique expires_on per test — see Case A.
      const { data: inserted, error: insertErr } = await (adminClient as any)
        .schema('chefbyte')
        .from('stock_lots')
        .insert({
          user_id: userId,
          product_id: productId,
          location_id: locationId,
          qty_containers: 1,
          expires_on: '2099-01-05',
        })
        .select('lot_id')
        .single();
      expect(insertErr).toBeNull();
      insertedLotIds.push(inserted.lot_id);

      // Second subscription must still deliver the invalidation.
      await waitForInvalidation(queryClient, queryKey, INVALIDATION_TIMEOUT_MS);
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    } finally {
      cleanup2();
    }
  }, 35_000);
});
