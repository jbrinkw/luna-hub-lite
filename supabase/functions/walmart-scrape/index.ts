import { createClient } from 'jsr:@supabase/supabase-js@2';
import { buildSerpApiUrl, normalizeSerpApiResponse } from './_normalize.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // supabase-js always sends `x-client-info` + `apikey` on every browser
  // invocation; both must be listed here or the browser's preflight fails
  // and the WalmartTab UI silently loses its data fetches.
  // `x-test-force-failure` is LOCAL-ONLY (see isLocalDev()) — ignored in
  // production. Required by the walmart failure-path integration tests
  // (SerpApi 503, SerpApi malformed JSON).
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-test-force-failure',
};

/**
 * Local-dev detector. The edge runtime container injects
 * SUPABASE_URL=http://kong:8000 when served by `supabase start`. In
 * production the URL is `https://<ref>.supabase.co`. Gates the
 * `x-test-force-failure` header so a production request that sent it
 * would be silently ignored.
 */
function isLocalDev(): boolean {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  return url.includes('kong:8000') || url.includes('127.0.0.1') || url.includes('localhost');
}

/**
 * Read the `x-test-force-failure` request header. Supported values:
 *   - serpapi_503        — simulate SerpApi returning HTTP 503
 *   - serpapi_malformed  — simulate SerpApi returning a non-JSON body
 *
 * Returns null (no-op) outside local dev or when header absent.
 */
function testForceFailure(req: Request): string | null {
  if (!isLocalDev()) return null;
  const h = req.headers.get('x-test-force-failure');
  if (!h) return null;
  const allowed = new Set(['serpapi_503', 'serpapi_malformed']);
  return allowed.has(h) ? h : null;
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Call SerpApi Walmart search. Throws with `.upstreamReason` set so the
 * caller can return a distinct 503 instead of swallowing the failure as a
 * generic 500.
 */
async function searchWalmart(query: string, storeId?: string, forceFailure: string | null = null) {
  // Test-only: short-circuit before any real network call. Never fires
  // in production (gated by isLocalDev() in the caller).
  if (forceFailure === 'serpapi_503') {
    throw Object.assign(new Error('Simulated SerpApi 503'), {
      upstreamReason: 'serpapi_unavailable',
    });
  }
  if (forceFailure === 'serpapi_malformed') {
    throw Object.assign(new Error('Simulated SerpApi malformed JSON'), {
      upstreamReason: 'serpapi_unavailable',
    });
  }

  const serpApiKey = Deno.env.get('SERPAPI_KEY');
  if (!serpApiKey) throw new Error('SERPAPI_KEY not configured');

  const url = buildSerpApiUrl({ apiKey: serpApiKey, query, storeId });
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (resp.status >= 500) {
    throw Object.assign(new Error(`SerpApi HTTP ${resp.status}`), {
      upstreamReason: 'serpapi_unavailable',
    });
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`SerpApi HTTP ${resp.status}: ${text}`);
  }

  let json: any;
  try {
    json = await resp.json();
  } catch (err) {
    // SerpApi returned a 2xx with a body we can't parse. Treat as
    // upstream unavailable so the client sees a retriable 503 rather
    // than a generic 500.
    throw Object.assign(new Error('SerpApi returned unparseable body'), {
      upstreamReason: 'serpapi_unavailable',
    });
  }
  return normalizeSerpApiResponse(json);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    // JWT auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Missing authorization header' }, 401);
    }

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return jsonResponse({ error: 'Invalid token' }, 401);
    }

    // Parse body
    const { barcode, search_term, store_id } = await req.json();
    if (!barcode && !search_term) {
      return jsonResponse({ error: 'barcode or search_term required' }, 400);
    }

    const query = barcode ? String(barcode) : String(search_term);

    // Validate query: must be non-empty and reasonable length
    if (query.length === 0 || query.length > 200) {
      return jsonResponse({ error: 'Query must be between 1 and 200 characters' }, 400);
    }

    // Validate store_id if provided: numeric only
    if (store_id != null && !/^\d{1,10}$/.test(String(store_id))) {
      return jsonResponse({ error: 'Invalid store_id format' }, 400);
    }

    const forced = testForceFailure(req);
    let results: unknown[];
    try {
      results = await searchWalmart(query, store_id, forced);
    } catch (err: any) {
      // SerpApi 5xx / malformed body — surface a structured 503 rather
      // than a generic 500 so the UI can render "upstream unavailable"
      // and the caller's quota (when implemented) isn't burned on an
      // upstream outage.
      if (err?.upstreamReason === 'serpapi_unavailable') {
        console.error('walmart-scrape: SerpApi unavailable', err?.message ?? err);
        return jsonResponse(
          {
            error: 'Walmart search is temporarily unavailable — please try again',
            upstream_reason: 'serpapi_unavailable',
          },
          503,
        );
      }
      throw err; // unexpected — outer catch returns 500
    }

    return jsonResponse({
      success: true,
      query,
      store_id: store_id || null,
      results,
    });
  } catch (error: any) {
    console.error('walmart-scrape error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});
