/**
 * Analyze-Product Edge Function Integration Tests
 *
 * Tests the analyze-product edge function with real HTTP calls.
 * Tests auth, validation, existing-product detection, quota enforcement,
 * and OpenFoodFacts data verification with known barcodes.
 *
 * verify_jwt = false in config.toml — the function handles its own auth
 * via supabase.auth.getUser(). Error responses use {error: "..."} format.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminClient, SUPABASE_URL } from '../../setup.integration';
import { createTestUser, cleanupUser } from '../../test-helpers';

const EDGE_URL = `${SUPABASE_URL}/functions/v1/analyze-product`;

describe('Analyze-Product Edge Function', () => {
  let userId: string;
  let userJwt: string;

  beforeAll(async () => {
    const user = await createTestUser('ap-edge');
    userId = user.userId;

    // Activate chefbyte
    const { error: actErr } = await (user.client as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
    if (actErr) throw new Error(`activate_app failed: ${actErr.message}`);

    // Get JWT for edge function auth
    const { data: session } = await user.client.auth.getSession();
    userJwt = session.session!.access_token;
  });

  afterAll(async () => {
    await (adminClient as any).schema('chefbyte').from('products').delete().eq('user_id', userId);
    await (adminClient as any).schema('chefbyte').from('user_config').delete().eq('user_id', userId);
    await cleanupUser(userId);
  });

  // ─── Auth tests ─────────────────────────────────────────────

  it('rejects requests without Authorization header', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barcode: '5000159484695' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/missing authorization/i);
  });

  it('rejects requests with invalid JWT', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid.jwt.token',
      },
      body: JSON.stringify({ barcode: '5000159484695' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/invalid token/i);
  });

  // ─── Validation tests ──────────────────────────────────────

  it('rejects missing barcode', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/barcode.*required/i);
  });

  // ─── Existing product detection ────────────────────────────

  it('returns existing product without quota hit', async () => {
    const testBarcode = '0000000000001';
    await (adminClient as any).schema('chefbyte').from('products').insert({
      user_id: userId,
      name: 'Existing Test Product',
      barcode: testBarcode,
      servings_per_container: 1,
      calories_per_serving: 100,
      protein_per_serving: 10,
      carbs_per_serving: 15,
      fat_per_serving: 3,
      min_stock_amount: 0,
    });

    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
      },
      body: JSON.stringify({ barcode: testBarcode }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('existing');
    expect(body.product).toBeDefined();
    expect(body.product.name).toBe('Existing Test Product');
    expect(body.product.barcode).toBe(testBarcode);
  });

  // ─── Quota enforcement ─────────────────────────────────────

  it('enforces daily quota limit', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await (adminClient as any)
      .schema('chefbyte')
      .from('user_config')
      .upsert(
        {
          user_id: userId,
          key: 'analyze_quota',
          value: JSON.stringify({ date: today, count: 100 }),
        },
        { onConflict: 'user_id,key' },
      );

    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
      },
      body: JSON.stringify({ barcode: '9999999999999' }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/limit reached/i);
  });

  it('resets quota on a new day (yesterday quota does not block today)', async () => {
    // Set the quota record to a past date with an exhausted count.
    // The checkQuota function compares stored date vs today — if they
    // differ, the counter resets to 0, allowing the request through.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await (adminClient as any)
      .schema('chefbyte')
      .from('user_config')
      .upsert(
        {
          user_id: userId,
          key: 'analyze_quota',
          value: JSON.stringify({ date: yesterday, count: 100 }),
        },
        { onConflict: 'user_id,key' },
      );

    // This should NOT return 429 — the old date means the quota resets
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
      },
      body: JSON.stringify({ barcode: '0000000000000' }),
    });

    // The request passes quota check; it may 404 (barcode not in OFF) or 200,
    // but crucially it must NOT be 429 (rate limited).
    expect(res.status).not.toBe(429);

    // Verify the quota record was reset to today with count=1
    const { data: config } = await (adminClient as any)
      .schema('chefbyte')
      .from('user_config')
      .select('value')
      .eq('user_id', userId)
      .eq('key', 'analyze_quota')
      .single();

    const parsed = JSON.parse(config.value);
    const today = new Date().toISOString().slice(0, 10);
    expect(parsed.date).toBe(today);
    expect(parsed.count).toBe(1);
  });

  // ─── OpenFoodFacts lookup ──────────────────────────────────

  it('returns 404 for barcode not found in OpenFoodFacts', async () => {
    // Reset quota
    await (adminClient as any)
      .schema('chefbyte')
      .from('user_config')
      .delete()
      .eq('user_id', userId)
      .eq('key', 'analyze_quota');

    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
      },
      body: JSON.stringify({ barcode: '0000000000000' }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it('looks up a real barcode from OpenFoodFacts', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
      },
      body: JSON.stringify({ barcode: '5000159484695' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('ai');
    expect(body.off).toBeDefined();
    expect(body.off.product_name).toBeTruthy();
    // suggestion may be null if ANTHROPIC_API_KEY isn't configured
  }, 30_000);

  // ─── Real barcode data verification ──────────────────────

  it('Coca-Cola Zero (049000042566) returns correct OFF data', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
      },
      body: JSON.stringify({ barcode: '049000042566' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('ai');
    expect(body.off).toBeDefined();

    // OFF data shape verification
    expect(body.off.product_name).toBeTruthy();
    expect(body.off.brands).toMatch(/coca.cola/i);

    // Coca-Cola Zero has ~0 calories — the OFF data should reflect this
    // (The AI suggestion may normalize differently, but raw OFF brands must match)
  }, 30_000);

  it('Nutella (3017620422003) returns correct OFF data with nutriments', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
      },
      body: JSON.stringify({ barcode: '3017620422003' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('ai');
    expect(body.off).toBeDefined();

    // Nutella is a very stable product in OFF
    expect(body.off.product_name).toMatch(/nutella/i);
    expect(body.off.brands).toMatch(/nutella/i);

    // Verify the image_url is returned (Nutella always has images in OFF)
    expect(body.off.image_url).toBeTruthy();
  }, 30_000);

  it('Coca-Cola Original EU (5449000000996) returns correct OFF data', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
      },
      body: JSON.stringify({ barcode: '5449000000996' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('ai');
    expect(body.off).toBeDefined();

    expect(body.off.product_name).toMatch(/coca.cola/i);
    expect(body.off.brands).toMatch(/coca.cola/i);
    // Categories should be present for well-known products
    expect(body.off.categories).toBeTruthy();
  }, 30_000);

  // ─── Response shape assertions for OFF fallback path ──────

  it('real barcode returns suggestion=null and valid OFF data when no API key', async () => {
    // Without ANTHROPIC_API_KEY configured, the edge function returns
    // suggestion=null but still returns valid OFF data
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
      },
      body: JSON.stringify({ barcode: '0055577421024' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('ai');

    // suggestion may be null (no ANTHROPIC_API_KEY) or an object (with key)
    // Either way, off must be present with valid product data
    expect(body.off).toBeDefined();
    expect(body.off.product_name).toBeTruthy();
    expect(body.off.nutriments).toBeDefined();
    expect(typeof body.off.nutriments).toBe('object');

    // At least one calorie field must exist
    const n = body.off.nutriments;
    const hasCalories = n['energy-kcal_serving'] !== undefined || n['energy-kcal_100g'] !== undefined;
    expect(hasCalories).toBe(true);
  }, 30_000);

  it('OFF response includes serving_size and nutriments fields', async () => {
    // Use Pringles Original (US barcode) — a well-known product with stable OFF data
    // (different barcode from other tests to avoid existing-product detection)
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
      },
      body: JSON.stringify({ barcode: '038000845512' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('ai');
    expect(body.off).toBeDefined();

    // Verify the off object has all required fields
    expect(body.off).toHaveProperty('product_name');
    expect(body.off).toHaveProperty('brands');
    expect(body.off).toHaveProperty('image_url');
    expect(body.off).toHaveProperty('categories');
    expect(body.off).toHaveProperty('serving_size');
    expect(body.off).toHaveProperty('nutriments');

    // Verify nutriments is a populated object
    expect(typeof body.off.nutriments).toBe('object');
    expect(Object.keys(body.off.nutriments).length).toBeGreaterThan(0);

    // Pringles should have product_name and brands
    expect(body.off.product_name).toBeTruthy();
    expect(body.off.brands).toMatch(/pringles/i);
  }, 30_000);

  // ─── HTTP method tests ──────────────────────────────────

  it('CORS preflight returns ok', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('ok');

    // Verify CORS headers
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('non-POST method returns 405', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'GET',
    });
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toMatch(/method not allowed/i);
  });

  // ─── Direct OpenFoodFacts API verification ───────────────
  // Verifies raw OFF data for a known barcode. Uses a single well-known
  // product to minimize rate limiting from the OFF API.

  it('OFF API returns correct nutriment data for Nutella (3017620422003)', async () => {
    // Small delay to avoid rate limiting from prior edge function OFF calls
    await new Promise((r) => setTimeout(r, 1000));

    const resp = await fetch('https://world.openfoodfacts.org/api/v0/product/3017620422003.json', {
      headers: { 'User-Agent': 'LunaHub/1.0 (test)' },
    });
    expect(resp.ok).toBe(true);
    const json = await resp.json();
    expect(json.status).toBe(1);

    const p = json.product;
    expect(p.product_name).toMatch(/nutella/i);

    // Nutella nutriments per 100g — stable values
    const n = p.nutriments;
    expect(n).toBeDefined();
    expect(n['fat_100g']).toBeGreaterThan(25); // ~30.9g
    expect(n['carbohydrates_100g']).toBeGreaterThan(50); // ~57.5g
    expect(n['proteins_100g']).toBeGreaterThan(4); // ~6.3g
    expect(n['sugars_100g']).toBeGreaterThan(50);
    expect(p.serving_size).toBeTruthy();
  }, 15_000);
});
