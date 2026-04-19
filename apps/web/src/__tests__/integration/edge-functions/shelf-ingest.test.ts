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
    // Second call: cached result, no re-mutation.
    expect(b2.applied).toBe(false);
    expect(b2.reason).toMatch(/duplicate/i);

    // Verify stock mutated exactly once (qty decreased by 0.1, not 0.2).
    const { data: after } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('qty_containers')
      .eq('lot_id', lotId)
      .single();
    expect(Number(after.qty_containers)).toBeCloseTo(qtyBefore - 0.1, 3);
  });

  // ─── /event — zero-qty lot bug ────────────────────────────────

  it('POST /event added with only zero-qty lots creates a NEW lot (does not resurrect the empty one)', async () => {
    // Fresh product for this test so we control all lots.
    const { data: prod } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Refill Test Chips',
        barcode: 'SI-REFILL-TEST',
        servings_per_container: 1,
        net_weight_g: 100,
      })
      .select('product_id')
      .single();

    // Empty lot (qty = 0) — simulates a fully depleted product still
    // visible in history.
    const { data: emptyLot } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .insert({
        user_id: userId,
        product_id: prod.product_id,
        location_id: locationId,
        qty_containers: 0,
      })
      .select('lot_id')
      .single();

    const res = await fetch(`${BASE_URL}/event`, {
      method: 'POST',
      headers: authHeaders(importKey),
      body: JSON.stringify({
        scale_id: 'scale-refill',
        kind: 'live_shelf',
        event_kind: 'added',
        product_id: prod.product_id,
        delta_g: 100, // +1 container
        occurred_at: new Date().toISOString(),
        client_event_id: crypto.randomUUID(),
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
    // The zero-qty lot must NOT have been picked.
    expect(body.resolved_lot_id).not.toBe(emptyLot.lot_id);
    expect(body.reason).toMatch(/new lot created/i);

    // Verify the empty lot is still empty.
    const { data: stillEmpty } = await (adminClient as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('qty_containers')
      .eq('lot_id', emptyLot.lot_id)
      .single();
    expect(Number(stillEmpty.qty_containers)).toBe(0);

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
});
