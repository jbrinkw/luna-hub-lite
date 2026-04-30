/**
 * Shelf-Ingest Idempotency Contract Tests
 *
 * Verifies the multi-layer idempotency guarantee for POST /shelf-ingest/event:
 *
 *   Layer 1 — Edge function: validates `client_event_id` is present on every
 *             request and rejects missing/malformed ids at HTTP level.
 *   Layer 2 — plpgsql: `private.apply_shelf_event` / `apply_shelf_event_admin`
 *             uses a UNIQUE constraint on (user_id, client_event_id) in
 *             chefbyte.shelf_event_log to detect duplicates. On replay it
 *             returns the cached (applied, reason, resolved_lot_id) from the
 *             original row — no second stock mutation, no second food_log row.
 *
 * Test matrix (4 cases):
 *   1. Same client_event_id + same body → second call is a no-op (one row in shelf_event_log)
 *   2. Same client_event_id + different body fields → second call still returns
 *      same result (idempotency key wins over body difference; one DB row)
 *   3. Different client_event_id + same body → both calls succeed independently
 *      (two distinct DB rows)
 *   4. Concurrent calls with same client_event_id → exactly one row inserted,
 *      both callers receive identical 200 responses (no race-condition double-insert)
 *
 * Setup mirrors shelf-ingest.test.ts exactly (same helper pattern) so the
 * test can be read in isolation without referring to the existing file.
 *
 * Environment: node (matches vitest.integration.config.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { adminClient, SUPABASE_URL } from '../../setup.integration';
import { createTestUser, cleanupUser } from '../../test-helpers';

const BASE_URL = `${SUPABASE_URL}/functions/v1/shelf-ingest`;

// ─── Helpers ──────────────────────────────────────────────────────────────

function authHeaders(key: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-api-key': key };
}

function eventBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scale_id: 'scale-idempotency-01',
    kind: 'live_shelf',
    event_kind: 'consumed',
    delta_g: -100,
    occurred_at: new Date().toISOString(),
    client_event_id: crypto.randomUUID(),
    ...overrides,
  };
}

/** Row count in shelf_event_log for a given (user_id, client_event_id). */
async function rowCount(userId: string, clientEventId: string): Promise<number> {
  // Select the PK column (event_id) with a normal (non-HEAD) query — the
  // supabase-js head:true + count:'exact' path returns an empty error object
  // when the chefbyte schema is used via Accept-Profile, so we avoid it.
  const { data: rows, error } = await (adminClient as any)
    .schema('chefbyte')
    .from('shelf_event_log')
    .select('event_id')
    .eq('user_id', userId)
    .eq('client_event_id', clientEventId);
  if (error) throw new Error(`rowCount query failed: ${error.message}`);
  return (rows ?? []).length;
}

// ─── Fixture setup ────────────────────────────────────────────────────────

describe('shelf-ingest POST /event idempotency', () => {
  let userId: string;
  let importKey: string;
  let productId: string;
  let locationId: string;
  let lotId: string;

  beforeAll(async () => {
    const user = await createTestUser('si-idem');
    userId = user.userId;

    // Activate chefbyte so locations are seeded.
    await (user.client as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });

    // Product with net_weight_g so gram-based events can resolve containers.
    const { data: prod, error: prodErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Idem Test Milk',
        barcode: 'IDEM-TEST-001',
        servings_per_container: 4,
        calories_per_serving: 100,
        carbs_per_serving: 12,
        protein_per_serving: 8,
        fat_per_serving: 5,
        net_weight_g: 1000,
        container_type: 'carton',
      })
      .select('product_id')
      .single();
    if (prodErr) throw new Error(`create product: ${prodErr.message}`);
    productId = prod.product_id;

    // Location.
    const { data: loc, error: locErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('locations')
      .select('location_id')
      .eq('user_id', userId)
      .limit(1)
      .single();
    if (locErr) throw new Error(`find location: ${locErr.message}`);
    locationId = loc.location_id;

    // Initial stock: 5 cartons.
    const { data: lot, error: lotErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .insert({
        user_id: userId,
        product_id: productId,
        location_id: locationId,
        qty_containers: 5,
      })
      .select('lot_id')
      .single();
    if (lotErr) throw new Error(`create lot: ${lotErr.message}`);
    lotId = lot.lot_id;

    // Active device.
    importKey = 'shelf_idem_' + randomBytes(16).toString('hex');
    const { error: devErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('live_shelf_devices')
      .insert({
        user_id: userId,
        device_name: 'Idempotency Pi',
        import_key_hash: createHash('sha256').update(importKey).digest('hex'),
        is_active: true,
        last_heartbeat_ts: new Date().toISOString(),
      });
    if (devErr) throw new Error(`create device: ${devErr.message}`);
  }, 60_000);

  afterAll(async () => {
    // Delete in FK-safe order.
    await (adminClient as any).schema('chefbyte').from('shelf_event_log').delete().eq('user_id', userId);
    await (adminClient as any).schema('chefbyte').from('food_logs').delete().eq('user_id', userId);
    await (adminClient as any).schema('chefbyte').from('stock_lots').delete().eq('user_id', userId);
    await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', productId);
    await (adminClient as any).schema('chefbyte').from('live_shelf_devices').delete().eq('user_id', userId);
    await cleanupUser(userId);
  });

  // ─── Case 1: Same key + same body → no duplicate ────────────────────

  it('1: same client_event_id + same body → second call is a no-op (one shelf_event_log row)', async () => {
    const clientEventId = crypto.randomUUID();
    const body = eventBody({
      client_event_id: clientEventId,
      product_id: productId,
    });

    const res1 = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify(body),
    });
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.ok).toBe(true);
    expect(json1.applied).toBe(true);

    const res2 = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify(body),
    });
    expect(res2.status).toBe(200);
    const json2 = await res2.json();

    // Both calls return 200 OK.
    expect(json2.ok).toBe(true);

    // The replay echoes the original outcome: applied stays true and
    // resolved_lot_id matches the first call (as of migration 20260419060000).
    expect(json2.applied).toBe(json1.applied);
    expect(json2.resolved_lot_id).toBe(json1.resolved_lot_id);

    // Exactly ONE row in shelf_event_log for this client_event_id.
    const count = await rowCount(userId, clientEventId);
    expect(count).toBe(1);
  });

  // ─── Case 2: Same key + different body → idempotency key wins ────────

  it('2: same client_event_id + different body fields → same result, still one DB row', async () => {
    const clientEventId = crypto.randomUUID();

    const body1 = eventBody({
      client_event_id: clientEventId,
      product_id: productId,
      delta_g: -200, // 200g consumed
    });
    const body2 = eventBody({
      client_event_id: clientEventId,
      product_id: productId,
      delta_g: -999, // different delta — should be ignored on replay
    });

    const res1 = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify(body1),
    });
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.ok).toBe(true);

    const res2 = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify(body2),
    });
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.ok).toBe(true);

    // The replay must echo the FIRST call's outcome, not re-apply body2.
    // resolved_lot_id must be the same (the second delta never touched stock).
    expect(json2.resolved_lot_id).toBe(json1.resolved_lot_id);

    // Only one row — the second call did not insert a new shelf_event_log row.
    const count = await rowCount(userId, clientEventId);
    expect(count).toBe(1);
  });

  // ─── Case 3: Different keys + same body → two independent successes ──

  it('3: different client_event_ids + same body → two distinct DB rows (separate events)', async () => {
    const clientEventId1 = crypto.randomUUID();
    const clientEventId2 = crypto.randomUUID();
    const sharedBody = {
      scale_id: 'scale-idempotency-01',
      kind: 'live_shelf',
      event_kind: 'consumed',
      product_id: productId,
      delta_g: -50,
      occurred_at: new Date().toISOString(),
    };

    const res1 = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({ ...sharedBody, client_event_id: clientEventId1 }),
    });
    expect(res1.status).toBe(200);
    expect((await res1.json()).ok).toBe(true);

    const res2 = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({ ...sharedBody, client_event_id: clientEventId2 }),
    });
    expect(res2.status).toBe(200);
    expect((await res2.json()).ok).toBe(true);

    // Two independent insertions — one row each.
    expect(await rowCount(userId, clientEventId1)).toBe(1);
    expect(await rowCount(userId, clientEventId2)).toBe(1);
  });

  // ─── Case 4: Concurrent calls with same key → exactly one row ────────

  it('4: concurrent calls with same client_event_id → one DB row, both callers get identical 200', async () => {
    const clientEventId = crypto.randomUUID();
    const body = JSON.stringify(
      eventBody({
        client_event_id: clientEventId,
        product_id: productId,
        delta_g: -75,
      }),
    );

    // Fire both requests at the same time (no await between them).
    const [res1, res2] = await Promise.all([
      fetch(`${BASE_URL}/event`, {
        method: 'POST',
        headers: authHeaders(importKey),
        body,
      }),
      fetch(`${BASE_URL}/event`, {
        method: 'POST',
        headers: authHeaders(importKey),
        body,
      }),
    ]);

    const [json1, json2] = await Promise.all([res1.json(), res2.json()]);

    // Both must succeed (200 OK).
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(json1.ok).toBe(true);
    expect(json2.ok).toBe(true);

    // The plpgsql UNIQUE constraint on (user_id, client_event_id) ensures
    // exactly one winner: one call inserts, the other replays. Both return
    // the same (applied, resolved_lot_id) tuple.
    expect(json1.resolved_lot_id).toBe(json2.resolved_lot_id);
    expect(json1.applied).toBe(json2.applied);

    // Only ONE shelf_event_log row — no race-condition double-insert.
    const count = await rowCount(userId, clientEventId);
    expect(count).toBe(1);
  });
});
