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
 * NOTE: Per-user quota ("rate limiting with request queuing" per
 * docs/apps/chefbyte.md) is documented but NOT currently implemented in
 * the edge fn. The "quota exhaustion 429" + "cross-user quota isolation"
 * tests the audit called for are intentionally omitted here — they would
 * test unimplemented behavior. When quota is wired in, re-open this file
 * and add them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SUPABASE_URL } from '../../setup.integration';
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

describe('walmart-scrape Edge Function — cross-user isolation', () => {
  // User A and User B both authenticate; failure-path requests from A do
  // not cause any observable state change for B. Because the edge fn is
  // stateless (no quota counter implemented), this test pins the
  // stateless-invariant: B's subsequent request still passes auth and
  // validation independently of A's prior request.
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
