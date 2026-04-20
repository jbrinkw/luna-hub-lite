import { createClient } from 'jsr:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // supabase-js always sends `x-client-info` + `apikey`; both must be
  // listed here or the browser's preflight fails and the scanner silently
  // falls through to an "Unknown (barcode)" placeholder.
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DAILY_QUOTA = 100;

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

/** Fetch product data from OpenFoodFacts */
async function fetchOpenFoodFacts(barcode: string) {
  const resp = await fetch(`https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(barcode)}.json`, {
    headers: { 'User-Agent': 'LunaHub/1.0 (contact@lunahub.dev)' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const json = await resp.json();
  if (json.status !== 1 || !json.product) return null;
  return json.product;
}

/** Call Claude Haiku 4.5 to normalize OFF product data */
async function normalizeWithAI(offProduct: any): Promise<any> {
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
      '  "description": "<brief 1-line description>"',
      '}',
      '',
      'Rules:',
      `- Base name: "${proposed}". Fix formatting (spacing, casing, punctuation) only.`,
      '- Nutrition must be PER SERVING. If OFF data only has per-100g, calculate using serving_size.',
      '- If serving info missing, treat 100g as one serving.',
      '- Apply 4-4-9 validation: carbs×4 + protein×4 + fat×9 should ≈ calories. If >10% off, adjust calories to match.',
      '- servings_per_container: product_quantity / serving_size, or 1 if unknown.',
      '- All numeric values rounded to 1 decimal.',
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

    // Check daily quota (100/user/day)
    const withinQuota = await checkQuota(supabase, user.id);
    if (!withinQuota) {
      return jsonResponse({ error: 'Limit reached — enter product manually' }, 429);
    }

    // Fetch from OpenFoodFacts
    const offProduct = await fetchOpenFoodFacts(barcodeStr);
    if (!offProduct) {
      return jsonResponse({ error: 'Product not found in OpenFoodFacts' }, 404);
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
      suggestion = await normalizeWithAI(offProduct);
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
        nutriments: offProduct.nutriments,
      },
    });
  } catch (error: any) {
    console.error('analyze-product error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});
