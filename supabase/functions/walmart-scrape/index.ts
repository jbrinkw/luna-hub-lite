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
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-test-force-failure',
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
  } catch (_err) {
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

    // Per-user rate limiting (100/user/UTC-day). Spec calls for it
    // (CLAUDE.md, docs/apps/chefbyte.md); audit found it missing.
    // Use the service-role client to call the SECURITY DEFINER fn so
    // the user's row gets locked + incremented atomically without
    // depending on the user's RLS-restricted JWT having write access
    // to the quota table.
    const adminClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    let quotaInfo: { used: number; remaining: number; limit: number; reset_at: string } = {
      used: 0,
      remaining: 100,
      limit: 100,
      reset_at: '',
    };
    try {
      const { data: quotaData, error: quotaErr } = await adminClient.rpc(
        'walmart_check_and_increment',
        { p_user_id: user.id, p_max: 100 },
        { schema: 'private' as never } as never,
      );
      if (quotaErr) {
        // The schema-qualified call above isn't supported by every
        // supabase-js version; fall back to a direct postgrest call.
        const directRes = await fetch(`${Deno.env.get('SUPABASE_URL')!}/rest/v1/rpc/walmart_check_and_increment`, {
          method: 'POST',
          headers: {
            apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
            authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!}`,
            'content-type': 'application/json',
            'content-profile': 'private',
          },
          body: JSON.stringify({ p_user_id: user.id, p_max: 100 }),
        });
        if (!directRes.ok) {
          console.error('walmart-scrape: quota RPC failed', await directRes.text());
          return jsonResponse({ error: 'Quota check failed' }, 500);
        }
        const directData = await directRes.json();
        if (!directData?.allowed) {
          return jsonResponse(
            {
              error: 'Walmart search quota exceeded for today',
              quota_exceeded: true,
              limit: directData?.limit ?? 100,
              used: directData?.used ?? 100,
              remaining: 0,
              reset_at: directData?.reset_at,
            },
            429,
          );
        }
        quotaInfo = {
          used: directData.used,
          remaining: directData.remaining,
          limit: directData.limit,
          reset_at: directData.reset_at,
        };
      } else if (quotaData) {
        const q = quotaData as {
          allowed: boolean;
          used: number;
          remaining: number;
          limit: number;
          reset_at: string;
        };
        if (!q.allowed) {
          return jsonResponse(
            {
              error: 'Walmart search quota exceeded for today',
              quota_exceeded: true,
              limit: q.limit,
              used: q.used,
              remaining: 0,
              reset_at: q.reset_at,
            },
            429,
          );
        }
        quotaInfo = { used: q.used, remaining: q.remaining, limit: q.limit, reset_at: q.reset_at };
      }
    } catch (qErr) {
      console.error('walmart-scrape: quota check threw', qErr);
      return jsonResponse({ error: 'Quota check failed' }, 500);
    }

    const forced = testForceFailure(req);
    let results: unknown[];
    try {
      results = await searchWalmart(query, store_id, forced);
    } catch (err: any) {
      // SerpApi 5xx / malformed body — surface a structured 503 rather
      // than a generic 500 so the UI can render "upstream unavailable".
      // The quota counter was already incremented for this attempt; the
      // user's daily budget treats an upstream failure the same as a
      // successful call. Acceptable trade-off: the alternative would
      // require a compensating decrement and risk under-counting if the
      // decrement itself failed.
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
      quota: quotaInfo,
    });
  } catch (error: any) {
    console.error('walmart-scrape error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});
