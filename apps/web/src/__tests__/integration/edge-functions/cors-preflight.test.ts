/**
 * CORS Preflight Parametrized Test — every edge function
 *
 * Closes audit item #32: "CORS preflight headers on all edge functions".
 * Prior to this file, CORS preflight was asserted ad-hoc inside each edge
 * function's integration test. A new edge fn could ship without a
 * preflight assertion and slip through. This file enumerates
 * `supabase/functions/<name>/index.ts` at test boot and parametrizes the
 * preflight check across every entry.
 *
 * supabase-js always sends four headers on every browser call:
 *   - authorization
 *   - x-client-info
 *   - apikey
 *   - content-type
 *
 * Omitting any of them from Access-Control-Allow-Headers causes the
 * browser to reject the preflight — the page silently loses its data
 * fetches. This is the exact regression that triggered the original
 * analyze-product fix.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SUPABASE_URL } from '../../setup.integration';

// Resolve <repo-root>/supabase/functions regardless of CWD the test runner
// happens to be invoked from.
const FUNCTIONS_DIR = join(__dirname, '..', '..', '..', '..', '..', '..', 'supabase', 'functions');

function listEdgeFunctions(): string[] {
  const entries = readdirSync(FUNCTIONS_DIR);
  return entries
    .filter((name) => {
      const full = join(FUNCTIONS_DIR, name);
      try {
        if (!statSync(full).isDirectory()) return false;
        // Only count dirs that actually hold an index.ts entrypoint.
        statSync(join(full, 'index.ts'));
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

const edgeFunctions = listEdgeFunctions();

describe('CORS preflight — parametrized across all edge functions', () => {
  // Meta-assertion: make sure we actually discovered edge functions.
  // If the glob returned zero, the test suite would silently pass with
  // no expectations — this guards against a future path break.
  it('discovers at least one edge function', () => {
    expect(edgeFunctions.length).toBeGreaterThan(0);
    // Known set as of 2026-04-21. Updating this list is intentional —
    // if a new function is added, the dev reviewing this diff should
    // confirm it also has CORS headers.
    const known = new Set(['analyze-product', 'walmart-scrape', 'shelf-ingest', 'livetrack-session']);
    for (const name of edgeFunctions) {
      if (!known.has(name)) {
        // Soft-warn rather than fail: newly added fns should still get
        // their preflight checked below. This just flags to the reviewer
        // that the known-set is stale.
        console.warn(`[cors-preflight] Edge fn '${name}' not in known set — update the comment.`);
      }
    }
  });

  for (const fnName of edgeFunctions) {
    describe(`/${fnName}`, () => {
      const edgeUrl = `${SUPABASE_URL}/functions/v1/${fnName}`;

      it('OPTIONS preflight returns success + required CORS headers', async () => {
        const res = await fetch(edgeUrl, {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://app.lunahub.dev',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'authorization, content-type',
          },
        });

        // Accept 200 or 204 — both are valid per the CORS spec. The
        // existing fns respond 200 with body 'ok'; a future fn might
        // choose 204 no-content.
        expect([200, 204]).toContain(res.status);

        const allowOrigin = res.headers.get('Access-Control-Allow-Origin');
        expect(allowOrigin).toBeTruthy();
        // Either '*' or an exact origin echo — both are acceptable.
        expect(allowOrigin === '*' || allowOrigin === 'https://app.lunahub.dev').toBe(true);

        const allowMethods = res.headers.get('Access-Control-Allow-Methods') ?? '';
        expect(allowMethods.toUpperCase()).toContain('POST');

        const allowHeaders = (res.headers.get('Access-Control-Allow-Headers') ?? '').toLowerCase();
        // Minimum contract — the browser-side supabase-js stack and
        // the Pi-side API-key stack both need SOME subset. We assert
        // the two that every route needs.
        expect(allowHeaders).toContain('authorization');
        expect(allowHeaders).toContain('content-type');
      });
    });
  }

  // Deeper contract for browser-facing functions: the full supabase-js
  // header set must be whitelisted. We exclude shelf-ingest (Pi-only via
  // x-api-key) — it doesn't need x-client-info / apikey since supabase-js
  // never calls it from the browser.
  const BROWSER_FUNCTIONS = new Set(['analyze-product', 'walmart-scrape', 'livetrack-session']);
  for (const fnName of edgeFunctions) {
    if (!BROWSER_FUNCTIONS.has(fnName)) continue;
    describe(`/${fnName} (browser contract)`, () => {
      const edgeUrl = `${SUPABASE_URL}/functions/v1/${fnName}`;

      it('Access-Control-Allow-Headers includes all supabase-js headers', async () => {
        const res = await fetch(edgeUrl, { method: 'OPTIONS' });
        const allowed = (res.headers.get('Access-Control-Allow-Headers') ?? '').toLowerCase();
        // supabase-js sends all four of these on every browser
        // invocation — every one must be allowed or the preflight
        // fails and the UI silently loses its data fetches.
        expect(allowed).toContain('authorization');
        expect(allowed).toContain('x-client-info');
        expect(allowed).toContain('apikey');
        expect(allowed).toContain('content-type');
      });
    });
  }
});
