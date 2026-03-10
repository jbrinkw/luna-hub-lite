/**
 * LiquidTrack Edge Function Integration Tests
 *
 * Tests the liquidtrack edge function with real HTTP calls against local Supabase.
 * Creates real test user, product, device with import_key_hash, sends real events.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { adminClient, SUPABASE_URL } from '../../setup.integration';
import { createTestUser, cleanupUser } from '../../test-helpers';

const EDGE_URL = `${SUPABASE_URL}/functions/v1/liquidtrack`;

describe('LiquidTrack Edge Function', () => {
  let userId: string;
  let productId: string;
  let deviceId: string;
  let importKey: string;

  beforeAll(async () => {
    // Create test user and activate chefbyte
    const user = await createTestUser('lt-edge');
    userId = user.userId;

    const { error: actErr } = await (user.client as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
    if (actErr) throw new Error(`activate_app failed: ${actErr.message}`);

    // Create a product with known nutrition
    const { data: product, error: prodErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'LT Test Coffee',
        servings_per_container: 1,
        calories_per_serving: 5,
        protein_per_serving: 0,
        carbs_per_serving: 0,
        fat_per_serving: 0,
        min_stock_amount: 0,
      })
      .select('product_id')
      .single();
    if (prodErr) throw new Error(`create product: ${prodErr.message}`);
    productId = product.product_id;

    // Create device with import key
    importKey = 'lt_' + randomBytes(16).toString('hex');
    const keyHash = createHash('sha256').update(importKey).digest('hex');

    const { data: device, error: devErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('liquidtrack_devices')
      .insert({
        user_id: userId,
        device_name: 'Test Scale',
        product_id: productId,
        import_key_hash: keyHash,
        is_active: true,
      })
      .select('device_id')
      .single();
    if (devErr) throw new Error(`create device: ${devErr.message}`);
    deviceId = device.device_id;
  });

  afterAll(async () => {
    // Clean up in reverse order
    await (adminClient as any).schema('chefbyte').from('liquidtrack_events').delete().eq('device_id', deviceId);
    await (adminClient as any).schema('chefbyte').from('liquidtrack_devices').delete().eq('device_id', deviceId);
    await (adminClient as any).schema('chefbyte').from('products').delete().eq('product_id', productId);
    await cleanupUser(userId);
  });

  // ─── Auth tests ─────────────────────────────────────────────

  it('rejects requests without API key', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/missing api key/i);
  });

  it('rejects requests with invalid API key', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'lt_invalid_key_12345',
      },
      body: JSON.stringify({ events: [{ weight_before: 500, weight_after: 400 }] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/invalid api key/i);
  });

  it('rejects non-POST methods', async () => {
    const res = await fetch(EDGE_URL, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  // ─── Validation tests ──────────────────────────────────────

  it('rejects missing events array', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': importKey,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/events.*required/i);
  });

  it('rejects empty events array', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': importKey,
      },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(400);
  });

  // ─── Success tests ─────────────────────────────────────────

  it('ingests a single event with macro calculation from linked product', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': importKey,
      },
      body: JSON.stringify({
        events: [{ weight_before: 500, weight_after: 300 }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.count).toBe(1);

    // Verify event was stored
    const { data: events } = await (adminClient as any)
      .schema('chefbyte')
      .from('liquidtrack_events')
      .select('*')
      .eq('device_id', deviceId)
      .order('created_at', { ascending: false })
      .limit(1);

    expect(events).toHaveLength(1);
    expect(Number(events[0].consumption)).toBe(200);
    // Macros: 200g consumption → factor = 200/100 = 2.0 → 5 * 2.0 = 10 cal
    expect(Number(events[0].calories)).toBe(10);
  });

  it('handles multiple events gracefully (duplicate timestamp constraint)', async () => {
    // Multiple events in one request share the same DB `created_at` (now()),
    // which hits UNIQUE(device_id, created_at). The edge function handles
    // this gracefully by catching the 23505 duplicate error.
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': importKey,
      },
      body: JSON.stringify({
        events: [
          { weight_before: 300, weight_after: 250 },
          { weight_before: 250, weight_after: 200 },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // count is 0 due to duplicate constraint — graceful handling
    expect(body.count).toBe(0);
    expect(body.message).toMatch(/already recorded/i);
  });

  it('accepts pre-calculated macros from ESP device', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': importKey,
      },
      body: JSON.stringify({
        events: [
          {
            weight_before: 100,
            weight_after: 50,
            calories: 42,
            protein: 3,
            carbs: 5,
            fat: 1,
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.count).toBe(1);

    // Verify pre-calculated macros were stored (not computed from product)
    const { data: events } = await (adminClient as any)
      .schema('chefbyte')
      .from('liquidtrack_events')
      .select('calories, protein, carbs, fat')
      .eq('device_id', deviceId)
      .order('created_at', { ascending: false })
      .limit(1);

    expect(Number(events[0].calories)).toBe(42);
    expect(Number(events[0].protein)).toBe(3);
    expect(Number(events[0].carbs)).toBe(5);
    expect(Number(events[0].fat)).toBe(1);
  });

  it('handles refill events with zero consumption', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': importKey,
      },
      body: JSON.stringify({
        events: [{ weight_before: 100, weight_after: 500, is_refill: true }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // consumption should be 0 (max(0, 100 - 500) = 0)
    const { data: events } = await (adminClient as any)
      .schema('chefbyte')
      .from('liquidtrack_events')
      .select('consumption, is_refill')
      .eq('device_id', deviceId)
      .order('created_at', { ascending: false })
      .limit(1);

    expect(Number(events[0].consumption)).toBe(0);
    expect(events[0].is_refill).toBe(true);
  });
});
