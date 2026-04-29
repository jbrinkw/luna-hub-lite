/**
 * walmart-scrape Edge Function Integration Tests
 *
 * This function is invoked from the browser via `supabase.functions.invoke`
 * from WalmartTab.tsx. supabase-js sends four headers on every request:
 *   - authorization
 *   - x-client-info
 *   - apikey
 *   - content-type
 *
 * ALL four must appear in Access-Control-Allow-Headers or the browser's
 * preflight fails silently. A narrower allowlist is the class of regression
 * that just shipped for analyze-product.
 *
 * Failure-path tests use the local-only `x-test-force-failure` header
 * (gated by isLocalDev() in the edge fn source); production requests that
 * send the header are silently ignored.
 *
 * CB-EF-01 (MOCK_AUDIT_CHEFBYTE_SERVER.md 2026-04-29): quota exhaustion
 * (429) and cross-user quota isolation tests are now implemented. The
 * walmart_quota table (migration 20260429040000) + private.walmart_check_and_increment
 * function are confirmed in the edge fn. We seed an exhausted quota row
 * directly via adminClient (matching the analyze-product quota test pattern)
 * then assert the 429 response shape. Cross-user isolation: we seed user A's
 * quota to exhaustion, then verify user B's first call is NOT rejected by A's
 * counter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminClient, SUPABASE_URL } from '../../setup.integration';
import { createTestUser, cleanupUser } from '../../test-helpers';

const EDGE_URL = `${SUPABASE_URL}/functions/v1/walmart-scrape`;

describe('walmart-scrape Edge Function — CORS', () => {
  it('CORS preflight returns ok and allows all supabase-js headers', async () => {
    const res = await fetch(EDGE_URL, { method: 'OPTIONS' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('ok');

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');

    // supabase-js sends all four of these on every browser invocation; every
    // one must be allowed or the preflight fails and the WalmartTab UI
    // silently loses its data fetches.
    const allowed = res.headers.get('Access-Control-Allow-Headers')!.toLowerCase();
    expect(allowed).toContain('authorization');
    expect(allowed).toContain('x-client-info');
    expect(allowed).toContain('apikey');
    expect(allowed).toContain('content-type');
  });
});

describe('walmart-scrape Edge Function — auth + validation', () => {
  let userA: { userId: string; jwt: string };

  beforeAll(async () => {
    const a = await createTestUser('walmart-a');
    const { data: sessionA } = await a.client.auth.getSession();
    userA = { userId: a.userId, jwt: sessionA.session!.access_token };
  });

  afterAll(async () => {
    await cleanupUser(userA.userId);
  });

  it('rejects requests without Authorization header → 401', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ search_term: 'milk' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/missing authorization/i);
  });

  it('rejects requests with a bogus bearer token → 401', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer not.a.real.jwt',
      },
      body: JSON.stringify({ search_term: 'milk' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/invalid token/i);
  });

  it('rejects missing barcode + search_term → 400', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userA.jwt}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/required/i);
  });

  it('rejects invalid store_id format → 400', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userA.jwt}`,
      },
      body: JSON.stringify({ search_term: 'milk', store_id: 'abc;DROP TABLE--' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/store_id/i);
  });
});

describe('walmart-scrape Edge Function — upstream failure paths', () => {
  let userId: string;
  let userJwt: string;

  beforeAll(async () => {
    const a = await createTestUser('walmart-fail');
    userId = a.userId;
    const { data: session } = await a.client.auth.getSession();
    userJwt = session.session!.access_token;
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  // SerpApi 503 — upstream scraper outage
  it('SerpApi 503: returns structured 503 (not 500) with upstream_reason', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
        'x-test-force-failure': 'serpapi_503',
      },
      body: JSON.stringify({ search_term: 'milk' }),
    });

    expect(res.status).toBe(503);
    expect(res.status).not.toBe(500); // explicit: not a generic crash
    const body = await res.json();
    expect(body.upstream_reason).toBe('serpapi_unavailable');
    expect(body.error).toMatch(/unavailable|try again/i);
  }, 15_000);

  // SerpApi returns malformed (non-JSON) body
  it('SerpApi malformed body: does not 500, returns structured 503', async () => {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
        'x-test-force-failure': 'serpapi_malformed',
      },
      body: JSON.stringify({ search_term: 'bread' }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.upstream_reason).toBe('serpapi_unavailable');
  }, 15_000);
});

describe('walmart-scrape Edge Function — cross-user isolation (stateless upstream)', () => {
  // User A and User B both authenticate; failure-path requests from A do
  // not cause any observable state change for B. Quota counters are
  // per-user so A's upstream-failure requests cannot exhaust B's quota.
  let userA: { userId: string; jwt: string };
  let userB: { userId: string; jwt: string };

  beforeAll(async () => {
    const a = await createTestUser('walmart-iso-a');
    const b = await createTestUser('walmart-iso-b');
    const { data: sessionA } = await a.client.auth.getSession();
    const { data: sessionB } = await b.client.auth.getSession();
    userA = { userId: a.userId, jwt: sessionA.session!.access_token };
    userB = { userId: b.userId, jwt: sessionB.session!.access_token };
  });

  afterAll(async () => {
    await cleanupUser(userA.userId);
    await cleanupUser(userB.userId);
  });

  it('User A SerpApi failure does not affect User B request auth/validation', async () => {
    // A triggers a simulated upstream failure.
    const resA = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userA.jwt}`,
        'x-test-force-failure': 'serpapi_503',
      },
      body: JSON.stringify({ search_term: 'milk' }),
    });
    expect(resA.status).toBe(503);

    // B's request (without the force header) must still reach the
    // validation layer cleanly. We don't call real SerpApi (no key in
    // the test env) so we assert against the 4xx/5xx boundary: B's
    // call must NOT return 401 (auth ok) or 400 for our valid body.
    // A missing SERPAPI_KEY surfaces as an internal 500 — that's fine,
    // it proves the fn reached the upstream-call stage independently
    // of A's earlier request.
    const resB = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userB.jwt}`,
      },
      body: JSON.stringify({ search_term: 'bread' }),
    });
    expect(resB.status).not.toBe(401);
    expect(resB.status).not.toBe(400);
  }, 15_000);
});

// ─── CB-EF-01: Quota exhaustion 429 ─────────────────────────────────────────
// Seeds the walmart_quota table via adminClient (service_role bypasses RLS)
// with today's date and used=100 (= p_max). The edge fn calls
// private.walmart_check_and_increment before hitting SerpApi; when
// allowed=false it must return 429 with quota_exceeded=true.
// Pattern follows analyze-product.test.ts quota tests (lines 134-169).

describe('walmart-scrape Edge Function — quota exhaustion 429 (CB-EF-01)', () => {
  let userId: string;
  let userJwt: string;

  beforeAll(async () => {
    const u = await createTestUser('walmart-quota');
    userId = u.userId;
    const { data: session } = await u.client.auth.getSession();
    userJwt = session.session!.access_token;
  });

  afterAll(async () => {
    await (adminClient as any).schema('chefbyte').from('walmart_quota').delete().eq('user_id', userId);
    await cleanupUser(userId);
  });

  it('returns 429 with quota_exceeded=true when daily quota is exhausted', async () => {
    const today = new Date().toISOString().slice(0, 10);

    // Seed exhausted quota: used = 100 = p_max cap
    const { error: seedErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('walmart_quota')
      .upsert({ user_id: userId, quota_date: today, used: 100 }, { onConflict: 'user_id' });
    expect(seedErr).toBeNull();

    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
      },
      body: JSON.stringify({ search_term: 'milk' }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.quota_exceeded).toBe(true);
    expect(body.error).toMatch(/quota exceeded/i);
    expect(typeof body.limit).toBe('number');
    expect(typeof body.used).toBe('number');
    expect(body.used).toBeGreaterThanOrEqual(body.limit);
  }, 15_000);
});

// ─── CB-EF-01: Cross-user quota isolation ───────────────────────────────────
// Verifies A's exhausted quota does not block B.
// Seeds A's walmart_quota row to exhaustion; asserts A gets 429 and B does NOT.

describe('walmart-scrape Edge Function — cross-user quota isolation (CB-EF-01)', () => {
  let userA: { userId: string; jwt: string };
  let userB: { userId: string; jwt: string };

  beforeAll(async () => {
    const a = await createTestUser('walmart-quotaiso-a');
    const b = await createTestUser('walmart-quotaiso-b');
    const { data: sessionA } = await a.client.auth.getSession();
    const { data: sessionB } = await b.client.auth.getSession();
    userA = { userId: a.userId, jwt: sessionA.session!.access_token };
    userB = { userId: b.userId, jwt: sessionB.session!.access_token };
  });

  afterAll(async () => {
    await (adminClient as any)
      .schema('chefbyte')
      .from('walmart_quota')
      .delete()
      .in('user_id', [userA.userId, userB.userId]);
    await cleanupUser(userA.userId);
    await cleanupUser(userB.userId);
  });

  it("User A's exhausted quota does not block User B", async () => {
    const today = new Date().toISOString().slice(0, 10);

    // Exhaust user A's quota
    const { error: seedErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('walmart_quota')
      .upsert({ user_id: userA.userId, quota_date: today, used: 100 }, { onConflict: 'user_id' });
    expect(seedErr).toBeNull();

    // Confirm A is blocked
    const resA = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userA.jwt}`,
      },
      body: JSON.stringify({ search_term: 'milk' }),
    });
    expect(resA.status).toBe(429);

    // B has no quota row; first call must NOT be blocked by A's counter.
    // No SERPAPI_KEY in test env → 500/503 from upstream is expected and fine —
    // it proves the fn reached the upstream-call stage (past quota check).
    const resB = await fetch(EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userB.jwt}`,
      },
      body: JSON.stringify({ search_term: 'bread' }),
    });
    // Must not be 429 (quota-blocked) — anything else means quota isolation holds
    expect(resB.status).not.toBe(429);
    expect(resB.status).not.toBe(401);
    expect(resB.status).not.toBe(400);
  }, 15_000);
});
