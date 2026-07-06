/**
 * shelf-ingest Edge Function Integration Tests
 *
 * Tests the shelf-ingest edge function with real HTTP calls against local
 * Supabase. Creates a test user, a registered Pi device, products + stock +
 * locations, then exercises each of the /catalog /event /intake /heartbeat
 * routes end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { adminClient, SUPABASE_URL } from '../../setup.integration';
import { createTestUser, cleanupUser } from '../../test-helpers';

const BASE_URL = `${SUPABASE_URL}/functions/v1/shelf-ingest`;

function authHeaders(key: string) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': key,
  };
}

describe('shelf-ingest Edge Function', () => {
  let userId: string;
  let otherUserId: string;
  let deviceId: string;
  let disabledDeviceId: string;
  let productId: string;
  let otherUserProductId: string;
  let liveScaleProductId: string;
  let locationId: string;
  let lotId: string;
  let importKey: string;
  let disabledImportKey: string;

  beforeAll(async () => {
    // ─── Primary test user ─────────────────────────────────────
    const user = await createTestUser('si-edge');
    userId = user.userId;

    const { error: actErr } = await (user.client as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
    if (actErr) throw new Error(`activate_app failed: ${actErr.message}`);

    // Location (required for event handlers). activate_app('chefbyte')
    // already seeded Fridge/Pantry/Freezer for this user — use a distinct
    // name so we don't collide with the unique(user_id, name) index.
    const { data: loc, error: locErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('locations')
      .insert({ user_id: userId, name: 'Shelf Test Location' })
      .select('location_id')
      .single();
    if (locErr) throw new Error(`create location: ${locErr.message}`);
    locationId = loc.location_id;

    // Product with net_weight_g so apply_shelf_event can convert grams → containers
    const { data: product, error: prodErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Shelf Test Milk',
        barcode: 'SI-TEST-MILK',
        servings_per_container: 4,
        calories_per_serving: 100,
        carbs_per_serving: 12,
        protein_per_serving: 8,
        fat_per_serving: 5,
        net_weight_g: 1000, // 1 kg carton → 1 g = 0.001 container
        container_type: 'carton',
      })
      .select('product_id')
      .single();
    if (prodErr) throw new Error(`create product: ${prodErr.message}`);
    productId = product.product_id;

    // Product for live_scale pairing test
    const { data: liveScaleProd } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Live Scale Coffee',
        barcode: 'SI-TEST-COFFEE',
        servings_per_container: 10,
        net_weight_g: 500,
        calories_per_serving: 5,
      })
      .select('product_id')
      .single();
    liveScaleProductId = liveScaleProd.product_id;

    // Initial stock: 2 cartons of milk
    const { data: lot, error: lotErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .insert({
        user_id: userId,
        product_id: productId,
        location_id: locationId,
        qty_containers: 2,
      })
      .select('lot_id')
      .single();
    if (lotErr) throw new Error(`create lot: ${lotErr.message}`);
    lotId = lot.lot_id;

    // Active Pi device
    importKey = 'shelf_' + randomBytes(16).toString('hex');
    const { data: dev, error: devErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('live_shelf_devices')
      .insert({
        user_id: userId,
        device_name: 'Kitchen Pi',
        import_key_hash: createHash('sha256').update(importKey).digest('hex'),
        is_active: true,
      })
      .select('device_id')
      .single();
    if (devErr) throw new Error(`create device: ${devErr.message}`);
    deviceId = dev.device_id;

    // Disabled device (auth should fail)
    disabledImportKey = 'shelf_' + randomBytes(16).toString('hex');
    const { data: disabled } = await (adminClient as any)
      .schema('chefbyte')
      .from('live_shelf_devices')
      .insert({
        user_id: userId,
        device_name: 'Disabled Pi',
        import_key_hash: createHash('sha256').update(disabledImportKey).digest('hex'),
        is_active: false,
      })
      .select('device_id')
      .single();
    disabledDeviceId = disabled.device_id;

    // ─── Second user (for scoping test) ────────────────────────
    const otherUser = await createTestUser('si-edge-other');
    otherUserId = otherUser.userId;
    await (otherUser.client as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });

    const { data: otherProd } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: otherUserId,
        name: 'Other User Bread',
        net_weight_g: 400,
      })
      .select('product_id')
      .single();
    otherUserProductId = otherProd.product_id;
  });

  afterAll(async () => {
    // Clean up in FK-safe order. shelf_event_log + scale_pairings cascade
    // from live_shelf_devices but we delete explicitly for speed + clarity.
    await (adminClient as any).schema('chefbyte').from('shelf_event_log').delete().in('user_id', [userId, otherUserId]);
    await (adminClient as any).schema('chefbyte').from('scale_pairings').delete().eq('device_id', deviceId);
    await (adminClient as any).schema('chefbyte').from('stock_lots').delete().eq('user_id', userId);
    await (adminClient as any).schema('chefbyte').from('food_logs').delete().eq('user_id', userId);
    await (adminClient as any)
      .schema('chefbyte')
      .from('live_shelf_devices')
      .delete()
      .in('device_id', [deviceId, disabledDeviceId]);
    await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .delete()
      .in('product_id', [productId, liveScaleProductId, otherUserProductId]);
    await (adminClient as any).schema('chefbyte').from('locations').delete().eq('user_id', userId);

    await cleanupUser(userId);
    await cleanupUser(otherUserId);
  });

  // ─── Auth tests ────────────────────────────────────────────────

  it('rejects requests without API key', async () => {
    const res = await fetch(`${BASE_URL}/catalog`, { method: 'GET' });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  it('rejects requests with invalid API key', async () => {
    const res = await fetch(`${BASE_URL}/catalog`, {
      method: 'GET',
      headers: { 'x-api-key': 'shelf_bogus_key_xxx' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects requests with a disabled device key', async () => {
    const res = await fetch(`${BASE_URL}/catalog`, {
      method: 'GET',
      headers: { 'x-api-key': disabledImportKey },
    });
    expect(res.status).toBe(401);
  });

  // ─── /catalog ──────────────────────────────────────────────────

  it('GET /catalog returns products + stock scoped to the authed user only', async () => {
    const res = await fetch(`${BASE_URL}/catalog`, {
      method: 'GET',
      headers: authHeaders(importKey),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body.products)).toBe(true);
    expect(Array.isArray(body.stock)).toBe(true);
    expect(Array.isArray(body.pairings)).toBe(true);
    expect(Array.isArray(body.locations)).toBe(true);

    const productIds = body.products.map((p: any) => p.product_id);
    expect(productIds).toContain(productId);
    expect(productIds).toContain(liveScaleProductId);
    expect(productIds).not.toContain(otherUserProductId);

    const stockProductIds = body.stock.map((s: any) => s.product_id);
    expect(stockProductIds).toContain(productId);

    const locationIds = body.locations.map((l: any) => l.location_id);
    expect(locationIds).toContain(locationId);
  });

  // ─── /event ────────────────────────────────────────────────────

  it('POST /event with consumed + valid product decrements the nearest-expiration lot', async () => {
    // Read baseline qty
    const { data: before } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('qty_containers')
      .eq('lot_id', lotId)
      .single();
    const qtyBefore = Number(before.qty_containers);

    const res = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        scale_id: 'scale-01',
        kind: 'live_shelf',
        event_kind: 'consumed',
        product_id: productId,
        delta_g: -250, // 1/4 carton
        occurred_at: new Date().toISOString(),
        client_event_id: crypto.randomUUID(),
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(true);
    expect(body.resolved_lot_id).toBe(lotId);

    const { data: after } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('qty_containers, last_update_source')
      .eq('lot_id', lotId)
      .single();
    expect(Number(after.qty_containers)).toBeCloseTo(qtyBefore - 0.25, 3);
    expect(after.last_update_source).toBe('live_shelf');
  });

  it('POST /event live_scale without product_id but with pairing resolves from pairing', async () => {
    // Pre-seed a pairing for scale-99 → liveScaleProductId
    await (adminClient as any).schema('chefbyte').from('scale_pairings').upsert(
      {
        user_id: userId,
        device_id: deviceId,
        scale_id: 'scale-99',
        kind: 'live_scale',
        product_id: liveScaleProductId,
      },
      { onConflict: 'device_id,scale_id' },
    );

    // Seed stock for that product so the event can apply
    await (adminClient as any).schema('chefbyte').from('stock_lots').insert({
      user_id: userId,
      product_id: liveScaleProductId,
      location_id: locationId,
      qty_containers: 1,
    });

    const res = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        scale_id: 'scale-99',
        kind: 'live_scale',
        event_kind: 'consumed',
        // no product_id — should be resolved via pairing
        delta_g: -50,
        occurred_at: new Date().toISOString(),
        client_event_id: crypto.randomUUID(),
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(true);
    expect(body.resolved_lot_id).toBeTruthy();
  });

  it('POST /event live_scale without product_id and no pairing returns 409 (scale not paired)', async () => {
    const res = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        scale_id: 'scale-unpaired',
        kind: 'live_scale',
        event_kind: 'consumed',
        delta_g: -10,
        occurred_at: new Date().toISOString(),
        client_event_id: crypto.randomUUID(),
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/scale not paired/i);
  });

  it('POST /event live_scale with pairing row but NULL product_id returns distinct 409 reason', async () => {
    // A pairing exists (scale is known) but product_id is NULL — the user
    // needs to pair the scale via the UI before its events will apply.
    await (adminClient as any).schema('chefbyte').from('scale_pairings').upsert(
      {
        user_id: userId,
        device_id: deviceId,
        scale_id: 'scale-known-unset',
        kind: 'live_scale',
        product_id: null,
      },
      { onConflict: 'device_id,scale_id' },
    );

    const res = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        scale_id: 'scale-known-unset',
        kind: 'live_scale',
        event_kind: 'consumed',
        delta_g: -10,
        occurred_at: new Date().toISOString(),
        client_event_id: crypto.randomUUID(),
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/scale paired but product unset/i);
    // Must be distinct from the "scale not paired" message.
    expect(body.error).not.toMatch(/not paired/i);
  });

  it('POST /event rejects missing required fields', async () => {
    const res = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({ scale_id: 'scale-01' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /event rejects missing client_event_id', async () => {
    const res = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        scale_id: 'scale-01',
        kind: 'live_shelf',
        event_kind: 'consumed',
        product_id: productId,
        delta_g: -100,
        occurred_at: new Date().toISOString(),
        // no client_event_id
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/client_event_id/i);
  });

  // ─── /event — cross-user isolation ────────────────────────────

  it('POST /event for another user\'s product returns "product not found" and does not mutate their stock', async () => {
    // Seed a stock lot for the other user so we can verify it's untouched.
    const { data: otherLot } = await (adminClient as any)
      .schema('chefbyte')
      .from('locations')
      .insert({ user_id: otherUserId, name: 'Shelf Test Other Location' })
      .select('location_id')
      .single();
    const { data: otherStock } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .insert({
        user_id: otherUserId,
        product_id: otherUserProductId,
        location_id: otherLot.location_id,
        qty_containers: 5,
      })
      .select('lot_id, qty_containers')
      .single();

    const res = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey), // userA's device
      body: JSON.stringify({
        scale_id: 'scale-cross',
        kind: 'live_shelf',
        event_kind: 'consumed',
        product_id: otherUserProductId, // belongs to userB
        delta_g: -100,
        occurred_at: new Date().toISOString(),
        client_event_id: crypto.randomUUID(),
      }),
    });

    // apply_shelf_event (migration 20260429340000) now RAISEs SQLSTATE 23503
    // for unknown product_id BEFORE writing a log row. The edge function
    // forwards this as HTTP 500. Pi worker must dead-letter on non-2xx.
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = await res.json();
    // Error body must not look like a success-shaped response.
    expect(body.ok).toBeFalsy();

    // Verify userB's stock is UNCHANGED.
    const { data: after } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('qty_containers')
      .eq('lot_id', otherStock.lot_id)
      .single();
    expect(Number(after.qty_containers)).toBe(Number(otherStock.qty_containers));

    // Cleanup
    await (adminClient as any).schema('chefbyte').from('stock_lots').delete().eq('lot_id', otherStock.lot_id);
    await (adminClient as any).schema('chefbyte').from('locations').delete().eq('location_id', otherLot.location_id);
  });

  // ─── /event — idempotency ─────────────────────────────────────

  it('POST /event with the same client_event_id twice applies only once', async () => {
    const clientEventId = crypto.randomUUID();

    const { data: before } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('qty_containers')
      .eq('lot_id', lotId)
      .single();
    const qtyBefore = Number(before.qty_containers);

    const payload = {
      scale_id: 'scale-dedup',
      kind: 'live_shelf' as const,
      event_kind: 'consumed' as const,
      product_id: productId,
      delta_g: -100, // 0.1 carton
      occurred_at: new Date().toISOString(),
      client_event_id: clientEventId,
    };

    const r1 = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify(payload),
    });
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1.applied).toBe(true);

    const r2 = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify(payload),
    });
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    // Second call: replay of the cached outcome. As of the v2 hardening
    // migration the Pi now sees the REAL outcome (applied=true + original
    // reason + resolved_lot_id), not a synthetic 'duplicate' marker.
    expect(b2.applied).toBe(true);
    expect(b2.resolved_lot_id).toBe(b1.resolved_lot_id);
    expect(b2.reason).toBe(b1.reason);

    // Verify stock mutated exactly once (qty decreased by 0.1, not 0.2).
    const { data: after } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('qty_containers')
      .eq('lot_id', lotId)
      .single();
    expect(Number(after.qty_containers)).toBeCloseTo(qtyBefore - 0.1, 3);
  });

  // ─── /event — empty-lot revive (prod chocolate-milk fix 2026-04-22) ────

  it('POST /event live_scale refilled REVIVES an empty lot at the merge-key tuple (prod chocolate-milk fix)', async () => {
    // Production repro (2026-04-22): user had a chocolate-milk lot
    // depleted to qty=0 on live_shelf; next event was a live_scale
    // refill on scale-03 paired to the same product. The old resolver
    // fell through to a MINT, which violated stock_lots_merge_key
    // (user, product, location, COALESCE(expires_on,'9999-12-31')) and
    // raised 23505 — rolling back the shelf_event_log INSERT with it.
    // Result: zero shelf_event_log rows for this user, every /event
    // call returned 500, Pi outbox stalled indefinitely.
    //
    // Migration 20260425070000 adds an empty-lot reuse step: if any
    // empty lot exists for (user, product) at the fallback location,
    // REVIVE it (flip qty 0 → delta_g/net_weight_g) instead of minting.
    //
    // This test MUST fail against the pre-fix resolver (500 response)
    // and pass after the migration lands.
    const { data: prod } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Revive Test Milk',
        barcode: 'SI-REVIVE-TEST',
        servings_per_container: 4,
        net_weight_g: 1000,
        calories_per_serving: 100,
      })
      .select('product_id')
      .single();

    // Find the user's earliest-created location — that's what the
    // resolver's mint path uses as fallback_location (ORDER BY
    // created_at ASC LIMIT 1 inside private.apply_shelf_event). Seed
    // the empty lot at THAT location so its merge-key collides with
    // the mint path exactly — this is the production scenario.
    const { data: fallbackLoc } = await (adminClient as any)
      .schema('chefbyte')
      .from('locations')
      .select('location_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .single();

    const { data: emptyLot } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .insert({
        user_id: userId,
        product_id: prod.product_id,
        location_id: fallbackLoc.location_id,
        qty_containers: 0,
        last_update_source: 'live_shelf',
        expires_on: null,
      })
      .select('lot_id')
      .single();

    const clientEventId = crypto.randomUUID();
    const res = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        scale_id: 'scale-revive-03',
        kind: 'live_scale',
        event_kind: 'refilled',
        product_id: prod.product_id,
        delta_g: 1000, // exactly 1 container
        occurred_at: new Date().toISOString(),
        client_event_id: clientEventId,
      }),
    });

    // Before the fix: 500 because apply_shelf_event raised 23505.
    // After the fix: 200 with applied=true.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(true);
    // The empty lot was revived, not a new one minted.
    expect(body.resolved_lot_id).toBe(emptyLot.lot_id);

    // shelf_event_log row landed — the whole point of the fix. Before
    // the migration, the RPC's exception rolled this INSERT back, so
    // there was no forensic trail at all.
    const { data: logRow } = await (adminClient as any)
      .schema('chefbyte')
      .from('shelf_event_log')
      .select('applied, reason, resolved_lot_id')
      .eq('user_id', userId)
      .eq('client_event_id', clientEventId)
      .single();
    expect(logRow).toBeTruthy();
    expect(logRow.applied).toBe(true);
    // 2026-04-29 (commit ddde56d): live_scale ADD branch is no-mint —
    // claims the empty lot but does NOT set qty from delta_g. The
    // user's rule: "single track scale should never mint a new item".
    // Reason flipped from `revived_empty_lot` → `live_scale_claim` and
    // qty stays at 0; subsequent direct-consumption events on the
    // claimed lot track stock via the existing flow.
    expect(logRow.reason).toBe('live_scale_claim');
    expect(logRow.resolved_lot_id).toBe(emptyLot.lot_id);

    // Lot was claimed (last_update_source flipped to live_scale, FEFO
    // pinning available) but qty stays at 0 — the no-mint guarantee.
    const { data: revivedLot } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('qty_containers, last_update_source')
      .eq('lot_id', emptyLot.lot_id)
      .single();
    expect(Number(revivedLot.qty_containers)).toBeCloseTo(0.0, 3);
    expect(revivedLot.last_update_source).toBe('live_scale');

    // Exactly one lot for this product: the resurrected one. The
    // merge_key unique index means a MINT attempt would have created
    // a duplicate row — this assertion proves the resolver took the
    // reuse path, not an (impossible) mint.
    const { data: allLots } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('lot_id')
      .eq('user_id', userId)
      .eq('product_id', prod.product_id);
    expect(allLots.length).toBe(1);

    // Cleanup
    await (adminClient as any).schema('chefbyte').from('stock_lots').delete().eq('product_id', prod.product_id);
    await (adminClient as any)
      .schema('chefbyte')
      .from('shelf_event_log')
      .delete()
      .eq('user_id', userId)
      .eq('client_event_id', clientEventId);
    await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', prod.product_id);
  });

  it('POST /event live_shelf added with empty lot at DIFFERENT location reuses + relocates it', async () => {
    // When the empty lot is at a non-fallback location, the resolver's
    // broader-sweep fallback kicks in: reuse the empty lot, stamp its
    // location_id to the fallback (so future events converge). This
    // prevents orphaned empty lots from accumulating across locations.
    const { data: prod } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Cross-Location Revive Test',
        barcode: 'SI-XLOC-REVIVE',
        servings_per_container: 1,
        net_weight_g: 100,
      })
      .select('product_id')
      .single();

    // Empty lot at a DIFFERENT location from the fallback. Use the
    // test-scoped `locationId` (Shelf Test Location), which was
    // created AFTER the activate_app() seeded locations — so the
    // resolver's earliest-by-created_at fallback picks a different one.
    const { data: emptyLot } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .insert({
        user_id: userId,
        product_id: prod.product_id,
        location_id: locationId,
        qty_containers: 0,
      })
      .select('lot_id, location_id')
      .single();

    const res = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        scale_id: 'scale-xloc-revive',
        kind: 'live_shelf',
        event_kind: 'added',
        product_id: prod.product_id,
        delta_g: 100,
        occurred_at: new Date().toISOString(),
        client_event_id: crypto.randomUUID(),
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
    // The empty lot must be reused, not a duplicate minted.
    expect(body.resolved_lot_id).toBe(emptyLot.lot_id);

    const { data: revivedLot } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('qty_containers, location_id')
      .eq('lot_id', emptyLot.lot_id)
      .single();
    expect(Number(revivedLot.qty_containers)).toBeCloseTo(1.0, 3);
    // Original location preserved (COALESCE keeps it) — only future
    // merge-key collisions would force relocation.
    expect(revivedLot.location_id).toBe(emptyLot.location_id);

    // Cleanup
    await (adminClient as any).schema('chefbyte').from('stock_lots').delete().eq('product_id', prod.product_id);
    await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', prod.product_id);
  });

  // ─── /event — move-vs-mint resolver ────────────────────────────
  // Migration 20260424080000 introduced the one-lot-per-product-per-
  // tracked-shelf invariant + a MOVE-vs-MINT resolver. When a
  // live_shelf ADD event lands for a product that ALREADY has a
  // pantry lot of matching weight, the resolver MOVES that pantry
  // lot onto the shelf rather than minting a duplicate.

  it('POST /event live_shelf added MOVES a matching pantry lot instead of minting a duplicate', async () => {
    // Fresh product with a known net_weight_g.
    const { data: prod } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Move Test Juice',
        barcode: 'SI-MOVE-TEST',
        servings_per_container: 4,
        net_weight_g: 1672,
      })
      .select('product_id')
      .single();

    // Seed ONE pantry lot of 1 full container (= 1672g current weight).
    const { data: pantryLot } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .insert({
        user_id: userId,
        product_id: prod.product_id,
        location_id: locationId,
        qty_containers: 1,
        last_update_source: 'manual',
        last_update_ts: new Date(Date.now() - 3600_000).toISOString(),
      })
      .select('lot_id')
      .single();

    // Pi emits an ADD of 1672g on live_shelf — same mass as pantry lot.
    const res = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        scale_id: 'scale-move',
        kind: 'live_shelf',
        event_kind: 'added',
        product_id: prod.product_id,
        delta_g: 1672,
        occurred_at: new Date().toISOString(),
        client_event_id: crypto.randomUUID(),
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
    // Resolver MOVE branch returns the pantry lot's id — NOT a new one.
    expect(body.resolved_lot_id).toBe(pantryLot.lot_id);

    // Inventory should show exactly ONE lot for this product, and it
    // should now have last_update_source = 'live_shelf'.
    const { data: lots } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('lot_id, last_update_source')
      .eq('product_id', prod.product_id)
      .eq('user_id', userId);
    expect(lots).toHaveLength(1);
    expect(lots[0].lot_id).toBe(pantryLot.lot_id);
    expect(lots[0].last_update_source).toBe('live_shelf');

    // Cleanup
    await (adminClient as any).schema('chefbyte').from('stock_lots').delete().eq('product_id', prod.product_id);
    await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', prod.product_id);
  });

  // ─── /heartbeat ────────────────────────────────────────────────

  it('POST /heartbeat creates scale_pairings rows on first sight', async () => {
    const res = await fetch(`${BASE_URL}/heartbeat`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        pending_review_count: 2,
        scales: [
          { scale_id: 'hb-scale-a', kind: 'live_shelf' },
          { scale_id: 'hb-scale-b', kind: 'catch_all' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const { data: pairings } = await (adminClient as any)
      .schema('chefbyte')
      .from('scale_pairings')
      .select('scale_id, kind, product_id, last_heartbeat_ts')
      .eq('device_id', deviceId)
      .in('scale_id', ['hb-scale-a', 'hb-scale-b']);

    expect(pairings).toHaveLength(2);
    for (const p of pairings) {
      expect(p.last_heartbeat_ts).toBeTruthy();
    }

    const { data: dev } = await (adminClient as any)
      .schema('chefbyte')
      .from('live_shelf_devices')
      .select('pending_review_count, last_heartbeat_ts')
      .eq('device_id', deviceId)
      .single();
    expect(dev.pending_review_count).toBe(2);
    expect(dev.last_heartbeat_ts).toBeTruthy();
  });

  it('POST /heartbeat preserves product_id on subsequent heartbeats', async () => {
    // First, create a paired row and set a product_id on it
    await (adminClient as any).schema('chefbyte').from('scale_pairings').upsert(
      {
        user_id: userId,
        device_id: deviceId,
        scale_id: 'hb-paired',
        kind: 'live_scale',
        product_id: liveScaleProductId,
      },
      { onConflict: 'device_id,scale_id' },
    );

    // Send a heartbeat that does NOT include product_id
    const res = await fetch(`${BASE_URL}/heartbeat`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        pending_review_count: 0,
        scales: [{ scale_id: 'hb-paired', kind: 'live_scale' }],
      }),
    });
    expect(res.status).toBe(200);

    const { data: pairing } = await (adminClient as any)
      .schema('chefbyte')
      .from('scale_pairings')
      .select('product_id')
      .eq('device_id', deviceId)
      .eq('scale_id', 'hb-paired')
      .single();

    // Must still be liveScaleProductId — heartbeat must NOT clear it
    expect(pairing.product_id).toBe(liveScaleProductId);
  });

  // ─── /intake ───────────────────────────────────────────────────

  it('POST /intake creates a new product', async () => {
    const res = await fetch(`${BASE_URL}/intake`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        name: 'Intake New Product',
        barcode: 'SI-INTAKE-NEW',
        net_weight_g: 250,
        container_type: 'can',
        servings_per_container: 2,
        calories_per_serving: 60,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.product_id).toBeTruthy();

    // Cleanup inline so we don't leak
    await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', body.product_id);
  });

  it('POST /intake with null barcode creates a new product (does not upsert)', async () => {
    // No barcode → always INSERT, never check-then-update.
    const r1 = await fetch(`${BASE_URL}/intake`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        name: 'Null-Barcode First',
        // no barcode field at all
        net_weight_g: 123,
      }),
    });
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1.product_id).toBeTruthy();

    const r2 = await fetch(`${BASE_URL}/intake`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        name: 'Null-Barcode Second',
        net_weight_g: 456,
      }),
    });
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    expect(b2.product_id).toBeTruthy();
    // Distinct product_ids — no upsert-on-null-barcode collision.
    expect(b2.product_id).not.toBe(b1.product_id);

    // Cleanup
    await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .delete()
      .in('product_id', [b1.product_id, b2.product_id]);
  });

  it('POST /intake upserts on (user_id, barcode)', async () => {
    const barcode = 'SI-INTAKE-UPSERT-' + Date.now();
    const r1 = await fetch(`${BASE_URL}/intake`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({ name: 'First', barcode, net_weight_g: 100 }),
    });
    const b1 = await r1.json();
    expect(r1.status).toBe(200);

    const r2 = await fetch(`${BASE_URL}/intake`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({ name: 'Second', barcode, net_weight_g: 200 }),
    });
    const b2 = await r2.json();
    expect(r2.status).toBe(200);
    // Same product_id — upsert, not new row
    expect(b2.product_id).toBe(b1.product_id);

    const { data: prod } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .select('name, net_weight_g')
      .eq('product_id', b2.product_id)
      .single();
    expect(prod.name).toBe('Second');
    expect(Number(prod.net_weight_g)).toBe(200);

    // Cleanup
    await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', b2.product_id);
  });

  // ─── /intake — full-row contract ───────────────────────────────

  it('POST /intake returns the full inserted row (not just product_id)', async () => {
    const barcode = 'SI-INTAKE-FULL-' + Date.now();
    const res = await fetch(`${BASE_URL}/intake`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        name: 'Full Row Test',
        barcode,
        net_weight_g: 123,
        container_type: 'bag',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Full row means the Pi's write-through cache can drop straight in.
    expect(body.product_id).toBeTruthy();
    expect(body.name).toBe('Full Row Test');
    expect(body.barcode).toBe(barcode);
    expect(Number(body.net_weight_g)).toBe(123);
    expect(body.container_type).toBe('bag');
    expect(body.user_id).toBe(userId);

    await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', body.product_id);
  });

  it('POST /intake persists previously-dropped fields (brand, variant, serving_weight_g, unit_type, density_g_per_ml, certified)', async () => {
    const barcode = 'SI-INTAKE-NEWCOLS-' + Date.now();
    const res = await fetch(`${BASE_URL}/intake`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        name: 'Full-field Intake',
        barcode,
        net_weight_g: 500,
        brand: 'AcmeCo',
        variant: 'organic',
        serving_weight_g: 42.5,
        unit_type: 'liquid',
        density_g_per_ml: 1.03,
        certified: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.product_id).toBeTruthy();

    const { data: row } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .select('brand, variant, serving_weight_g, unit_type, density_g_per_ml, certified')
      .eq('product_id', body.product_id)
      .single();
    expect(row.brand).toBe('AcmeCo');
    expect(row.variant).toBe('organic');
    expect(Number(row.serving_weight_g)).toBeCloseTo(42.5, 3);
    expect(row.unit_type).toBe('liquid');
    expect(Number(row.density_g_per_ml)).toBeCloseTo(1.03, 3);
    expect(row.certified).toBe(true);

    await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', body.product_id);
  });

  // ─── /event — validation hardening ─────────────────────────────

  it('POST /event rejects invalid event_kind with 400', async () => {
    const res = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        scale_id: 'scale-ev-inv',
        kind: 'live_shelf',
        event_kind: 'teleported',
        product_id: productId,
        delta_g: -10,
        occurred_at: new Date().toISOString(),
        client_event_id: crypto.randomUUID(),
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/event_kind/i);
  });

  it('POST /event rejects oversized client_event_id (>128 chars) with 400', async () => {
    const hugeId = 'x'.repeat(129);
    const res = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        scale_id: 'scale-oversize',
        kind: 'live_shelf',
        event_kind: 'consumed',
        product_id: productId,
        delta_g: -10,
        occurred_at: new Date().toISOString(),
        client_event_id: hugeId,
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/client_event_id/i);
  });

  it('POST /event rejects NaN delta_g with 400', async () => {
    // Raw body with literal NaN so JSON.parse rejects it — use a JSON
    // replacement that our server's `typeof body?.delta_g === 'number'` guard
    // catches. Since JSON has no NaN, send a string to force the validator
    // path; the edge function rejects "non-number" up front.
    const res = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        scale_id: 'scale-nan',
        kind: 'live_shelf',
        event_kind: 'consumed',
        product_id: productId,
        delta_g: 'not-a-number',
        occurred_at: new Date().toISOString(),
        client_event_id: crypto.randomUUID(),
      }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /event rejects occurred_at far in the future (year 2099) with 422 (retryable)', async () => {
    // 422 lets the Pi's retry worker hold the event for later retry
    // rather than marking it permanently failed (400 would).
    const res = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        scale_id: 'scale-future',
        kind: 'live_shelf',
        event_kind: 'consumed',
        product_id: productId,
        delta_g: -10,
        occurred_at: '2099-12-31T23:59:59Z',
        client_event_id: crypto.randomUUID(),
      }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/occurred_at/i);
  });

  // ─── /heartbeat — validation hardening ─────────────────────────

  it('POST /heartbeat rejects more than 32 scales with 400', async () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => ({
      scale_id: `flood-${i}`,
      kind: 'live_shelf' as const,
    }));
    const res = await fetch(`${BASE_URL}/heartbeat`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({ pending_review_count: 0, scales: tooMany }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /heartbeat drops an oversized scale_id (>128 chars) but still lands the heartbeat (liveness-first)', async () => {
    // Deliberate contract (see shelf-ingest validScales block): a heartbeat is
    // primarily a device-liveness signal. One malformed scale entry must NOT
    // 400/blackhole last_heartbeat_ts — that exact failure (an untranslated
    // legacy `single_item` literal) once showed every scale as "34d ago" while
    // the Pi was alive. Invalid entries are dropped + logged; valid siblings
    // and the device heartbeat still land.
    const hugeId = 'y'.repeat(129);
    const res = await fetch(`${BASE_URL}/heartbeat`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        pending_review_count: 0,
        scales: [
          { scale_id: hugeId, kind: 'live_shelf' },
          { scale_id: 'hb-valid-sibling', kind: 'live_shelf' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // The oversized scale was dropped — never upserted into scale_pairings.
    const { data: oversized } = await (adminClient as any)
      .schema('chefbyte')
      .from('scale_pairings')
      .select('scale_id')
      .eq('device_id', deviceId)
      .eq('scale_id', hugeId);
    expect(oversized).toHaveLength(0);

    // The valid sibling in the same payload still upserted.
    const { data: sibling } = await (adminClient as any)
      .schema('chefbyte')
      .from('scale_pairings')
      .select('scale_id, last_heartbeat_ts')
      .eq('device_id', deviceId)
      .eq('scale_id', 'hb-valid-sibling');
    expect(sibling).toHaveLength(1);
    expect(sibling[0].last_heartbeat_ts).toBeTruthy();

    // And device liveness landed.
    const { data: dev } = await (adminClient as any)
      .schema('chefbyte')
      .from('live_shelf_devices')
      .select('last_heartbeat_ts')
      .eq('device_id', deviceId)
      .single();
    expect(dev.last_heartbeat_ts).toBeTruthy();
  });

  // ─── Path routing — exact match ────────────────────────────────

  it('GET /catalogg (typo) returns 404, not catalog data', async () => {
    const res = await fetch(`${BASE_URL}/catalogg`, {
      method: 'GET',
      headers: authHeaders(importKey),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    // Must be an error shape, NOT a catalog {products,stock,…} payload.
    expect(body.products).toBeUndefined();
    expect(body.error).toBe('not found');
  });

  // ─── Idempotency: only one mutation + one food_logs row ───────

  it('POST /event with identical client_event_id replayed 3x writes exactly one food_logs row + one stock mutation', async () => {
    const clientEventId = crypto.randomUUID();

    // Fresh state for this product: clear existing food_logs + zero lot
    // mid-flight so the delta is unambiguous.
    await (adminClient as any)
      .schema('chefbyte')
      .from('food_logs')
      .delete()
      .eq('user_id', userId)
      .eq('product_id', productId);
    // Reset lot to a known qty.
    await (adminClient as any).schema('chefbyte').from('stock_lots').update({ qty_containers: 3 }).eq('lot_id', lotId);

    const payload = {
      scale_id: 'scale-idem',
      kind: 'live_shelf' as const,
      event_kind: 'consumed' as const,
      product_id: productId,
      delta_g: -500, // 0.5 container on a 1000g product
      occurred_at: new Date().toISOString(),
      client_event_id: clientEventId,
    };

    // Sequential retries with the SAME client_event_id. Even though the
    // edge function doesn't parallelize these, the plpgsql function's
    // idempotency check must make them safe.
    const results = [] as any[];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${BASE_URL}/event`, {
        method: 'POST',
        headers: authHeaders(importKey),
        body: JSON.stringify(payload),
      });
      expect(r.status).toBe(200);
      results.push(await r.json());
    }

    // All three responses are shape-identical now (applied=true, same
    // reason, same resolved_lot_id). The dedup-cache replay echoes the
    // first outcome so the Pi's retry queue can reconcile cleanly.
    expect(results.every((b) => b.applied === true)).toBe(true);
    const reasons = new Set(results.map((b) => b.reason));
    expect(reasons.size).toBe(1);
    const resolvedLots = new Set(results.map((b) => b.resolved_lot_id));
    expect(resolvedLots.size).toBe(1);

    // Stock mutated exactly once: 3 - 0.5 = 2.5
    const { data: after } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('qty_containers')
      .eq('lot_id', lotId)
      .single();
    expect(Number(after.qty_containers)).toBeCloseTo(2.5, 3);

    // Exactly one food_logs row written for this event.
    const { data: logs } = await (adminClient as any)
      .schema('chefbyte')
      .from('food_logs')
      .select('log_id')
      .eq('user_id', userId)
      .eq('product_id', productId);
    expect(logs).toHaveLength(1);
  });

  // ─── Manual-edit staleness fence (#3) ─────────────────────────
  // A manual UI edit that's newer than an incoming scale event wins —
  // the event reports applied=false + reason starting with 'stale' and
  // leaves the lot qty unchanged. Protects user edits from offline replay.
  it('POST /event: manual edit newer than occurred_at skips mutation with stale reason', async () => {
    // Fresh product + lot for this test so we fully control timestamps.
    const { data: prod } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Stale Fence Milk',
        barcode: 'SI-STALE-MILK',
        net_weight_g: 1000,
        servings_per_container: 4,
        calories_per_serving: 100,
      })
      .select('product_id')
      .single();

    // Manual edit timestamp: NOW. Event's occurred_at: 10 minutes earlier.
    const manualTs = new Date().toISOString();
    const occurredAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const { data: manualLot } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .insert({
        user_id: userId,
        product_id: prod.product_id,
        location_id: locationId,
        qty_containers: 2,
        last_update_source: 'manual',
        last_update_ts: manualTs,
      })
      .select('lot_id, qty_containers')
      .single();

    const res = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        scale_id: 'scale-stale',
        kind: 'live_shelf',
        event_kind: 'consumed',
        product_id: prod.product_id,
        delta_g: -500,
        occurred_at: occurredAt,
        client_event_id: crypto.randomUUID(),
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.reason).toMatch(/^stale/i);

    // Qty unchanged — the manual edit is preserved.
    const { data: after } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('qty_containers, last_update_source')
      .eq('lot_id', manualLot.lot_id)
      .single();
    expect(Number(after.qty_containers)).toBe(Number(manualLot.qty_containers));
    expect(after.last_update_source).toBe('manual');

    // Cleanup
    await (adminClient as any).schema('chefbyte').from('stock_lots').delete().eq('lot_id', manualLot.lot_id);
    await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', prod.product_id);
  });

  // ─── Dedup returns CACHED applied=true (#2) ───────────────────
  // A successful event, replayed with the same client_event_id, returns
  // the cached {applied:true, resolved_lot_id:<same>, reason:<same>} —
  // not a synthetic applied=false/'duplicate' marker.
  it('POST /event dedup replay returns cached applied=true with same resolved_lot_id', async () => {
    const clientEventId = crypto.randomUUID();

    await (adminClient as any).schema('chefbyte').from('stock_lots').update({ qty_containers: 5 }).eq('lot_id', lotId);

    const payload = {
      scale_id: 'scale-dedup-cached',
      kind: 'live_shelf' as const,
      event_kind: 'consumed' as const,
      product_id: productId,
      delta_g: -200,
      occurred_at: new Date().toISOString(),
      client_event_id: clientEventId,
    };

    const r1 = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify(payload),
    });
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1.applied).toBe(true);
    expect(b1.resolved_lot_id).toBeTruthy();

    const r2 = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify(payload),
    });
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    // Cached replay: applied=true, same lot, same reason.
    expect(b2.applied).toBe(true);
    expect(b2.resolved_lot_id).toBe(b1.resolved_lot_id);
    expect(b2.reason).toBe(b1.reason);
  });

  // ─── Heartbeat UPSERT idempotency (#4) ────────────────────────
  // Sequential retries of the same heartbeat scales must be idempotent
  // and must not error on the second call (validates the atomic
  // ON CONFLICT DO UPDATE path via heartbeat_upsert_pairings_admin).
  it('POST /heartbeat: repeated UPSERT for same scales is idempotent', async () => {
    const scales = [
      { scale_id: 'hb-idem-a', kind: 'live_shelf' as const },
      { scale_id: 'hb-idem-b', kind: 'catch_all' as const },
      { scale_id: 'hb-idem-c', kind: 'live_scale' as const },
    ];

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${BASE_URL}/heartbeat`, {
        method: 'POST',
        headers: authHeaders(importKey),
        body: JSON.stringify({ pending_review_count: 0, scales }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    }

    // Exactly one pairing row per scale_id under this device.
    const { data: pairings } = await (adminClient as any)
      .schema('chefbyte')
      .from('scale_pairings')
      .select('scale_id')
      .eq('device_id', deviceId)
      .in('scale_id', ['hb-idem-a', 'hb-idem-b', 'hb-idem-c']);
    expect(pairings).toHaveLength(3);
  });

  // ─── /intake: full field-level DB readback ────────────────────
  // Every field the Pi sends over the wire must land on the products
  // row. This is the exact class of test that would have caught
  // "6 fields silently dropped." Sends every supported column and
  // reads the row back via adminClient.
  it('POST /intake persists ALL supported fields into the products row', async () => {
    const barcode = 'SI-INTAKE-ALL-FIELDS-' + Date.now();
    const payload = {
      // Identifiers + descriptive text
      name: 'Full-Field Intake Product',
      barcode,
      description: 'The complete payload test — every field should round-trip.',
      // Brand/variant (post-audit fields)
      brand: 'AcmeCo',
      variant: 'unsweetened-organic',
      // Weight fields
      net_weight_g: 450,
      gross_weight_g: 475,
      tare_weight_g: 25,
      container_type: 'glass_jar',
      // Serving + macros
      servings_per_container: 8,
      calories_per_serving: 120,
      carbs_per_serving: 15,
      protein_per_serving: 6,
      fat_per_serving: 4.5,
      // Post-audit (the six "silently dropped" fields)
      serving_weight_g: 55.5,
      unit_type: 'solid',
      density_g_per_ml: 0.92,
      certified: true,
    };

    const res = await fetch(`${BASE_URL}/intake`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.product_id).toBeTruthy();

    // Read the row BACK via adminClient and assert every field matches.
    // A silent-drop regression (field listed in spec, omitted from payload
    // builder) would fail exactly here.
    const { data: row } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .select(
        'name, barcode, description, brand, variant, ' +
          'net_weight_g, gross_weight_g, tare_weight_g, container_type, ' +
          'servings_per_container, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, ' +
          'serving_weight_g, unit_type, density_g_per_ml, certified',
      )
      .eq('product_id', body.product_id)
      .single();

    expect(row.name).toBe(payload.name);
    expect(row.barcode).toBe(payload.barcode);
    expect(row.description).toBe(payload.description);
    expect(row.brand).toBe(payload.brand);
    expect(row.variant).toBe(payload.variant);
    expect(Number(row.net_weight_g)).toBe(payload.net_weight_g);
    expect(Number(row.gross_weight_g)).toBe(payload.gross_weight_g);
    expect(Number(row.tare_weight_g)).toBe(payload.tare_weight_g);
    expect(row.container_type).toBe(payload.container_type);
    expect(Number(row.servings_per_container)).toBe(payload.servings_per_container);
    expect(Number(row.calories_per_serving)).toBe(payload.calories_per_serving);
    expect(Number(row.carbs_per_serving)).toBe(payload.carbs_per_serving);
    expect(Number(row.protein_per_serving)).toBe(payload.protein_per_serving);
    expect(Number(row.fat_per_serving)).toBeCloseTo(payload.fat_per_serving, 3);
    expect(Number(row.serving_weight_g)).toBeCloseTo(payload.serving_weight_g, 3);
    expect(row.unit_type).toBe(payload.unit_type);
    expect(Number(row.density_g_per_ml)).toBeCloseTo(payload.density_g_per_ml, 3);
    expect(row.certified).toBe(payload.certified);

    await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', body.product_id);
  });

  // ─── /catalog — soft-delete propagation ─────────────────────────────
  //
  // The cloud "delete product" flow is a soft-delete: UPDATE … SET
  // deleted_at = now(). The /catalog endpoint must include tombstoned
  // rows in the updated_since delta window so the Pi's 30s poller can
  // apply the deletion locally. Outside the window (boot / fresh Pi),
  // tombstones are filtered out — a brand-new Pi should not see
  // historical deletions.

  it('GET /catalog with no updated_since hides soft-deleted rows', async () => {
    // Create a product then soft-delete it.
    const { data: doomed } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Catalog Delete Candidate',
        net_weight_g: 200,
      })
      .select('product_id')
      .single();

    const { error: delErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .update({ deleted_at: new Date().toISOString() })
      .eq('product_id', doomed.product_id);
    expect(delErr).toBeNull();

    // Full-pull /catalog: tombstoned row must NOT appear.
    const res = await fetch(`${BASE_URL}/catalog`, {
      method: 'GET',
      headers: authHeaders(importKey),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.products.map((p: any) => p.product_id);
    expect(ids).not.toContain(doomed.product_id);

    await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', doomed.product_id);
  });

  it('GET /catalog?updated_since=<old-iso> includes soft-deleted rows with deleted_at set', async () => {
    // Watermark: pin 1s ago so our newly-created+deleted row lands in
    // the delta window.
    const watermark = new Date(Date.now() - 1000).toISOString();

    // Seed and immediately soft-delete.
    const { data: doomed } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Delta Delete Target',
        net_weight_g: 150,
      })
      .select('product_id')
      .single();

    await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .update({ deleted_at: new Date().toISOString() })
      .eq('product_id', doomed.product_id);

    const res = await fetch(`${BASE_URL}/catalog?updated_since=${encodeURIComponent(watermark)}`, {
      method: 'GET',
      headers: authHeaders(importKey),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    const doomedRow = body.products.find((p: any) => p.product_id === doomed.product_id);
    expect(doomedRow).toBeTruthy();
    expect(doomedRow.deleted_at).toBeTruthy();

    await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', doomed.product_id);
  });

  // ─── /catalog — delta-filter on stock + pairings + locations ───────────
  //
  // Sync-audit finding #10 (2026-04-29): all four /catalog list fields are
  // delta-filtered when ?updated_since= is provided, not just products.
  // Future-watermark must return zero of each list; old-watermark must
  // include rows whose timestamps land in the delta window.

  it('GET /catalog?updated_since=<future> returns zero stock+pairings+locations', async () => {
    // Future watermark: every row's timestamp is older than this.
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await fetch(`${BASE_URL}/catalog?updated_since=${encodeURIComponent(future)}`, {
      method: 'GET',
      headers: authHeaders(importKey),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.products).toEqual([]);
    expect(body.stock).toEqual([]);
    expect(body.pairings).toEqual([]);
    expect(body.locations).toEqual([]);
  });

  it('GET /catalog?updated_since=<old> returns expected delta lists', async () => {
    // Old watermark: 1 hour ago — every seeded fixture should land in the
    // delta window.
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await fetch(`${BASE_URL}/catalog?updated_since=${encodeURIComponent(old)}`, {
      method: 'GET',
      headers: authHeaders(importKey),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // products: at least the seeded ones land in the window (created at
    // beforeAll → updated_at trigger fires on insert).
    expect(body.products.length).toBeGreaterThan(0);

    // locations: created during beforeAll are within the window.
    expect(body.locations.length).toBeGreaterThan(0);
    expect(body.locations.some((l: any) => l.location_id === locationId)).toBe(true);

    // stock: lots with last_update_ts NULL or > old watermark must be
    // included. The test fixture lot from beforeAll has last_update_source
    // set but last_update_ts may be NULL — both must be returned.
    expect(Array.isArray(body.stock)).toBe(true);

    // pairings: any device_id-scoped pairing rows surface here. The test
    // fixture doesn't create them, but the call shape returning an array
    // (not undefined / 500) is the assertion that matters.
    expect(Array.isArray(body.pairings)).toBe(true);
  });

  // ─── /overrides ─────────────────────────────────────────────────────

  it('GET /overrides returns event_overrides + lot state for the authed user only', async () => {
    // Seed: product + lot + event row + override. The Pi's poller needs
    // all three to reconcile. apply_event_override is the supported path
    // but requires a JWT session — we write directly with the admin
    // client to keep the test focused on the /overrides read path.
    const clientEventId = crypto.randomUUID();

    // Create a product + lot + shelf_event_log row for this override.
    const { data: ovProd } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Override Target',
        net_weight_g: 500,
        servings_per_container: 2,
        calories_per_serving: 100,
      })
      .select('product_id')
      .single();

    const { data: ovLot } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .insert({
        user_id: userId,
        product_id: ovProd.product_id,
        location_id: locationId,
        qty_containers: 0.6,
        last_update_source: 'manual',
      })
      .select('lot_id')
      .single();

    const { error: logErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('shelf_event_log')
      .insert({
        user_id: userId,
        device_id: deviceId,
        client_event_id: clientEventId,
        payload: {
          scale_id: 'scale-ov',
          kind: 'live_shelf',
          event_kind: 'consumed',
          product_id: ovProd.product_id,
          delta_g: -200,
          occurred_at: new Date().toISOString(),
          pi_event_id: 'pi-test-evt',
        },
        applied: true,
        reason: 'decremented',
        resolved_lot_id: ovLot.lot_id,
        pi_event_id: 'pi-test-evt',
      });
    expect(logErr).toBeNull();

    const { error: ovErr } = await (adminClient as any).schema('chefbyte').from('event_overrides').insert({
      user_id: userId,
      client_event_id: clientEventId,
      macros_servings_override: 1.0,
    });
    expect(ovErr).toBeNull();

    // Full pull (no watermark): override + lot state both present.
    const res = await fetch(`${BASE_URL}/overrides`, {
      method: 'GET',
      headers: authHeaders(importKey),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.overrides)).toBe(true);
    expect(Array.isArray(body.lots)).toBe(true);

    const ov = body.overrides.find((o: any) => o.client_event_id === clientEventId);
    expect(ov).toBeTruthy();
    expect(ov.resolved_lot_id).toBe(ovLot.lot_id);
    expect(ov.product_id).toBe(ovProd.product_id);
    expect(ov.pi_event_id).toBe('pi-test-evt');

    const lot = body.lots.find((l: any) => l.lot_id === ovLot.lot_id);
    expect(lot).toBeTruthy();
    expect(Number(lot.qty_containers)).toBeCloseTo(0.6, 3);

    // Cleanup
    await (adminClient as any).schema('chefbyte').from('event_overrides').delete().eq('client_event_id', clientEventId);
    await (adminClient as any).schema('chefbyte').from('shelf_event_log').delete().eq('client_event_id', clientEventId);
    await (adminClient as any).schema('chefbyte').from('stock_lots').delete().eq('lot_id', ovLot.lot_id);
    await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', ovProd.product_id);
  });

  it('GET /overrides?updated_since=<future> returns empty overrides + empty lots', async () => {
    // Watermark in the future → no rows qualify.
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await fetch(`${BASE_URL}/overrides?updated_since=${encodeURIComponent(future)}`, {
      method: 'GET',
      headers: authHeaders(importKey),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overrides).toEqual([]);
    expect(body.lots).toEqual([]);
  });

  it('GET /overrides isolates overrides across users (RLS-adjacent)', async () => {
    // Seed an override on the OTHER user and confirm the authed user's
    // /overrides response does not include it. shelf_event_log.user_id
    // is the only cross-user leak vector; the explicit .eq('user_id',
    // device.user_id) filter in the handler is what we're verifying.
    const otherCeid = crypto.randomUUID();

    const { data: otherLoc } = await (adminClient as any)
      .schema('chefbyte')
      .from('locations')
      .insert({ user_id: otherUserId, name: 'Other Override Location' })
      .select('location_id')
      .single();

    const { data: otherLot } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .insert({
        user_id: otherUserId,
        product_id: otherUserProductId,
        location_id: otherLoc.location_id,
        qty_containers: 1.0,
      })
      .select('lot_id')
      .single();

    await (adminClient as any)
      .schema('chefbyte')
      .from('shelf_event_log')
      .insert({
        user_id: otherUserId,
        device_id: deviceId, // intentionally cross-device — RLS still blocks
        client_event_id: otherCeid,
        payload: {
          scale_id: 'other-scale',
          kind: 'live_shelf',
          event_kind: 'consumed',
          product_id: otherUserProductId,
          delta_g: -50,
          occurred_at: new Date().toISOString(),
        },
        applied: true,
        reason: 'decremented',
        resolved_lot_id: otherLot.lot_id,
      });

    await (adminClient as any)
      .schema('chefbyte')
      .from('event_overrides')
      .insert({ user_id: otherUserId, client_event_id: otherCeid });

    const res = await fetch(`${BASE_URL}/overrides`, {
      method: 'GET',
      headers: authHeaders(importKey), // primary user's key
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const leaked = body.overrides.find((o: any) => o.client_event_id === otherCeid);
    expect(leaked).toBeUndefined();
    const leakedLot = body.lots.find((l: any) => l.lot_id === otherLot.lot_id);
    expect(leakedLot).toBeUndefined();

    // Cleanup
    await (adminClient as any).schema('chefbyte').from('event_overrides').delete().eq('client_event_id', otherCeid);
    await (adminClient as any).schema('chefbyte').from('shelf_event_log').delete().eq('client_event_id', otherCeid);
    await (adminClient as any).schema('chefbyte').from('stock_lots').delete().eq('lot_id', otherLot.lot_id);
    await (adminClient as any).schema('chefbyte').from('locations').delete().eq('location_id', otherLoc.location_id);
  });

  // ─── HTTP contract: phantom product_id → 4xx/5xx (Change F) ───────────

  it('POST /event with phantom product_id returns 4xx/5xx with machine-readable error, NOT 200+applied=false', async () => {
    // FINAL_PLAN.md Change F: the edge function must propagate an
    // unknown product_id as a non-200 HTTP response with a machine-
    // readable error code, not as 200 + {ok:true, applied:false, ...}.
    //
    // The DB RAISES with SQLSTATE 23503 (migration 20260429340000).
    // The edge function's error branch fires → HTTP 5xx.
    // OR the RPC writes the log row but returns applied=false with
    // unexpected reason → edge function returns HTTP 422.
    //
    // NEGATIVE-TWIN PROOF:
    //   Reverting 20260429340000_apply_shelf_event_strict.sql (removing
    //   the pre-insert RAISE) causes the RPC to return applied=false
    //   with reason='product not found'. Reverting the edge-fn
    //   EXPECTED_NOT_APPLIED_REASONS check causes this to fall through
    //   to the 200+applied=false branch. Both reversions make this
    //   test fail because the response would be 200 instead of 4xx/5xx.
    const phantomProductId = 'ffffffff-eeee-eeee-eeee-ffffffffffff';

    const res = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        scale_id: 'scale-01',
        kind: 'live_shelf',
        event_kind: 'consumed',
        product_id: phantomProductId,
        delta_g: -100,
        occurred_at: new Date().toISOString(),
        client_event_id: `contract-test-phantom-${crypto.randomUUID()}`,
      }),
    });

    // Must be 4xx or 5xx — NOT 200.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);

    const body = await res.json();

    // Must have a machine-readable error field, not a success shape.
    // Success shape would be: {ok: true, applied: ..., reason: ..., resolved_lot_id: ...}
    // Error shape must have: {error: '...', code?: '...'} (no 'ok: true').
    expect(body).not.toHaveProperty('ok', true);
    expect(body).toHaveProperty('error');
    expect(typeof body.error).toBe('string');
  });

  // ─── /product-tare: measured_full_at write + set-once enforcement ────
  //
  // Task 2 of the catch-all-livetrack auto-import plan: the Pi's
  // auto-import dispatch needs to programmatically push measured_full_at
  // when the catch-all scale settles at tare + net_weight_g. Cloud must
  // accept the optional field on /product-tare AND enforce set-once so
  // a Pi retry can't overwrite a previously-stamped value.

  it('POST /product-tare also accepts measured_full_at and stamps it once', async () => {
    // Fresh product with both fields NULL so the write actually lands.
    const { data: prod, error: prodErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Tare-And-Full Product',
        barcode: `SI-TARE-FULL-${Date.now()}`,
        net_weight_g: 500,
        servings_per_container: 5,
      })
      .select('product_id')
      .single();
    if (prodErr) throw new Error(`create tare product: ${prodErr.message}`);
    const tareProductId = prod.product_id;

    // First write: both tare_weight_g + measured_full_at land.
    const firstStamp = '2026-05-02T18:00:00.000Z';
    const res = await fetch(`${BASE_URL}/product-tare`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        product_id: tareProductId,
        tare_weight_g: 25,
        measured_full_at: firstStamp,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.product_id).toBe(tareProductId);
    expect(Number(body.tare_weight_g)).toBe(25);
    // The handler echoes back the stored value (whatever Postgres
    // serialised) — assert via DB readback below for canonical shape.

    const { data: row1 } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .select('tare_weight_g, measured_full_at')
      .eq('product_id', tareProductId)
      .single();
    expect(Number(row1.tare_weight_g)).toBe(25);
    expect(new Date(row1.measured_full_at).toISOString()).toBe(firstStamp);

    // Second write: a DIFFERENT measured_full_at MUST NOT overwrite —
    // this is the set-once defense-in-depth guard. The Pi already
    // pre-checks but cloud must not trust retried payloads.
    const secondStamp = '2026-05-02T19:30:00.000Z';
    const res2 = await fetch(`${BASE_URL}/product-tare`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        product_id: tareProductId,
        measured_full_at: secondStamp,
      }),
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.ok).toBe(true);

    const { data: row2 } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .select('tare_weight_g, measured_full_at')
      .eq('product_id', tareProductId)
      .single();
    expect(Number(row2.tare_weight_g)).toBe(25);
    // Set-once: the FIRST stamp is preserved.
    expect(new Date(row2.measured_full_at).toISOString()).toBe(firstStamp);

    // Cleanup
    await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', tareProductId);
  });

  it('POST /product-tare with neither field returns 400', async () => {
    // Defensive contract check: at least one of tare_weight_g /
    // measured_full_at must be present, otherwise the call is a no-op
    // and we surface that as a 400 to make Pi-side bugs loud.
    const res = await fetch(`${BASE_URL}/product-tare`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({ product_id: productId }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/required/i);
  });

  it('POST /product-tare with malformed measured_full_at returns 400', async () => {
    const res = await fetch(`${BASE_URL}/product-tare`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        product_id: productId,
        measured_full_at: 'not-an-iso-timestamp',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/iso/i);
  });

  // ─── /product-tare: certified flag set-once (two-pass classification) ─
  //
  // 2026-05-03 two-pass catch-all classification. When the Pi's
  // catch-all classifier matches against the user's UNCERTIFIED
  // inventory (pass-2), the dispatch path pushes ``certified=true`` to
  // /product-tare so the product graduates to LiveTrack-tracked. Cloud
  // must accept the optional field AND enforce set-once: once true,
  // never reverses (a stray ``false`` from the Pi side is ignored).

  it('POST /product-tare flips certified false → true and is set-once after', async () => {
    // Fresh uncertified product so the cert flip actually lands.
    const { data: prod, error: prodErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Uncertified-Then-Certified',
        barcode: `SI-CERT-${Date.now()}`,
        net_weight_g: 500,
        servings_per_container: 5,
        certified: false,
      })
      .select('product_id')
      .single();
    if (prodErr) throw new Error(`create cert product: ${prodErr.message}`);
    const certProductId = prod.product_id;

    try {
      // First write: certified=true flips false → true.
      const res = await fetch(`${BASE_URL}/product-tare`, {
        method: 'POST',
        headers: authHeaders(importKey),
        body: JSON.stringify({
          product_id: certProductId,
          certified: true,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.product_id).toBe(certProductId);
      expect(body.certified).toBe(true);

      const { data: row1 } = await (adminClient as any)
        .schema('chefbyte')
        .from('products')
        .select('certified')
        .eq('product_id', certProductId)
        .single();
      expect(row1.certified).toBe(true);

      // Second write: certified=false MUST be ignored — the Pi never
      // un-certifies, and cloud's set-once guard treats the request
      // as a no-op (200 with the existing row state echoed back).
      const res2 = await fetch(`${BASE_URL}/product-tare`, {
        method: 'POST',
        headers: authHeaders(importKey),
        body: JSON.stringify({
          product_id: certProductId,
          certified: false,
        }),
      });
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.ok).toBe(true);
      // Row remains certified=true.
      expect(body2.certified).toBe(true);

      const { data: row2 } = await (adminClient as any)
        .schema('chefbyte')
        .from('products')
        .select('certified')
        .eq('product_id', certProductId)
        .single();
      expect(row2.certified).toBe(true);

      // Third write: certified=true again — set-once means no-op
      // success (already true), still 200.
      const res3 = await fetch(`${BASE_URL}/product-tare`, {
        method: 'POST',
        headers: authHeaders(importKey),
        body: JSON.stringify({
          product_id: certProductId,
          certified: true,
        }),
      });
      expect(res3.status).toBe(200);
      const body3 = await res3.json();
      expect(body3.ok).toBe(true);
      expect(body3.certified).toBe(true);

      // Audit A-CRIT-3 (2026-05-04): readback the DB row after the
      // third write to confirm (a) certified actually stayed true on
      // disk (not just echoed back from the response) AND (b) no
      // collateral mutation on the other set-once columns. A regression
      // that lets the no-op write secretly stomp ``tare_weight_g`` or
      // ``measured_full_at`` to NULL would not be caught by the
      // response body alone.
      const { data: row3 } = await (adminClient as any)
        .schema('chefbyte')
        .from('products')
        .select('certified, tare_weight_g, measured_full_at')
        .eq('product_id', certProductId)
        .single();
      expect(row3.certified).toBe(true);
      // Tare and measured_full_at were never set on this row in the
      // test setup; the no-op certified write must NOT have created
      // collateral non-null values.
      expect(row3.tare_weight_g).toBeNull();
      expect(row3.measured_full_at).toBeNull();
    } finally {
      // Cleanup
      await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', certProductId);
    }
  });

  it('POST /product-tare end-to-end: uncertified product → certified=true via Pi-shape body', async () => {
    // Audit B-HIGH-7 (2026-05-04): the user's mental model spans six
    // steps:
    //   1. Pi catch-all event arrives.
    //   2. Orchestrator pass-1 (certified-only) returns UNKNOWN.
    //   3. Orchestrator pass-2 (uncertified-only) returns confident match.
    //   4. Dispatch fires ``certified=true`` push.
    //   5. Cloud ``/shelf-ingest/product-tare`` accepts.
    //   6. ``chefbyte.products.certified`` flips to ``true`` in the DB.
    //
    // Steps 1-3 are covered by the orchestrator tests; step 4 by the
    // dispatch tests; steps 5-6 by the existing flips-certified test.
    // This test pins the SEAM between step 4 and step 5: the EXACT
    // body shape that ``CloudClient.push_product_state`` sends with
    // ``certified=True`` (no ``tare_g`` / ``tare_weight_g`` keys, just
    // ``product_id`` + ``certified``) lands the cert flip end-to-end
    // through the route to the DB.
    //
    // A regression in the wire-name contract — e.g. body becomes
    // ``{product_id, isCertified: true}`` — would silently break the
    // certify auto-import even though all three slice tests stay green.
    const { data: prod, error: prodErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'E2E-Pi-Certify',
        barcode: `SI-CERT-E2E-${Date.now()}`,
        net_weight_g: 500,
        servings_per_container: 5,
        certified: false,
      })
      .select('product_id')
      .single();
    if (prodErr) throw new Error(`create e2e cert product: ${prodErr.message}`);
    const e2eProductId = prod.product_id;

    try {
      // Body shape EXACTLY mirrors what ``CloudClient.push_product_state``
      // sends when called as ``push_product_state(product_id=X,
      // certified=True)`` per server/cloud/client.py:548-554. Keys
      // explicitly NOT included: tare_weight_g, measured_full_at —
      // proves the route accepts a certified-only update.
      const piBody = {
        product_id: e2eProductId,
        certified: true,
      };
      const res = await fetch(`${BASE_URL}/product-tare`, {
        method: 'POST',
        headers: authHeaders(importKey),
        body: JSON.stringify(piBody),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.product_id).toBe(e2eProductId);
      expect(body.certified).toBe(true);

      // DB readback (step 6 of the user's mental model): the row
      // actually flipped to certified=true.
      const { data: row } = await (adminClient as any)
        .schema('chefbyte')
        .from('products')
        .select('certified, tare_weight_g, measured_full_at')
        .eq('product_id', e2eProductId)
        .single();
      expect(row.certified).toBe(true);
      // Pi sent only certified=true; tare and measured_full_at must
      // remain at their initial values (NULL since this is a fresh
      // product with no LiveTrack capture history).
      expect(row.tare_weight_g).toBeNull();
      expect(row.measured_full_at).toBeNull();
    } finally {
      await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', e2eProductId);
    }
  });

  it('POST /product-tare with certified=false on an uncertified row leaves it false', async () => {
    // Audit A-CRIT-2 (2026-05-04): mutation guard for the inverted
    // set-once filter. The existing "false → true → false → true" test
    // never exercises the cold path: ``existing.certified === false``
    // AND request ``certified === false`` → the row MUST stay false.
    //
    // A typo regression — e.g. ``updates.certified === true`` →
    // ``updates.certified !== undefined``, or ``!existing.certified``
    // inverted, or ``filtered.certified = true`` →
    // ``filtered.certified = updates.certified`` — would silently flip
    // ``false → true`` on a Pi-side push of ``certified=false``. None
    // of the existing subtests catch any of those mutations because
    // every other test starts from a row where ``certified=true`` is
    // already the intended end state.
    const { data: prod, error: prodErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Stays-Uncertified',
        barcode: `SI-CERT-FALSE-${Date.now()}`,
        net_weight_g: 500,
        servings_per_container: 5,
        certified: false,
      })
      .select('product_id')
      .single();
    if (prodErr) throw new Error(`create stays-uncertified product: ${prodErr.message}`);
    const stayProductId = prod.product_id;

    try {
      const res = await fetch(`${BASE_URL}/product-tare`, {
        method: 'POST',
        headers: authHeaders(importKey),
        body: JSON.stringify({
          product_id: stayProductId,
          certified: false,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      // Response echoes the existing (still-false) row state.
      expect(body.certified).toBe(false);

      const { data: row } = await (adminClient as any)
        .schema('chefbyte')
        .from('products')
        .select('certified')
        .eq('product_id', stayProductId)
        .single();
      // DB readback: row MUST stay false. The set-once filter must
      // NOT silently promote false→true on a false-payload write.
      expect(row.certified).toBe(false);
    } finally {
      await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', stayProductId);
    }
  });

  it('POST /product-tare with non-boolean certified returns 400', async () => {
    const res = await fetch(`${BASE_URL}/product-tare`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        product_id: productId,
        certified: 'not-a-boolean',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/boolean/i);
  });

  // ─── /scanner-state: browser-JWT mode persistence ──────────────────
  //
  // Task 4 of the Pi USB scanner forwarder plan: the web ScannerPage
  // pushes mode-state changes (last_active_mode + locked_mode) into the
  // cloud so the Pi USB forwarder can resolve which mode to apply for
  // each scan even when the browser tab is closed. PATCH-style upsert:
  // partial bodies must not stomp the un-supplied field.

  it('POST /scanner-state UPSERTs scanner_state with PATCH semantics', async () => {
    // Fresh user — scanner_state has no row yet, so the first call
    // exercises INSERT and subsequent calls exercise UPDATE via
    // ON CONFLICT (user_id).
    const tempUser = await createTestUser('si-scanner-state');
    try {
      const {
        data: { session },
      } = await tempUser.client.auth.getSession();
      const accessToken = session!.access_token;
      const jwtHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      };

      const fetchScannerState = async () => {
        const { data } = await (adminClient as any)
          .schema('chefbyte')
          .from('scanner_state')
          .select('user_id, last_active_mode, locked_mode')
          .eq('user_id', tempUser.userId)
          .maybeSingle();
        return data;
      };

      // Step 1: set last_active_mode (locked_mode untouched → NULL on a
      // fresh INSERT; PATCH semantics on a subsequent UPDATE).
      const r1 = await fetch(`${BASE_URL}/scanner-state`, {
        method: 'POST',
        headers: jwtHeaders,
        body: JSON.stringify({ last_active_mode: 'consume_macros' }),
      });
      expect(r1.status).toBe(200);
      const body1 = await r1.json();
      expect(body1.ok).toBe(true);
      expect(body1.last_active_mode).toBe('consume_macros');
      expect(body1.locked_mode).toBeNull();
      let row = await fetchScannerState();
      expect(row).not.toBeNull();
      expect(row.user_id).toBe(tempUser.userId);
      expect(row.last_active_mode).toBe('consume_macros');
      expect(row.locked_mode).toBeNull();

      // Step 2: set locked_mode WITHOUT supplying last_active_mode. The
      // existing 'consume_macros' value MUST survive (PATCH, not PUT).
      const r2 = await fetch(`${BASE_URL}/scanner-state`, {
        method: 'POST',
        headers: jwtHeaders,
        body: JSON.stringify({ locked_mode: 'shopping' }),
      });
      expect(r2.status).toBe(200);
      const body2 = await r2.json();
      expect(body2.last_active_mode).toBe('consume_macros');
      expect(body2.locked_mode).toBe('shopping');
      row = await fetchScannerState();
      expect(row.last_active_mode).toBe('consume_macros');
      expect(row.locked_mode).toBe('shopping');

      // Step 3: clear the lock by sending null. last_active_mode still
      // preserved.
      const r3 = await fetch(`${BASE_URL}/scanner-state`, {
        method: 'POST',
        headers: jwtHeaders,
        body: JSON.stringify({ locked_mode: null }),
      });
      expect(r3.status).toBe(200);
      const body3 = await r3.json();
      expect(body3.last_active_mode).toBe('consume_macros');
      expect(body3.locked_mode).toBeNull();
      row = await fetchScannerState();
      expect(row.last_active_mode).toBe('consume_macros');
      expect(row.locked_mode).toBeNull();
    } finally {
      // FK cascade from auth.users handles scanner_state cleanup.
      await cleanupUser(tempUser.userId);
    }
  });

  it('POST /scanner-state rejects invalid mode', async () => {
    const tempUser = await createTestUser('si-scanner-state-bad');
    try {
      const {
        data: { session },
      } = await tempUser.client.auth.getSession();
      const accessToken = session!.access_token;

      const res = await fetch(`${BASE_URL}/scanner-state`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ last_active_mode: 'bogus' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/last_active_mode/i);
    } finally {
      await cleanupUser(tempUser.userId);
    }
  });

  // ─── /barcode-scan: Pi/web entrypoint ─────────────────────────────
  //
  // Task 5 of the Pi USB scanner forwarder plan: every USB scan from
  // the Pi (or every web-driven scan) lands here. Auth is dual-mode:
  // x-api-key (Pi, source='pi_usb') OR JWT (web, source='web'). Mode
  // resolves locked_mode > body.mode > last_active_mode > 'purchase'.
  // pi_event_id (when present) makes a duplicate POST a no-op.

  /** Helper: provision one fresh user + Pi device for a barcode-scan
   *  test. Each test owns its own user so concurrent runs don't poison
   *  each other's scanner_state / scan_transactions rows. */
  async function provisionScannerUser(suffix: string): Promise<{
    userId: string;
    accessToken: string;
    deviceId: string;
    importKey: string;
    locationId: string;
    cleanup: () => Promise<void>;
  }> {
    const user = await createTestUser(suffix);
    const { error: actErr } = await (user.client as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
    if (actErr) throw new Error(`activate_app failed: ${actErr.message}`);

    // activate_app seeds Fridge/Pantry/Freezer; pick the oldest (matches
    // execute_scan_action's ORDER BY created_at ASC LIMIT 1).
    const { data: locs } = await (adminClient as any)
      .schema('chefbyte')
      .from('locations')
      .select('location_id')
      .eq('user_id', user.userId)
      .order('created_at', { ascending: true })
      .limit(1);
    const oldestLoc = locs?.[0]?.location_id ?? null;

    const apiKey = 'shelf_' + randomBytes(16).toString('hex');
    const { data: dev, error: devErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('live_shelf_devices')
      .insert({
        user_id: user.userId,
        device_name: `Scanner Test Pi ${suffix}`,
        import_key_hash: createHash('sha256').update(apiKey).digest('hex'),
        is_active: true,
      })
      .select('device_id')
      .single();
    if (devErr) throw new Error(`create device: ${devErr.message}`);

    const {
      data: { session },
    } = await user.client.auth.getSession();
    const accessToken = session!.access_token;

    return {
      userId: user.userId,
      accessToken,
      deviceId: dev.device_id,
      importKey: apiKey,
      locationId: oldestLoc,
      cleanup: async () => {
        // FK-safe: scan_transactions → products/stock_lots/food_logs/shopping_list,
        // device → device_id. Cascade from auth.users handles scanner_state +
        // scan_transactions (user_id ON DELETE CASCADE) but we wipe explicitly
        // for clarity + speed.
        await (adminClient as any).schema('chefbyte').from('scan_transactions').delete().eq('user_id', user.userId);
        await (adminClient as any).schema('chefbyte').from('food_logs').delete().eq('user_id', user.userId);
        await (adminClient as any).schema('chefbyte').from('shopping_list').delete().eq('user_id', user.userId);
        await (adminClient as any).schema('chefbyte').from('stock_lots').delete().eq('user_id', user.userId);
        await (adminClient as any).schema('chefbyte').from('products').delete().eq('user_id', user.userId);
        await (adminClient as any)
          .schema('chefbyte')
          .from('live_shelf_devices')
          .delete()
          .eq('device_id', dev.device_id);
        await cleanupUser(user.userId);
      },
    };
  }

  it('POST /barcode-scan(purchase) creates a stock_lot + scan_transactions row', async () => {
    const ctx = await provisionScannerUser('si-bs-purchase');
    try {
      // Seed: a product the Pi will scan + scanner_state.last_active_mode='purchase'.
      const barcode = 'BS-PURCHASE-' + randomBytes(4).toString('hex').toUpperCase();
      const { data: prod } = await (adminClient as any)
        .schema('chefbyte')
        .from('products')
        .insert({
          user_id: ctx.userId,
          name: 'Scanner Pasta',
          barcode,
          servings_per_container: 2,
          calories_per_serving: 200,
          net_weight_g: 500,
        })
        .select('product_id')
        .single();
      const productId = prod.product_id;

      await (adminClient as any)
        .schema('chefbyte')
        .from('scanner_state')
        .upsert({ user_id: ctx.userId, last_active_mode: 'purchase' }, { onConflict: 'user_id' });

      const piEventId = 'evt-' + crypto.randomUUID();
      const res = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.importKey },
        body: JSON.stringify({ barcode, pi_event_id: piEventId }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.transaction_id).toBeTruthy();
      expect(body.status).toBe('applied');
      expect(body.mode).toBe('purchase');
      expect(body.product_id).toBe(productId);
      expect(body.applied_lot_id).toBeTruthy();

      // Verify the scan_transactions row matches the response.
      const { data: tx } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('transaction_id, barcode, mode, product_id, status, source, pi_event_id, applied_lot_id, applied_at')
        .eq('transaction_id', body.transaction_id)
        .single();
      expect(tx.barcode).toBe(barcode);
      expect(tx.mode).toBe('purchase');
      expect(tx.product_id).toBe(productId);
      expect(tx.status).toBe('applied');
      expect(tx.source).toBe('pi_usb');
      expect(tx.pi_event_id).toBe(piEventId);
      expect(tx.applied_lot_id).toBe(body.applied_lot_id);
      expect(tx.applied_at).toBeTruthy();

      // Verify the stock_lot was actually minted.
      const { data: lots } = await (adminClient as any)
        .schema('chefbyte')
        .from('stock_lots')
        .select('lot_id, qty_containers, product_id, location_id')
        .eq('user_id', ctx.userId)
        .eq('product_id', productId);
      expect(lots).toHaveLength(1);
      expect(lots[0].lot_id).toBe(body.applied_lot_id);
      expect(Number(lots[0].qty_containers)).toBe(1);
      expect(lots[0].location_id).toBe(ctx.locationId);
    } finally {
      await ctx.cleanup();
    }
  });

  it('POST /barcode-scan with same pi_event_id is idempotent', async () => {
    const ctx = await provisionScannerUser('si-bs-idem');
    try {
      const barcode = 'BS-IDEM-' + randomBytes(4).toString('hex').toUpperCase();
      await (adminClient as any).schema('chefbyte').from('products').insert({
        user_id: ctx.userId,
        name: 'Idem Product',
        barcode,
        servings_per_container: 1,
        net_weight_g: 100,
      });
      await (adminClient as any)
        .schema('chefbyte')
        .from('scanner_state')
        .upsert({ user_id: ctx.userId, last_active_mode: 'purchase' }, { onConflict: 'user_id' });

      const piEventId = 'evt-' + crypto.randomUUID();
      const headers = { 'Content-Type': 'application/json', 'x-api-key': ctx.importKey };
      const r1 = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ barcode, pi_event_id: piEventId }),
      });
      const b1 = await r1.json();
      const r2 = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ barcode, pi_event_id: piEventId }),
      });
      const b2 = await r2.json();
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(b1.transaction_id).toBe(b2.transaction_id);
      // Second response is the idempotent replay — the route signals it.
      expect(b2.idempotent).toBe(true);

      // Verify only ONE scan_transactions row exists.
      const { data: rows, count } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('transaction_id', { count: 'exact' })
        .eq('user_id', ctx.userId)
        .eq('pi_event_id', piEventId);
      expect(count).toBe(1);
      expect(rows).toHaveLength(1);
    } finally {
      await ctx.cleanup();
    }
  });

  it('POST /barcode-scan respects locked_mode override', async () => {
    const ctx = await provisionScannerUser('si-bs-locked');
    try {
      const barcode = 'BS-LOCKED-' + randomBytes(4).toString('hex').toUpperCase();
      const { data: prod } = await (adminClient as any)
        .schema('chefbyte')
        .from('products')
        .insert({
          user_id: ctx.userId,
          name: 'Locked Product',
          barcode,
          servings_per_container: 1,
          net_weight_g: 100,
        })
        .select('product_id')
        .single();

      // locked_mode='shopping' MUST override body.mode='purchase' — this
      // is the trust boundary: a malicious or stale client cannot bypass
      // the user's explicit lock.
      await (adminClient as any)
        .schema('chefbyte')
        .from('scanner_state')
        .upsert(
          { user_id: ctx.userId, last_active_mode: 'purchase', locked_mode: 'shopping' },
          { onConflict: 'user_id' },
        );

      const res = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.importKey },
        body: JSON.stringify({
          barcode,
          mode: 'purchase', // client tries to override — locked wins
          pi_event_id: 'evt-' + crypto.randomUUID(),
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('applied');
      expect(body.mode).toBe('shopping');
      expect(body.applied_cart_item_id).toBeTruthy();

      const { data: tx } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('mode, applied_cart_item_id, applied_lot_id')
        .eq('transaction_id', body.transaction_id)
        .single();
      expect(tx.mode).toBe('shopping');
      expect(tx.applied_cart_item_id).toBe(body.applied_cart_item_id);
      expect(tx.applied_lot_id).toBeNull();

      // No stock_lot should have been minted (purchase path NOT taken).
      const { data: lots } = await (adminClient as any)
        .schema('chefbyte')
        .from('stock_lots')
        .select('lot_id')
        .eq('user_id', ctx.userId)
        .eq('product_id', prod.product_id);
      expect(lots).toHaveLength(0);

      // Shopping list should have one row.
      const { data: cart } = await (adminClient as any)
        .schema('chefbyte')
        .from('shopping_list')
        .select('cart_item_id, qty_containers')
        .eq('user_id', ctx.userId)
        .eq('product_id', prod.product_id);
      expect(cart).toHaveLength(1);
      expect(cart[0].cart_item_id).toBe(body.applied_cart_item_id);
    } finally {
      await ctx.cleanup();
    }
  });

  it('POST /barcode-scan logs errored transaction when product unknown + analyze fails', async () => {
    const ctx = await provisionScannerUser('si-bs-errored');
    try {
      const barcode = 'BS-UNKNOWN-' + randomBytes(4).toString('hex').toUpperCase();
      // Set last_active_mode so a mode is resolvable even on the error
      // path (the errored row still needs a non-null mode column).
      await (adminClient as any)
        .schema('chefbyte')
        .from('scanner_state')
        .upsert({ user_id: ctx.userId, last_active_mode: 'purchase' }, { onConflict: 'user_id' });

      const res = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.importKey },
        body: JSON.stringify({
          barcode,
          pi_event_id: 'evt-' + crypto.randomUUID(),
        }),
      });
      // We always 200 on errored scans — the audit row is the contract,
      // not the HTTP status (Pi is fire-and-forget; non-200 would
      // trigger client retries that would just create more errored rows).
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('errored');
      expect(body.error_msg).toBeTruthy();
      expect(body.transaction_id).toBeTruthy();

      const { data: tx } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('barcode, status, error_msg, product_id, applied_lot_id, source')
        .eq('transaction_id', body.transaction_id)
        .single();
      expect(tx.barcode).toBe(barcode);
      expect(tx.status).toBe('errored');
      expect(tx.error_msg).toBeTruthy();
      expect(tx.product_id).toBeNull();
      expect(tx.applied_lot_id).toBeNull();
      expect(tx.source).toBe('pi_usb');
    } finally {
      await ctx.cleanup();
    }
  });

  it('POST /barcode-scan accepts JWT (web) auth and stamps source=web', async () => {
    const ctx = await provisionScannerUser('si-bs-web');
    try {
      const barcode = 'BS-WEB-' + randomBytes(4).toString('hex').toUpperCase();
      await (adminClient as any).schema('chefbyte').from('products').insert({
        user_id: ctx.userId,
        name: 'Web Scanner Product',
        barcode,
        servings_per_container: 1,
        net_weight_g: 100,
      });
      await (adminClient as any)
        .schema('chefbyte')
        .from('scanner_state')
        .upsert({ user_id: ctx.userId, last_active_mode: 'purchase' }, { onConflict: 'user_id' });

      const res = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ctx.accessToken}`,
        },
        body: JSON.stringify({ barcode }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('applied');

      const { data: tx } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('source, pi_event_id')
        .eq('transaction_id', body.transaction_id)
        .single();
      expect(tx.source).toBe('web');
      // No pi_event_id on web scans (web doesn't supply it).
      expect(tx.pi_event_id).toBeNull();
    } finally {
      await ctx.cleanup();
    }
  });

  it('POST /barcode-scan rejects requests with neither x-api-key nor JWT', async () => {
    const res = await fetch(`${BASE_URL}/barcode-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barcode: 'NO-AUTH-ATTEMPT' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  // ─── /barcode-scan: edge-side qty validation (audit I-Cloud-3) ─────
  //
  // The RPC accepts NUMERIC(10,3) which would silently absorb negative,
  // zero, or absurdly large values. Validating at the edge BEFORE the
  // RPC fires prevents a misbehaving client (or an upstream Pi bug)
  // from minting corrupt stock_lots / food_logs / cart rows. Each
  // case must return 400 with no DB mutation.
  it('POST /barcode-scan rejects negative qty with 400', async () => {
    const ctx = await provisionScannerUser('si-bs-qty-neg');
    try {
      const barcode = 'BS-QTYNEG-' + randomBytes(4).toString('hex').toUpperCase();
      // Seed product so we can verify NO transaction row was inserted on rejection.
      await (adminClient as any).schema('chefbyte').from('products').insert({
        user_id: ctx.userId,
        name: 'Neg Qty Product',
        barcode,
        servings_per_container: 1,
        net_weight_g: 100,
      });
      const res = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.importKey },
        body: JSON.stringify({ barcode, qty: -1 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('qty');

      // No scan_transactions row created — early reject is pre-RPC.
      const { count } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('transaction_id', { count: 'exact', head: true })
        .eq('user_id', ctx.userId);
      expect(count).toBe(0);
    } finally {
      await ctx.cleanup();
    }
  });

  it('POST /barcode-scan rejects zero qty with 400', async () => {
    const ctx = await provisionScannerUser('si-bs-qty-zero');
    try {
      const barcode = 'BS-QTYZERO-' + randomBytes(4).toString('hex').toUpperCase();
      await (adminClient as any).schema('chefbyte').from('products').insert({
        user_id: ctx.userId,
        name: 'Zero Qty Product',
        barcode,
        servings_per_container: 1,
        net_weight_g: 100,
      });
      const res = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.importKey },
        body: JSON.stringify({ barcode, qty: 0 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('qty');

      const { count } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('transaction_id', { count: 'exact', head: true })
        .eq('user_id', ctx.userId);
      expect(count).toBe(0);
    } finally {
      await ctx.cleanup();
    }
  });

  it('POST /barcode-scan rejects qty above hard ceiling with 400', async () => {
    const ctx = await provisionScannerUser('si-bs-qty-huge');
    try {
      const barcode = 'BS-QTYHUGE-' + randomBytes(4).toString('hex').toUpperCase();
      await (adminClient as any).schema('chefbyte').from('products').insert({
        user_id: ctx.userId,
        name: 'Huge Qty Product',
        barcode,
        servings_per_container: 1,
        net_weight_g: 100,
      });
      const res = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.importKey },
        body: JSON.stringify({ barcode, qty: 99999 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('qty');

      const { count } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('transaction_id', { count: 'exact', head: true })
        .eq('user_id', ctx.userId);
      expect(count).toBe(0);
    } finally {
      await ctx.cleanup();
    }
  });

  // ─── /barcode-scan: edge-side unit validation + atomic apply (H-8) ──
  //
  // H-8 regression: `body.unit` was only `typeof === 'string'`-checked.
  // An invalid unit ('kg') sailed past, execute_scan_action committed a
  // stock change, then the SEPARATE scan_transactions insert hit the
  // unit CHECK and 500'd WITHOUT writing an idempotency row → a Pi retry
  // re-ran the mutation → double mint / double consume. The fix rejects
  // invalid units with 400 BEFORE any mutation AND folds the stock
  // mutation + audit insert into one transaction (execute_scan_and_record).
  it('POST /barcode-scan rejects an invalid unit with 400 and mutates nothing (H-8)', async () => {
    const ctx = await provisionScannerUser('si-bs-unit-bad');
    try {
      const barcode = 'BS-UNITBAD-' + randomBytes(4).toString('hex').toUpperCase();
      const { data: prod } = await (adminClient as any)
        .schema('chefbyte')
        .from('products')
        .insert({
          user_id: ctx.userId,
          name: 'Bad Unit Product',
          barcode,
          servings_per_container: 1,
          net_weight_g: 100,
        })
        .select('product_id')
        .single();
      await (adminClient as any)
        .schema('chefbyte')
        .from('scanner_state')
        .upsert({ user_id: ctx.userId, last_active_mode: 'purchase' }, { onConflict: 'user_id' });

      const piEventId = 'evt-' + crypto.randomUUID();
      const res = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.importKey },
        // 'kg' violates the scan_transactions CHECK (container|serving).
        body: JSON.stringify({ barcode, qty: 1, unit: 'kg', pi_event_id: piEventId }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('unit');

      // CRITICAL: no stock_lot was minted (the pre-fix partial-apply would
      // have committed one before the audit insert failed).
      const { data: lots } = await (adminClient as any)
        .schema('chefbyte')
        .from('stock_lots')
        .select('lot_id')
        .eq('user_id', ctx.userId)
        .eq('product_id', prod.product_id);
      expect(lots).toHaveLength(0);

      // And no scan_transactions row at all (errored OR applied) — early
      // reject is pre-RPC, so there's nothing to dedup AND nothing committed.
      const { count } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('transaction_id', { count: 'exact', head: true })
        .eq('user_id', ctx.userId);
      expect(count).toBe(0);
    } finally {
      await ctx.cleanup();
    }
  });

  it('POST /barcode-scan(purchase) applies stock + records audit row ATOMICALLY (H-8)', async () => {
    const ctx = await provisionScannerUser('si-bs-atomic');
    try {
      const barcode = 'BS-ATOMIC-' + randomBytes(4).toString('hex').toUpperCase();
      const { data: prod } = await (adminClient as any)
        .schema('chefbyte')
        .from('products')
        .insert({
          user_id: ctx.userId,
          name: 'Atomic Purchase Product',
          barcode,
          servings_per_container: 2,
          net_weight_g: 400,
        })
        .select('product_id')
        .single();
      await (adminClient as any)
        .schema('chefbyte')
        .from('scanner_state')
        .upsert({ user_id: ctx.userId, last_active_mode: 'purchase' }, { onConflict: 'user_id' });

      const piEventId = 'evt-' + crypto.randomUUID();
      const res = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.importKey },
        body: JSON.stringify({ barcode, qty: 1, unit: 'container', pi_event_id: piEventId }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('applied');
      expect(body.transaction_id).toBeTruthy();
      expect(body.applied_lot_id).toBeTruthy();

      // The minted lot and the recorded audit row exist and are linked —
      // both written in the single execute_scan_and_record transaction.
      const { data: lots } = await (adminClient as any)
        .schema('chefbyte')
        .from('stock_lots')
        .select('lot_id, qty_containers')
        .eq('user_id', ctx.userId)
        .eq('product_id', prod.product_id);
      expect(lots).toHaveLength(1);
      expect(lots[0].lot_id).toBe(body.applied_lot_id);

      const { data: tx } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('transaction_id, status, applied_lot_id, source, pi_event_id, logical_date')
        .eq('transaction_id', body.transaction_id)
        .single();
      expect(tx.status).toBe('applied');
      expect(tx.applied_lot_id).toBe(body.applied_lot_id);
      expect(tx.source).toBe('pi_usb');
      expect(tx.pi_event_id).toBe(piEventId);
      // logical_date resolved via the profile tz (get_logical_date), not a
      // raw UTC slice — a non-null DATE on the row.
      expect(tx.logical_date).toBeTruthy();

      // A retry with the same pi_event_id is deduped (idempotent) — exactly
      // one applied row, no second lot. Proves the atomic commit closed the
      // double-apply window.
      const retry = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.importKey },
        body: JSON.stringify({ barcode, qty: 1, unit: 'container', pi_event_id: piEventId }),
      });
      const retryBody = await retry.json();
      expect(retryBody.idempotent).toBe(true);
      expect(retryBody.transaction_id).toBe(body.transaction_id);

      const { count: lotCount } = await (adminClient as any)
        .schema('chefbyte')
        .from('stock_lots')
        .select('lot_id', { count: 'exact', head: true })
        .eq('user_id', ctx.userId)
        .eq('product_id', prod.product_id);
      expect(lotCount).toBe(1);
    } finally {
      await ctx.cleanup();
    }
  });

  // ─── /scan-transaction/:id/void: browser-JWT undo ──────────────────
  //
  // Task 6: the Settings → Scanner Transactions tab calls this when
  // the user taps "Void" on an audit row. Behaviour mirrors
  // private.void_scan_transaction:
  //   * purchase           → deletes applied_lot_id stock_lot
  //   * consume_macros     → deletes applied_food_log_id food_log
  //   * shopping           → deletes applied_cart_item_id cart row
  //   * consume_no_macros  → no side-effect rollback (only flips status)
  // Then flips status='voided' on the audit row.
  // Idempotent on already-voided rows.

  it('POST /scan-transaction/:id/void reverses applied_lot_id (purchase)', async () => {
    const ctx = await provisionScannerUser('si-void-purchase');
    try {
      const barcode = 'VOID-PURCH-' + randomBytes(4).toString('hex').toUpperCase();
      const { data: prod } = await (adminClient as any)
        .schema('chefbyte')
        .from('products')
        .insert({
          user_id: ctx.userId,
          name: 'Void Test Product',
          barcode,
          servings_per_container: 2,
          calories_per_serving: 200,
          net_weight_g: 500,
        })
        .select('product_id')
        .single();

      await (adminClient as any)
        .schema('chefbyte')
        .from('scanner_state')
        .upsert({ user_id: ctx.userId, last_active_mode: 'purchase' }, { onConflict: 'user_id' });

      // Apply a scan → mints a stock_lot + scan_transactions row.
      const scanRes = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.importKey },
        body: JSON.stringify({ barcode, pi_event_id: 'evt-' + crypto.randomUUID() }),
      });
      expect(scanRes.status).toBe(200);
      const scanBody = await scanRes.json();
      expect(scanBody.status).toBe('applied');
      const transactionId: string = scanBody.transaction_id;
      const lotId: string = scanBody.applied_lot_id;
      expect(lotId).toBeTruthy();

      // Sanity: the lot exists.
      const { data: lotsBefore } = await (adminClient as any)
        .schema('chefbyte')
        .from('stock_lots')
        .select('lot_id')
        .eq('user_id', ctx.userId)
        .eq('product_id', prod.product_id);
      expect(lotsBefore).toHaveLength(1);
      expect(lotsBefore[0].lot_id).toBe(lotId);

      // Void it.
      const voidRes = await fetch(`${BASE_URL}/scan-transaction/${transactionId}/void`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ctx.accessToken}`,
        },
      });
      expect(voidRes.status).toBe(200);
      const voidBody = await voidRes.json();
      expect(voidBody.ok).toBe(true);
      expect(voidBody.transaction_id).toBe(transactionId);

      // The stock_lot was logically deleted (G1 trigger converts DELETE →
      // soft-delete; row stays with qty=0 + deleted_at=now()). Mirror
      // production reads by filtering deleted_at IS NULL.
      const { data: lotsAfter } = await (adminClient as any)
        .schema('chefbyte')
        .from('stock_lots')
        .select('lot_id')
        .eq('user_id', ctx.userId)
        .eq('product_id', prod.product_id)
        .is('deleted_at', null);
      expect(lotsAfter).toHaveLength(0);

      // The audit row flipped to voided.
      const { data: tx } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('status, applied_lot_id')
        .eq('transaction_id', transactionId)
        .single();
      expect(tx.status).toBe('voided');
      // POST-G1: the BEFORE-DELETE trigger on stock_lots converts the void's
      // DELETE into a soft-delete UPDATE (qty=0 + deleted_at=now()), so the
      // referenced lot row still exists and the FK ON DELETE SET NULL never
      // fires — applied_lot_id remains set. Verify the referenced lot is in
      // fact tombstoned (qty=0, deleted_at not null).
      expect(tx.applied_lot_id).not.toBeNull();
      const { data: tombstoned } = await (adminClient as any)
        .schema('chefbyte')
        .from('stock_lots')
        .select('lot_id, qty_containers, deleted_at')
        .eq('lot_id', tx.applied_lot_id)
        .single();
      expect(Number(tombstoned.qty_containers)).toBe(0);
      expect(tombstoned.deleted_at).not.toBeNull();
    } finally {
      await ctx.cleanup();
    }
  });

  it('POST /scan-transaction/:id/void returns 404 for cross-user attempt', async () => {
    const userA = await provisionScannerUser('si-void-userA');
    const userB = await provisionScannerUser('si-void-userB');
    try {
      // userA creates a transaction.
      const barcode = 'VOID-XU-' + randomBytes(4).toString('hex').toUpperCase();
      await (adminClient as any).schema('chefbyte').from('products').insert({
        user_id: userA.userId,
        name: 'Cross-User Product',
        barcode,
        servings_per_container: 1,
        net_weight_g: 100,
      });
      await (adminClient as any)
        .schema('chefbyte')
        .from('scanner_state')
        .upsert({ user_id: userA.userId, last_active_mode: 'purchase' }, { onConflict: 'user_id' });
      const scanRes = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': userA.importKey },
        body: JSON.stringify({ barcode, pi_event_id: 'evt-' + crypto.randomUUID() }),
      });
      expect(scanRes.status).toBe(200);
      const scanBody = await scanRes.json();
      const transactionId: string = scanBody.transaction_id;

      // userB attempts to void userA's row → 404 (not 403; existence
      // must not leak across users).
      const voidRes = await fetch(`${BASE_URL}/scan-transaction/${transactionId}/void`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userB.accessToken}`,
        },
      });
      expect(voidRes.status).toBe(404);
      const voidBody = await voidRes.json();
      expect(voidBody.error).toBe('not found');

      // userA's row remains 'applied' — the void was rejected.
      const { data: tx } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('status, applied_lot_id')
        .eq('transaction_id', transactionId)
        .single();
      expect(tx.status).toBe('applied');
      expect(tx.applied_lot_id).toBeTruthy();
    } finally {
      await userB.cleanup();
      await userA.cleanup();
    }
  });

  it('POST /scan-transaction/:id/void is idempotent on already-voided rows', async () => {
    const ctx = await provisionScannerUser('si-void-idem');
    try {
      const barcode = 'VOID-IDEM-' + randomBytes(4).toString('hex').toUpperCase();
      await (adminClient as any).schema('chefbyte').from('products').insert({
        user_id: ctx.userId,
        name: 'Idem Void Product',
        barcode,
        servings_per_container: 1,
        net_weight_g: 100,
      });
      await (adminClient as any)
        .schema('chefbyte')
        .from('scanner_state')
        .upsert({ user_id: ctx.userId, last_active_mode: 'purchase' }, { onConflict: 'user_id' });

      const scanRes = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.importKey },
        body: JSON.stringify({ barcode, pi_event_id: 'evt-' + crypto.randomUUID() }),
      });
      expect(scanRes.status).toBe(200);
      const scanBody = await scanRes.json();
      const transactionId: string = scanBody.transaction_id;

      const voidUrl = `${BASE_URL}/scan-transaction/${transactionId}/void`;
      const voidHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.accessToken}`,
      };

      // First call: applied → voided.
      const r1 = await fetch(voidUrl, { method: 'POST', headers: voidHeaders });
      expect(r1.status).toBe(200);
      const b1 = await r1.json();
      expect(b1.ok).toBe(true);

      // Second call: voided → voided (idempotent no-op in
      // private.void_scan_transaction). Same 200 status.
      const r2 = await fetch(voidUrl, { method: 'POST', headers: voidHeaders });
      expect(r2.status).toBe(200);
      const b2 = await r2.json();
      expect(b2.ok).toBe(true);
      expect(b2.transaction_id).toBe(transactionId);

      // Still exactly one row, still status='voided'.
      const { data: tx } = await (adminClient as any)
        .schema('chefbyte')
        .from('scan_transactions')
        .select('status')
        .eq('transaction_id', transactionId)
        .single();
      expect(tx.status).toBe('voided');
    } finally {
      await ctx.cleanup();
    }
  });

  it('POST /scan-transaction/:id/void rejects unauthenticated requests', async () => {
    const fakeId = crypto.randomUUID();
    const res = await fetch(`${BASE_URL}/scan-transaction/${fakeId}/void`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  // Audit I-Cloud-6: pre-fix regex `[0-9a-f-]{36}` matched degenerate
  // strings like 36 dashes, routing them into handleVoidScanTransaction
  // where the non-UUID transaction_id would crash the PostgREST
  // ownership SELECT. With the strict 8-4-4-4-12 regex, malformed paths
  // fall through the dispatcher entirely. With a valid x-api-key, the
  // dispatcher exits at the catch-all 404. With a JWT (no x-api-key),
  // it would 401 — we exercise the 404 branch here because that's the
  // path that previously surfaced 500.
  it('POST /scan-transaction/<invalid-shape>/void falls through to 404', async () => {
    const ctx = await provisionScannerUser('si-void-bad-uuid');
    try {
      // 36 dashes — matched pre-fix loose regex but fails strict
      // 8-4-4-4-12 hex layout.
      const badId = '------------------------------------';
      const res = await fetch(`${BASE_URL}/scan-transaction/${badId}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.importKey },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('not found');
    } finally {
      await ctx.cleanup();
    }
  });

  // CORS preflight regression — the browser preflights any request
  // carrying a non-simple header. supabase-js sends `Authorization`
  // (JWT bearer), `apikey`, and `x-client-info` by default for
  // browser-JWT routes like /scanner-state, all three of which trigger
  // preflight.
  //
  // IMPORTANT: locally, the Supabase Edge Functions gateway intercepts
  // OPTIONS preflights and echoes back whatever was in
  // `Access-Control-Request-Headers`. The function's own OPTIONS handler
  // doesn't run. So this integration test only verifies the round-trip
  // works for a browser-shaped request — it does NOT verify the
  // function's source-code constant. A separate unit test on the
  // `corsHeaders` constant value (`shelf-ingest-cors.test.ts`) pins the
  // production-deployed function's allow-list. The combination covers
  // both "gateway behaves" (here) and "function returns the right
  // headers if hit directly" (constant test).
  describe('CORS preflight', () => {
    const browserPreflightHeaders = (origin: string) => ({
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      // Mirror what supabase-js sends from a browser context.
      'Access-Control-Request-Headers': 'authorization,apikey,content-type,x-client-info',
    });

    it('OPTIONS /scanner-state allows the supabase-js header set', async () => {
      const res = await fetch(`${BASE_URL}/scanner-state`, {
        method: 'OPTIONS',
        headers: browserPreflightHeaders('https://lunahub.dev'),
      });
      expect(res.status).toBe(200);
      const allowHeaders = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
      // Headers we asked the browser to allow MUST come back in the
      // allow-list — otherwise supabase-js's POST is blocked.
      expect(allowHeaders).toContain('authorization');
      expect(allowHeaders).toContain('apikey');
      expect(allowHeaders).toContain('content-type');
      expect(allowHeaders).toContain('x-client-info');
    });

    it('OPTIONS /barcode-scan allows both auth schemes', async () => {
      // /barcode-scan accepts EITHER x-api-key (Pi) or Authorization
      // bearer (web). Send both via the preflight; both must come back.
      const res = await fetch(`${BASE_URL}/barcode-scan`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://lunahub.dev',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,x-api-key,content-type',
        },
      });
      expect(res.status).toBe(200);
      const allowHeaders = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
      expect(allowHeaders).toContain('authorization');
      expect(allowHeaders).toContain('x-api-key');
    });

    it('OPTIONS /scan-transaction/<id>/void allows authorization', async () => {
      const fakeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const res = await fetch(`${BASE_URL}/scan-transaction/${fakeId}/void`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://lunahub.dev',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      });
      expect(res.status).toBe(200);
      const allowHeaders = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
      expect(allowHeaders).toContain('authorization');
    });
  });
});
