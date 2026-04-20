/**
 * walmart-scrape Edge Function CORS Integration Test
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
 */
import { describe, it, expect } from 'vitest';
import { SUPABASE_URL } from '../../setup.integration';

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
