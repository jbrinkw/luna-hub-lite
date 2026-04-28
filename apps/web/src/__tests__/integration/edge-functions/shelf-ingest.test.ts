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

    // apply_shelf_event scopes its SELECT on (product_id, user_id); the
    // row lookup finds no match, so it returns applied=false with the
    // new distinct reason.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.reason).toMatch(/product not found/i);

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

  it('POST /event live_scale refilled CLAIMS an empty lot via apply_live_scale_measurement (single_track-never-mints)', async () => {
    // Production repro (2026-04-22): chocolate-milk lot depleted to
    // qty=0 on live_shelf, next event was a live_scale refill on
    // scale-03 paired to the same product.
    //
    // Pre-fix history:
    //   * Original bug (2026-04-22): the old resolver fell through to
    //     a MINT which violated stock_lots_merge_key → 500 → Pi outbox
    //     stalled.
    //   * Migration 20260425070000 added empty-lot reuse to the
    //     resolver — fixed the 500, but still let live_scale create
    //     phantom rows in OTHER scenarios.
    //   * Migration 20260428060000 (single_track-never-mints) routes
    //     live_scale ADDs through private.apply_live_scale_measurement
    //     which uses SET semantics + claim-or-ignore. NEVER mints.
    //
    // Under the new rule the chocolate-milk scenario works like this:
    //   - User pairs scale-03 to product (scale_pairings row created
    //     with lot_id=NULL). This is what the wizard does when the
    //     user runs the LiveTrack pair flow.
    //   - User places fresh bottle on the scale.
    //   - apply_live_scale_measurement sees no pinned lot, finds the
    //     existing (empty) lot of the product, claims it via
    //     scale_pairings.lot_id update, SETs qty := after_weight/net_g.
    //
    // This test pins that contract. A regression that re-introduces
    // the resolver-mint path for live_scale (or removes the pairing
    // requirement) trips the assertions.
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

    // NEW (single_track-never-mints): the wizard creates a
    // scale_pairings row when the user pairs the scale to a product.
    // Without this row, the apply path correctly REJECTS the event
    // with reason='live_scale_no_pairing_ignore'. Seed the row with
    // lot_id=NULL so the apply path exercises the claim branch.
    const { data: device } = await (adminClient as any)
      .schema('chefbyte')
      .from('live_shelf_devices')
      .select('device_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .single();

    await (adminClient as any).schema('chefbyte').from('scale_pairings').insert({
      user_id: userId,
      device_id: device.device_id,
      scale_id: 'scale-revive-03',
      kind: 'live_scale',
      product_id: prod.product_id,
      lot_id: null,
    });

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
        after_weight_g: 1000, // SET target
        occurred_at: new Date().toISOString(),
        client_event_id: clientEventId,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(true);
    // The empty lot was claimed + revived to qty=1, not a new one minted.
    expect(body.resolved_lot_id).toBe(emptyLot.lot_id);

    const { data: logRow } = await (adminClient as any)
      .schema('chefbyte')
      .from('shelf_event_log')
      .select('applied, reason, resolved_lot_id')
      .eq('user_id', userId)
      .eq('client_event_id', clientEventId)
      .single();
    expect(logRow).toBeTruthy();
    expect(logRow.applied).toBe(true);
    // SET-semantics fingerprint — was 'revived_empty_lot' before the
    // single_track-never-mints fix, is 'live_scale_claimed_and_set'
    // now (the claim path also covers the formerly-empty lot scenario).
    expect(logRow.reason).toBe('live_scale_claimed_and_set');
    expect(logRow.resolved_lot_id).toBe(emptyLot.lot_id);

    // Empty lot now has stock — SET qty := 1000g / net(1000g) = 1.000.
    const { data: revivedLot } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('qty_containers, last_update_source')
      .eq('lot_id', emptyLot.lot_id)
      .single();
    expect(Number(revivedLot.qty_containers)).toBeCloseTo(1.0, 3);
    expect(revivedLot.last_update_source).toBe('live_scale');

    // Pairing's lot_id was claimed during apply.
    const { data: pairing } = await (adminClient as any)
      .schema('chefbyte')
      .from('scale_pairings')
      .select('lot_id')
      .eq('user_id', userId)
      .eq('scale_id', 'scale-revive-03')
      .eq('kind', 'live_scale')
      .single();
    expect(pairing.lot_id).toBe(emptyLot.lot_id);

    // Exactly one lot for this product: the claimed one. NO new row
    // minted — the no-mint rule.
    const { data: allLots } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('lot_id')
      .eq('user_id', userId)
      .eq('product_id', prod.product_id);
    expect(allLots.length).toBe(1);

    // Cleanup
    await (adminClient as any)
      .schema('chefbyte')
      .from('scale_pairings')
      .delete()
      .eq('user_id', userId)
      .eq('scale_id', 'scale-revive-03');
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

  it('POST /heartbeat rejects oversized scale_id (>128 chars) with 400', async () => {
    const hugeId = 'y'.repeat(129);
    const res = await fetch(`${BASE_URL}/heartbeat`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        pending_review_count: 0,
        scales: [{ scale_id: hugeId, kind: 'live_shelf' }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/scale_id/i);
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
});
