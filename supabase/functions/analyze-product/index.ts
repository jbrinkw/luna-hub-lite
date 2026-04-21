import { createClient } from 'jsr:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // supabase-js always sends `x-client-info` + `apikey`; both must be
  // listed here or the browser's preflight fails and the scanner silently
  // falls through to an "Unknown (barcode)" placeholder.
  // `x-test-force-failure` is LOCAL-ONLY (see isLocalDev()) — ignored in
  // production. Required for integration tests that exercise upstream
  // failure paths (OFF 503, Anthropic timeout, Anthropic malformed JSON)
  // without sacrificing the fidelity of hitting the real fn over HTTP.
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-test-force-failure, x-test-off-mode',
};

const DAILY_QUOTA = 100;

/**
 * Local-dev detector. The edge runtime container injects
 * SUPABASE_URL=http://kong:8000 when served by `supabase start`. In
 * production the URL is `https://<ref>.supabase.co`. We use this to gate
 * the `x-test-force-failure` header — a production request that sent the
 * header would silently bypass it.
 *
 * This is a testability hook, not a feature. DO NOT rely on it at
 * runtime for anything other than simulating upstream failures.
 */
function isLocalDev(): boolean {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  return url.includes('kong:8000') || url.includes('127.0.0.1') || url.includes('localhost');
}

/**
 * Read the `x-test-force-failure` request header, but only if the
 * function is running in local dev. Supported values:
 *   - off_503              — `fetchOpenFoodFacts` throws an upstream-5xx error
 *   - off_malformed        — OFF returns a non-JSON body (parse fails)
 *   - anthropic_timeout    — `normalizeWithAI` throws a timeout error (SOFT)
 *   - anthropic_malformed  — Anthropic returns non-JSON in content (SOFT)
 *   - off_success_canned   — `fetchOpenFoodFacts` returns a canned Nutella-
 *                            shaped product WITHOUT hitting the real OFF
 *                            API. Pair with an `anthropic_*` value on a
 *                            later test or call alone to deterministically
 *                            reach the normalize stage when CI rate-limits
 *                            OFF. See the failure-path describe block in
 *                            the integration test.
 *
 * Returns null (no-op) when not in local dev or when the header is absent.
 */
function testForceFailure(req: Request): string | null {
  if (!isLocalDev()) return null;
  const h = req.headers.get('x-test-force-failure');
  if (!h) return null;
  const allowed = new Set([
    'off_503',
    'off_malformed',
    'anthropic_timeout',
    'anthropic_malformed',
  ]);
  return allowed.has(h) ? h : null;
}

/**
 * Orthogonal to `x-test-force-failure`: when `x-test-off-mode=canned` is
 * set (local dev only), the OFF lookup is bypassed in favor of a
 * deterministic canned response. Lets CI exercise the Anthropic failure
 * paths without depending on OFF uptime / rate limits. Read by the main
 * handler and passed through to `fetchOpenFoodFacts`.
 */
function testOffMode(req: Request): string | null {
  if (!isLocalDev()) return null;
  const h = req.headers.get('x-test-off-mode');
  if (h === 'canned') return 'off_success_canned';
  return null;
}

/**
 * Canned OFF-shape product used when `x-test-force-failure=off_success_canned`.
 * Lets us deterministically reach the normalize stage without depending on
 * real OFF availability. Values mirror the Nutella nutriment shape so the
 * AI-path assertions (product_name, nutriments populated) still pass.
 */
const CANNED_OFF_PRODUCT = {
  product_name: 'Test Canned Nutella',
  generic_name: 'Hazelnut Spread',
  brands: 'Nutella',
  categories: 'Spreads, Chocolate spreads',
  serving_size: '15 g',
  serving_quantity: 15,
  product_quantity: 400,
  image_url: 'https://example.com/canned.jpg',
  nutriments: {
    'energy-kcal_100g': 539,
    'energy-kcal_serving': 80.8,
    'carbohydrates_100g': 57.5,
    'carbohydrates_serving': 8.62,
    'proteins_100g': 6.3,
    'proteins_serving': 0.95,
    'fat_100g': 30.9,
    'fat_serving': 4.64,
  },
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** Check and increment daily quota. Returns true if under limit. */
async function checkQuota(supabase: any, userId: string): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const key = 'analyze_quota';

  const { data: config } = await supabase
    .schema('chefbyte')
    .from('user_config')
    .select('value')
    .eq('user_id', userId)
    .eq('key', key)
    .single();

  let count = 0;
  if (config?.value) {
    try {
      const parsed = JSON.parse(config.value);
      if (parsed.date === today) {
        count = parsed.count ?? 0;
      }
    } catch {
      /* reset on parse error */
    }
  }

  if (count >= DAILY_QUOTA) return false;

  // Upsert incremented counter
  const newValue = JSON.stringify({ date: today, count: count + 1 });
  await supabase
    .schema('chefbyte')
    .from('user_config')
    .upsert({ user_id: userId, key, value: newValue }, { onConflict: 'user_id,key' });

  return true;
}

/**
 * Fetch product data from OpenFoodFacts.
 *
 * Returns:
 *   - the OFF `product` object on success,
 *   - `null` when OFF responded 404 / status !== 1 (product truly not found),
 *   - throws an `Error` with `.offReason = 'off_unavailable'` on 5xx or
 *     JSON-parse failure. The caller translates this to a 503 response so
 *     the UI can distinguish "upstream down" from "not found" and the
 *     scanner preserves the user's quota.
 */
async function fetchOpenFoodFacts(barcode: string, forceFailure: string | null = null) {
  // Test-only: short-circuit to simulate an upstream failure before making
  // any real OFF call. Never triggered in production (see isLocalDev()).
  if (forceFailure === 'off_503') {
    throw Object.assign(new Error('Simulated OFF 503'), { offReason: 'off_unavailable' });
  }
  if (forceFailure === 'off_malformed') {
    throw Object.assign(new Error('Simulated OFF malformed JSON'), { offReason: 'off_unavailable' });
  }
  if (forceFailure === 'off_success_canned') {
    // Bypass real OFF — return a deterministic shape. Lets CI exercise
    // the normalize-stage failure paths without depending on OFF uptime
    // or rate limits.
    return CANNED_OFF_PRODUCT;
  }

  const resp = await fetch(`https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(barcode)}.json`, {
    headers: { 'User-Agent': 'LunaHub/1.0 (contact@lunahub.dev)' },
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status >= 500) {
    throw Object.assign(new Error(`OFF HTTP ${resp.status}`), { offReason: 'off_unavailable' });
  }
  if (!resp.ok) return null;
  let json: any;
  try {
    json = await resp.json();
  } catch (err) {
    // OFF returned a 2xx with a body we can't parse — treat as upstream
    // unavailable, not as "product not found". Preserves the user's
    // quota and lets the UI retry.
    throw Object.assign(new Error('OFF returned unparseable body'), { offReason: 'off_unavailable' });
  }
  if (json.status !== 1 || !json.product) return null;
  return json.product;
}

/** Call Claude Haiku 4.5 to normalize OFF product data */
async function normalizeWithAI(offProduct: any, forceFailure: string | null = null): Promise<any> {
  // Test-only simulated failures. `anthropic_timeout` is a SOFT failure —
  // the caller falls through to `ai_degraded:true`. `anthropic_malformed`
  // mirrors the real code path where Claude returns text that won't
  // JSON.parse: log + return null (also SOFT). Never fires in prod
  // because the main handler only passes `forceFailure` when isLocalDev().
  if (forceFailure === 'anthropic_timeout') {
    throw Object.assign(new Error('Simulated Anthropic timeout'), {
      aiReason: 'timeout',
    });
  }
  if (forceFailure === 'anthropic_malformed') {
    console.error('Simulated Anthropic malformed JSON — returning null');
    return null;
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not configured — returning raw OFF data');
    // Throwing with a typed reason lets the caller translate to an
    // actionable error message instead of a silent "Unknown (barcode)"
    // placeholder.
    throw Object.assign(new Error('ANTHROPIC_API_KEY not configured'), {
      aiReason: 'missing_key',
    });
  }

  try {
    const anthropic = new Anthropic({ apiKey });

    const brand = (offProduct.brands || '').toString().trim();
    const food = (offProduct.product_name || offProduct.generic_name || '').toString().trim();
    const proposed = brand && food ? `${brand} ${food}` : food || brand || 'Unknown Product';

    const systemPrompt = [
      'You normalize Open Food Facts product data into a structured JSON format.',
      'Return STRICT JSON only, no markdown, no explanation:',
      '{',
      '  "name": "<final product name>",',
      '  "servings_per_container": <number, default 1>,',
      '  "calories_per_serving": <number>,',
      '  "carbs_per_serving": <number>,',
      '  "protein_per_serving": <number>,',
      '  "fat_per_serving": <number>,',
      '  "description": "<brief 1-line description>",',
      '  "default_shelf_life_days": <integer 1-3650, or null>',
      '}',
      '',
      'Rules:',
      `- Base name: "${proposed}". Fix formatting (spacing, casing, punctuation) only.`,
      '- Nutrition must be PER SERVING. If OFF data only has per-100g, calculate using serving_size.',
      '- If serving info missing, treat 100g as one serving.',
      '- Apply 4-4-9 validation: carbs×4 + protein×4 + fat×9 should ≈ calories. If >10% off, adjust calories to match.',
      '- servings_per_container: product_quantity / serving_size, or 1 if unknown.',
      '- All numeric values rounded to 1 decimal.',
      '- default_shelf_life_days: typical unopened pantry/fridge life from purchase, one integer.',
      '  Rough guide (use judgment based on categories):',
      '    fresh produce, bakery bread, deli meat, soft cheese: 5–10',
      '    packaged bread/tortillas/wraps, yogurt, cold cuts: 10–21',
      '    eggs, hard cheese, butter: 30–60',
      '    frozen foods: 180',
      '    condiments, jarred sauces (unopened): 365',
      '    canned goods, dried pasta/rice, spices, shelf-stable snacks: null',
      '  Use null when genuinely uncertain OR shelf-stable. Never guess wildly.',
    ].join('\n');

    // Slim nutriments to only the 4 macros + energy (per-serving + per-100g
    // variants). The raw OFF nutriments object for a typical product is
    // 10–20 KB (dozens of vitamins/minerals, variant suffixes for each)
    // which causes Claude to spend tokens reading irrelevant data and
    // often hit the timeout. Keep only what the 4-4-9 validation needs.
    const n = offProduct.nutriments ?? {};
    const slim_nutriments: Record<string, unknown> = {};
    for (const key of [
      'energy-kcal',
      'energy-kcal_serving',
      'energy-kcal_100g',
      'carbohydrates',
      'carbohydrates_serving',
      'carbohydrates_100g',
      'proteins',
      'proteins_serving',
      'proteins_100g',
      'fat',
      'fat_serving',
      'fat_100g',
    ]) {
      if (n[key] != null) slim_nutriments[key] = n[key];
    }

    const userPrompt =
      'Normalize this Open Food Facts product:\n' +
      JSON.stringify({
        product_name: offProduct.product_name,
        generic_name: offProduct.generic_name,
        brands: offProduct.brands,
        categories: offProduct.categories,
        serving_size: offProduct.serving_size,
        serving_quantity: offProduct.serving_quantity,
        product_quantity: offProduct.product_quantity,
        nutriments: slim_nutriments,
      });

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      timeout: 25_000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = message.content[0]?.type === 'text' ? message.content[0].text : '';
    try {
      return JSON.parse(text);
    } catch {
      console.error('Failed to parse AI response:', text);
      return null;
    }
  } catch (err: any) {
    // Classify Anthropic SDK errors so the edge function can surface a
    // specific actionable message instead of silently returning null
    // (which falls through to an "Unknown (barcode)" placeholder).
    const status = err?.status ?? err?.statusCode;
    const msg = (err?.message ?? String(err)).toLowerCase();
    let reason = 'transient';
    if (status === 401 || /invalid.*api.?key|incorrect api key|authentication/i.test(msg)) {
      reason = 'bad_key';
    } else if (status === 402 || /credit|billing|balance.*low|insufficient.*funds/i.test(msg)) {
      reason = 'billing';
    } else if (status === 429 || /rate.?limit|too many requests/i.test(msg)) {
      reason = 'rate_limit';
    } else if (/timeout|timed out/i.test(msg)) {
      reason = 'timeout';
    }
    console.error(`AI normalization failed (${reason}):`, err?.message ?? err);
    throw Object.assign(new Error(err?.message ?? 'AI call failed'), {
      aiReason: reason,
      aiStatus: status,
    });
  }
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
    const { barcode } = await req.json();
    if (!barcode) {
      return jsonResponse({ error: 'Barcode is required' }, 400);
    }

    // Validate barcode: must be a string, alphanumeric only, max 50 chars
    const barcodeStr = String(barcode);
    if (barcodeStr.length > 50) {
      return jsonResponse({ error: 'Barcode too long (max 50 characters)' }, 400);
    }
    if (!/^[a-zA-Z0-9]+$/.test(barcodeStr)) {
      return jsonResponse({ error: 'Barcode must be alphanumeric' }, 400);
    }

    // Check if product already exists for this user
    const { data: existing } = await supabase
      .schema('chefbyte')
      .from('products')
      .select('*')
      .eq('user_id', user.id)
      .eq('barcode', barcodeStr)
      .single();

    if (existing) {
      return jsonResponse({ source: 'existing', product: existing });
    }

    // Test-only failure injection (see testForceFailure() / testOffMode()).
    // Both return null in production — the real upstream code paths run
    // unchanged.
    const forced = testForceFailure(req);
    const offMode = testOffMode(req);

    // Fetch from OpenFoodFacts FIRST, then quota. Prior ordering consumed
    // quota even when OFF was down, which burned the user's daily budget
    // on transient upstream failures. Only charge quota once we know we
    // have OFF data to normalize.
    //
    // OFF lookup is short-circuited when:
    //   - forced is an `off_*` failure (for 503 / malformed tests), OR
    //   - offMode is `off_success_canned` (for Anthropic-path tests that
    //     need a deterministic OFF response regardless of OFF uptime).
    const offOverride = forced?.startsWith('off_') ? forced : offMode;
    let offProduct: any;
    try {
      offProduct = await fetchOpenFoodFacts(barcodeStr, offOverride);
    } catch (err: any) {
      // OFF 5xx or malformed body — distinct from "not found". Return 503
      // with `ai_degraded:true` so the UI surfaces "try again" rather
      // than creating a corrupt placeholder. Quota NOT consumed.
      if (err?.offReason === 'off_unavailable') {
        console.error('analyze-product: OFF unavailable', err?.message ?? err);
        return jsonResponse(
          {
            error: 'OpenFoodFacts is temporarily unavailable — please try again',
            ai_degraded: true,
            ai_reason: 'off_unavailable',
          },
          503,
        );
      }
      throw err; // unexpected — let the outer catch return a 500
    }
    if (!offProduct) {
      return jsonResponse({ error: 'Product not found in OpenFoodFacts' }, 404);
    }

    // Check daily quota (100/user/day). OFF call succeeded, so any
    // subsequent work genuinely reflects a quota-consumed analysis.
    const withinQuota = await checkQuota(supabase, user.id);
    if (!withinQuota) {
      return jsonResponse({ error: 'Limit reached — enter product manually' }, 429);
    }

    // Normalize with Claude Haiku 4.5. Failures are classified into two
    // buckets:
    //   * HARD  (missing_key, bad_key, billing) — admin intervention
    //     required, short-circuit with 503 so the UI surfaces it clearly.
    //   * SOFT  (rate_limit, timeout, transient) — the raw OFF data is
    //     still useful, so we fall through and return 200 with
    //     ``suggestion: null`` + ``ai_degraded`` flag. The scanner's
    //     existing OFF fallback path (ScannerPage.tsx:272–279) produces
    //     a product with macro values from OFF nutriments, which beats a
    //     silent "Unknown (barcode)" placeholder.
    const HARD_FAILURES = new Set(['missing_key', 'bad_key', 'billing']);
    let suggestion: any = null;
    let aiDegradedReason: string | null = null;
    try {
      suggestion = await normalizeWithAI(offProduct, forced);
    } catch (err: any) {
      const reason: string = err?.aiReason ?? 'transient';
      if (HARD_FAILURES.has(reason)) {
        const REASON_COPY: Record<string, string> = {
          missing_key: 'AI service not configured — ask admin to set ANTHROPIC_API_KEY',
          bad_key: 'AI service auth failed — check ANTHROPIC_API_KEY',
          billing: 'AI service has no credits — top up billing and try again',
        };
        return jsonResponse(
          { error: REASON_COPY[reason], ai_reason: reason, off: offProduct },
          503,
        );
      }
      // Soft failure — degrade to OFF-only and let the scanner use its
      // nutriments fallback. Record the reason so the UI can still hint
      // "AI degraded, data from OpenFoodFacts only."
      aiDegradedReason = reason;
    }

    // Validate required fields in AI response before returning
    if (suggestion) {
      const required = ['name', 'calories_per_serving', 'protein_per_serving', 'carbs_per_serving', 'fat_per_serving'];
      const missing = required.filter((k) => suggestion[k] == null);
      if (missing.length > 0) {
        console.warn('AI response missing fields:', missing, suggestion);
        return jsonResponse({ error: 'AI could not parse product data — enter manually' }, 422);
      }
      // Ensure numeric fields are numbers
      for (const k of [
        'calories_per_serving',
        'protein_per_serving',
        'carbs_per_serving',
        'fat_per_serving',
        'servings_per_container',
      ]) {
        if (suggestion[k] != null) suggestion[k] = Number(suggestion[k]) || 0;
      }
      if (!suggestion.servings_per_container || suggestion.servings_per_container < 1) {
        suggestion.servings_per_container = 1;
      }
      // default_shelf_life_days: integer in [1, 3650] or null.
      // Coerce, clamp, and drop any non-integer / out-of-range value to null
      // rather than surfacing a 422 — the rest of the suggestion is still
      // useful, we just skip auto-expiry on malformed suggestions.
      if (suggestion.default_shelf_life_days != null) {
        const n = Math.round(Number(suggestion.default_shelf_life_days));
        suggestion.default_shelf_life_days =
          Number.isFinite(n) && n >= 1 && n <= 3650 ? n : null;
      } else {
        suggestion.default_shelf_life_days = null;
      }
    }

    return jsonResponse({
      source: 'ai',
      suggestion,
      ai_degraded: aiDegradedReason !== null,
      ai_reason: aiDegradedReason,
      off: {
        product_name: offProduct.product_name,
        brands: offProduct.brands,
        image_url: offProduct.image_url,
        categories: offProduct.categories,
        serving_size: offProduct.serving_size,
        // Needed by the LiveTrack wizard to compute servings-per-container
        // when the AI step degrades (suggestion=null). OFF stores this as
        // a number in grams (total net content), e.g. 566.99 for a 20-oz
        // pack of tortillas.
        product_quantity: offProduct.product_quantity,
        nutriments: offProduct.nutriments,
      },
    });
  } catch (error: any) {
    console.error('analyze-product error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});
