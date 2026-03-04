/**
 * Analyze-Product Edge Function Integration Tests
 *
 * Tests the analyze-product edge function with real HTTP calls.
 * Tests auth, validation, existing-product detection, and quota enforcement.
 * Note: Supabase relay validates JWT before the function code runs,
 * so auth error responses use {msg: "..."} format.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminClient } from '../../setup.integration';
import { createTestUser, cleanupUser } from '../../test-helpers';

const EDGE_URL = 'http://127.0.0.1:54321/functions/v1/analyze-product';

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
    // Supabase relay uses {msg: "..."} for JWT errors
    expect(body.msg || body.error).toBeTruthy();
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
    expect(body.msg || body.error).toBeTruthy();
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
});
