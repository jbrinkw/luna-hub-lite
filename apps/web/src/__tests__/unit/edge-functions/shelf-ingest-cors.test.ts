/**
 * Source-code regression test for the shelf-ingest edge function's
 * `corsHeaders` constant.
 *
 * The integration test in `shelf-ingest.test.ts` only verifies that the
 * LOCAL Supabase Edge Functions gateway echoes back whatever the
 * browser asked for in `Access-Control-Request-Headers` — that gateway
 * intercepts OPTIONS preflights before the function ever runs.
 *
 * In production the function IS reached on preflight (per the user's
 * 2026-05-03 report: "Request header field authorization is not allowed
 * by Access-Control-Allow-Headers in preflight response"). So the
 * ACTUAL allow-list is whatever the function's `corsHeaders` constant
 * declares, and that constant must include every header supabase-js
 * sends from a browser context (Authorization for JWT, apikey,
 * x-client-info, content-type) AND the Pi's x-api-key for the
 * dual-auth /barcode-scan route.
 *
 * Re-extract the constant via dynamic import + a tiny shim so we don't
 * have to import Deno-specific globals at test time.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('shelf-ingest corsHeaders constant', () => {
  const source = readFileSync(
    resolve(__dirname, '../../../../../../supabase/functions/shelf-ingest/index.ts'),
    'utf8',
  );

  // Match the literal string assigned to Access-Control-Allow-Headers.
  // The constant is declared once near the top of the file. A regex
  // beats parsing-via-AST here because the file has Deno-specific
  // imports that break ts-node and vite's ESM loader.
  const allowHeadersMatch = source.match(
    /['"]Access-Control-Allow-Headers['"]\s*:\s*['"`]([^'"`]+?)['"`]/m,
  );
  // Fallback for the multi-line string literal style we use:
  //   'Access-Control-Allow-Headers':
  //     'authorization, ...',
  const allowHeadersMultilineMatch =
    allowHeadersMatch ??
    source.match(
      /['"]Access-Control-Allow-Headers['"]\s*:\s*\n?\s*['"`]([^'"`]+?)['"`]/m,
    );

  it('declares an Access-Control-Allow-Headers value', () => {
    expect(allowHeadersMultilineMatch).not.toBeNull();
  });

  const allowHeadersValue = (allowHeadersMultilineMatch?.[1] ?? '').toLowerCase();

  it('allows authorization (browser JWT routes — /scanner-state, /scan-transaction/:id/void)', () => {
    expect(allowHeadersValue).toContain('authorization');
  });

  it('allows apikey (supabase-js sends this on every browser call)', () => {
    expect(allowHeadersValue).toContain('apikey');
  });

  it('allows x-client-info (supabase-js sends this on every browser call)', () => {
    expect(allowHeadersValue).toContain('x-client-info');
  });

  it('allows content-type (POST body)', () => {
    expect(allowHeadersValue).toContain('content-type');
  });

  it('allows x-api-key (Pi forwarder routes)', () => {
    expect(allowHeadersValue).toContain('x-api-key');
  });
});
