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

// Live-OpenFoodFacts gate. The handful of tests below assert against the
// real OFF API response shape (Coca-Cola Zero, Nutella, Pringles, etc.).
// They flake under OFF rate limiting and intermittent 5xx, which is the
// reason the unit + integration CI jobs were disabled in commit c932227.
//
// Restoration plan (2026-04-27): keep the assertions as-is, gate them
// behind RUN_LIVE_OFF=1 so CI skips by default. Local devs and the
// nightly audit runner can opt in with `RUN_LIVE_OFF=1 pnpm test:integration`.
//
// The non-OFF tests (auth, validation, quota, CORS, failure paths via
// `x-test-force-failure`) keep running unconditionally — they exercise
// the edge function + Supabase + DB + RLS chain without depending on
// any live external API.
const RUN_LIVE_OFF = process.env.RUN_LIVE_OFF === '1';
const skipLiveOff = !RUN_LIVE_OFF;

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

    // Use the canned OFF response so the request gets PAST the OFF stage
    // (which is where quota is now consumed — see 2026-04-21 failure-path
    // guards). Without the canned header, a fresh barcode 404s before
    // quota is charged, which is the new (correct) behavior but defeats
    // this test's yesterday→today reset assertion.
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
        'x-test-off-mode': 'canned',
      },
      body: JSON.stringify({ barcode: 'TESTQUOTARESET' }),
    });

    // Must NOT be 429 (quota was stale so the counter resets to 0).
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

  it.skipIf(skipLiveOff)('returns 404 for barcode not found in OpenFoodFacts', async () => {
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

  it.skipIf(skipLiveOff)(
    'looks up a real barcode from OpenFoodFacts',
    async () => {
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
    },
    30_000,
  );

  // ─── Real barcode data verification ──────────────────────

  it.skipIf(skipLiveOff)(
    'Coca-Cola Zero (049000042566) returns correct OFF data',
    async () => {
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
    },
    30_000,
  );

  it.skipIf(skipLiveOff)(
    'Nutella (3017620422003) returns correct OFF data with nutriments',
    async () => {
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
    },
    30_000,
  );

  it.skipIf(skipLiveOff)(
    'Coca-Cola Original EU (5449000000996) returns correct OFF data',
    async () => {
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
    },
    30_000,
  );

  // ─── Response shape assertions for OFF fallback path ──────

  it.skipIf(skipLiveOff)(
    'real barcode returns suggestion=null and valid OFF data when no API key',
    async () => {
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
    },
    30_000,
  );

  it.skipIf(skipLiveOff)(
    'OFF response includes serving_size and nutriments fields',
    async () => {
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
    },
    30_000,
  );

  // ─── HTTP method tests ──────────────────────────────────

  it('CORS preflight returns ok', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('ok');

    // Verify CORS headers. supabase-js sends Authorization + x-client-info +
    // apikey + content-type on every browser call — ALL four must appear in
    // Access-Control-Allow-Headers or the preflight fails silently and the
    // scanner falls back to an "Unknown (barcode)" placeholder.
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    const allowed = res.headers.get('Access-Control-Allow-Headers')!.toLowerCase();
    expect(allowed).toContain('authorization');
    expect(allowed).toContain('x-client-info');
    expect(allowed).toContain('apikey');
    expect(allowed).toContain('content-type');
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

  it.skipIf(skipLiveOff)(
    'OFF API returns correct nutriment data for Nutella (3017620422003)',
    async () => {
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
    },
    15_000,
  );
});

/**
 * ─── Failure-path regression guards ───────────────────────────────────
 *
 * These tests exercise the upstream-failure branches added after the
 * 2026-04-21 E2E audit (#1 HIGH risk: "analyze-product failure paths are
 * not exercised"). Failures are injected via the `x-test-force-failure`
 * request header, which the edge fn only honors when
 * SUPABASE_URL points at local (see isLocalDev() in the fn source).
 *
 * Production requests that send the header are silently ignored.
 */
describe('Analyze-Product Edge Function — failure paths', () => {
  let userId: string;
  let userJwt: string;

  async function getQuotaCount(): Promise<number> {
    const { data } = await (adminClient as any)
      .schema('chefbyte')
      .from('user_config')
      .select('value')
      .eq('user_id', userId)
      .eq('key', 'analyze_quota')
      .maybeSingle();
    if (!data?.value) return 0;
    try {
      const parsed = JSON.parse(data.value);
      const today = new Date().toISOString().slice(0, 10);
      return parsed.date === today ? (parsed.count ?? 0) : 0;
    } catch {
      return 0;
    }
  }

  async function resetQuota(): Promise<void> {
    await (adminClient as any)
      .schema('chefbyte')
      .from('user_config')
      .delete()
      .eq('user_id', userId)
      .eq('key', 'analyze_quota');
  }

  beforeAll(async () => {
    const user = await createTestUser('ap-fail');
    userId = user.userId;
    const { error: actErr } = await (user.client as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
    if (actErr) throw new Error(`activate_app failed: ${actErr.message}`);
    const { data: session } = await user.client.auth.getSession();
    userJwt = session.session!.access_token;
  });

  afterAll(async () => {
    await (adminClient as any).schema('chefbyte').from('products').delete().eq('user_id', userId);
    await (adminClient as any).schema('chefbyte').from('user_config').delete().eq('user_id', userId);
    await cleanupUser(userId);
  });

  // ─── OFF 503 — upstream OpenFoodFacts outage ──────────────
  it('OFF 503: returns structured 503 with ai_degraded=true, quota NOT consumed', async () => {
    await resetQuota();
    const quotaBefore = await getQuotaCount();

    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
        'x-test-force-failure': 'off_503',
      },
      // Use a fresh barcode not in OFF so we're not hitting the existing-
      // product short-circuit. Failure fires before OFF is actually called.
      body: JSON.stringify({ barcode: 'TESTFAIL503A' }),
    });

    expect(res.status).toBe(503);
    expect(res.status).not.toBe(500); // explicit: not a generic server error
    const body = await res.json();
    expect(body.ai_degraded).toBe(true);
    expect(body.ai_reason).toBe('off_unavailable');
    expect(body.error).toMatch(/openfoodfacts|unavailable/i);

    // Quota invariant: not consumed on upstream failure.
    const quotaAfter = await getQuotaCount();
    expect(quotaAfter).toBe(quotaBefore);
  }, 15_000);

  // ─── OFF malformed body ──────────────────────────────────
  it('OFF malformed body: returns structured 503 (not 500), quota NOT consumed', async () => {
    await resetQuota();
    const quotaBefore = await getQuotaCount();

    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
        'x-test-force-failure': 'off_malformed',
      },
      body: JSON.stringify({ barcode: 'TESTFAILPARSEA' }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ai_reason).toBe('off_unavailable');

    const quotaAfter = await getQuotaCount();
    expect(quotaAfter).toBe(quotaBefore);
  }, 15_000);

  // ─── Anthropic timeout — SOFT failure, OFF still present ────
  //
  // Uses `x-test-off-mode: canned` so the OFF lookup returns a
  // deterministic shape regardless of OFF uptime (the real OFF API
  // rate-limits aggressively under test traffic). The
  // `x-test-force-failure: anthropic_timeout` header triggers the
  // simulated timeout in normalizeWithAI(). Together these exercise the
  // exact soft-degrade branch the production scanner falls through to.
  it('Anthropic timeout: returns 200 with ai_degraded=true + OFF data; quota consumed once', async () => {
    await resetQuota();
    const quotaBefore = await getQuotaCount();

    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
        'x-test-force-failure': 'anthropic_timeout',
        'x-test-off-mode': 'canned',
      },
      body: JSON.stringify({ barcode: 'TESTTIMEOUT0001' }),
    });

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(500);
    const body = await res.json();
    expect(body.source).toBe('ai');
    expect(body.ai_degraded).toBe(true);
    expect(body.ai_reason).toBe('timeout');
    expect(body.suggestion).toBeNull();

    // OFF fallback data must be present so the scanner can still
    // build a product from nutriments. Canned shape matches Nutella.
    expect(body.off).toBeDefined();
    expect(body.off.product_name).toMatch(/nutella/i);
    expect(body.off.nutriments).toBeDefined();

    // Quota consumed exactly once (OFF succeeded → quota charged).
    const quotaAfter = await getQuotaCount();
    expect(quotaAfter).toBe(quotaBefore + 1);
  }, // 25s Anthropic timeout + buffer. We short-circuit so this resolves
  // immediately in practice.
  15_000);

  // ─── Anthropic returns malformed JSON — SOFT failure ─────
  it('Anthropic malformed JSON: does not 500, returns degraded state with OFF fallback', async () => {
    await resetQuota();
    const quotaBefore = await getQuotaCount();

    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
        'x-test-force-failure': 'anthropic_malformed',
        'x-test-off-mode': 'canned',
      },
      body: JSON.stringify({ barcode: 'TESTMALFORM0001' }),
    });

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(500);
    const body = await res.json();
    expect(body.source).toBe('ai');
    // `anthropic_malformed` mirrors the real JSON.parse-failure branch
    // which returns null suggestion. The main handler only sets
    // ai_degraded when the function THREW; a returned null counts as
    // a successful (but useless) suggestion. Either way the shape
    // must include valid OFF data so the scanner keeps working.
    expect(body.suggestion).toBeNull();
    expect(body.off).toBeDefined();
    expect(body.off.nutriments).toBeDefined();

    // Quota consumed (OFF succeeded).
    const quotaAfter = await getQuotaCount();
    expect(quotaAfter).toBe(quotaBefore + 1);
  }, 15_000);

  // ─── Placeholder resurrection (audit item #31) ───────────
  // A placeholder row from an earlier FAILED analyze call must be UPDATED
  // (not duplicated) when the retry succeeds. Guards the
  // `UNIQUE(user_id, barcode) WHERE barcode IS NOT NULL` invariant.
  it('ai_degraded placeholder resurrection: retry UPDATES existing row, no duplicate', async () => {
    await resetQuota();
    const barcode = 'TESTRESURRECT001';

    // Seed a placeholder row as if a prior analyze failed. Matches the
    // scanner's `is_placeholder = true` path documented in
    // docs/apps/chefbyte.md.
    const { data: seed, error: seedErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Unknown Product',
        barcode,
        servings_per_container: 1,
        calories_per_serving: 0,
        protein_per_serving: 0,
        carbs_per_serving: 0,
        fat_per_serving: 0,
        min_stock_amount: 0,
        is_placeholder: true,
      })
      .select('product_id')
      .single();
    if (seedErr) throw new Error(`seed placeholder: ${seedErr.message}`);
    const placeholderId = seed.product_id;

    // Assert exactly one row before retry.
    const { data: beforeRows } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .select('product_id')
      .eq('user_id', userId)
      .eq('barcode', barcode);
    expect(beforeRows).toHaveLength(1);

    // Retry scan. The edge fn's existing-product short-circuit returns
    // the placeholder row (source=existing). That is the exact behavior
    // the scanner relies on to UPDATE in place — the placeholder's
    // product_id is reused, never duplicated.
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
      },
      body: JSON.stringify({ barcode }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('existing');
    expect(body.product.product_id).toBe(placeholderId);

    // Simulate the scanner's completion step — update the same row to
    // real values (the app uses `supabase.from('products').update(...)
    // .eq('product_id', placeholderId)`, never another insert).
    const { error: updateErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .update({
        name: 'Resurrected Product',
        calories_per_serving: 150,
        is_placeholder: false,
      })
      .eq('product_id', placeholderId);
    expect(updateErr).toBeNull();

    // Assert still exactly one row after retry — no duplicate.
    const { data: afterRows } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .select('product_id, is_placeholder, name')
      .eq('user_id', userId)
      .eq('barcode', barcode);
    expect(afterRows).toHaveLength(1);
    expect(afterRows![0].product_id).toBe(placeholderId);
    expect(afterRows![0].is_placeholder).toBe(false);
    expect(afterRows![0].name).toBe('Resurrected Product');
  }, 15_000);
});
