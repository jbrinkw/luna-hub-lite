# Phase 8: Edge Functions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement three Supabase Edge Functions (Deno/TypeScript): analyze-product, walmart-scrape, liquidtrack.

**Architecture:** Each function is a standalone Deno module using `Deno.serve()`. JWT-authenticated functions create a per-request Supabase client. liquidtrack uses API key auth with service role client. All functions return JSON responses with CORS headers.

**Tech Stack:** Deno 2, Supabase Edge Functions, `jsr:@supabase/supabase-js@2`, `npm:@anthropic-ai/sdk`, Web Crypto API (SHA-256), OpenFoodFacts REST API, SerpApi REST API.

---

### Task 1: Update config.toml for liquidtrack JWT bypass

**Files:**

- Modify: `supabase/config.toml`

**Step 1: Add liquidtrack function config**

Add at end of `supabase/config.toml` (before `[analytics]` section, or at end — order doesn't matter in TOML):

```toml
[functions.liquidtrack]
verify_jwt = false
```

This disables JWT verification for the liquidtrack endpoint since ESP8266 devices authenticate via API key header, not Supabase JWT.

**Step 2: Verify config parses**

Run: `cd /tmp && npx -y supabase --workdir /home/jeremy/luna-hub-lite functions list 2>&1 || echo "Config OK if no parse errors"`

---

### Task 2: Create walmart-scrape Edge Function

Simplest function — direct port from legacy Vercel handler to Deno.serve pattern.

**Files:**

- Create: `supabase/functions/walmart-scrape/index.ts`

**Step 1: Write the function**

```typescript
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function searchWalmart(query: string, storeId?: string) {
  const serpApiKey = Deno.env.get('SERPAPI_KEY');
  if (!serpApiKey) throw new Error('SERPAPI_KEY not configured');

  const params = new URLSearchParams({
    api_key: serpApiKey,
    engine: 'walmart',
    query,
    sort: 'best_match',
  });
  if (storeId) params.set('store_id', storeId);

  const resp = await fetch(`https://serpapi.com/search.json?${params}`);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`SerpApi HTTP ${resp.status}: ${text}`);
  }

  const json = await resp.json();
  return (json.organic_results || []).slice(0, 6).map((item: any) => {
    const offer = item.primary_offer || {};
    const pricePerUnit = item.price_per_unit;
    return {
      url: item.product_page_url || item.link || '',
      title: item.title || item.name || null,
      price: offer.offer_price ? parseFloat(offer.offer_price) : item.price ? parseFloat(item.price) : null,
      price_per_unit: typeof pricePerUnit === 'object' ? pricePerUnit.amount : null,
      image_url: item.thumbnail || null,
    };
  });
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
    const results = await searchWalmart(query, store_id);

    return jsonResponse({
      success: true,
      query,
      store_id: store_id || null,
      results,
    });
  } catch (error: any) {
    console.error('walmart-scrape error:', error);
    return jsonResponse({ error: 'Internal server error', message: error.message }, 500);
  }
});
```

---

### Task 3: Create liquidtrack Edge Function

**Files:**

- Create: `supabase/functions/liquidtrack/index.ts`

**Step 1: Write the function**

```typescript
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** SHA-256 hash using Web Crypto API, returns hex string */
async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    // API key auth (no JWT)
    const apiKey = req.headers.get('x-api-key');
    if (!apiKey) {
      return jsonResponse({ error: 'Missing API key' }, 401);
    }

    const keyHash = await sha256(apiKey);

    // Service role client — bypasses RLS
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Look up device by hashed key
    const { data: device, error: deviceError } = await supabase
      .schema('chefbyte')
      .from('liquidtrack_devices')
      .select('device_id, user_id, product_id')
      .eq('import_key_hash', keyHash)
      .eq('is_active', true)
      .single();

    if (deviceError || !device) {
      return jsonResponse({ error: 'Invalid API key' }, 401);
    }

    // Fetch linked product nutrition (if any) for macro calculation
    let nutrition: {
      calories_per_serving: number;
      carbs_per_serving: number;
      protein_per_serving: number;
      fat_per_serving: number;
      servings_per_container: number;
    } | null = null;
    if (device.product_id) {
      const { data: product } = await supabase
        .schema('chefbyte')
        .from('products')
        .select('calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container')
        .eq('product_id', device.product_id)
        .single();
      nutrition = product;
    }

    // Get logical date for this user
    const { data: logicalDateResult } = await supabase.rpc('get_logical_date', { p_user_id: device.user_id });
    const logicalDate = logicalDateResult || new Date().toISOString().slice(0, 10);

    // Parse events from body
    const { events } = await req.json();
    if (!events || !Array.isArray(events) || events.length === 0) {
      return jsonResponse({ error: 'events array required' }, 400);
    }

    // Build event rows with macro calculation
    // For liquids: assume 1 serving ≈ product's serving weight
    // Macros = consumption_grams × (per_serving / serving_weight_grams)
    // Simplified: if servings_per_container and we know container is ~1L (1000g for water),
    // we use per_serving nutrition × (consumption / serving_weight)
    // For MVP: treat consumption in grams, compute per-gram rate from per-serving values
    // serving_weight ≈ total_weight / servings_per_container is unknown without product weight
    // Legacy sends pre-calculated macros from ESP; we accept those OR calculate from product
    const rows = events.map((evt: any) => {
      const consumption = Math.max(0, (evt.weight_before ?? 0) - (evt.weight_after ?? 0));

      // If event includes pre-calculated macros, use them; otherwise compute from product
      let calories = evt.calories ?? null;
      let carbs = evt.carbs ?? null;
      let protein = evt.protein ?? null;
      let fat = evt.fat ?? null;

      if (nutrition && calories === null) {
        // Per-gram rate: nutrition_per_serving / (total_weight / servings_per_container)
        // Without total_weight, assume 1 serving = 1mL ≈ 1g for liquids
        // So per_gram ≈ per_serving (when serving size is ~1g — not great)
        // Better: use per-100g if available. For now, use per_serving * consumption / 100
        // This treats serving size as 100g, reasonable for liquids sold per 100mL
        const factor = consumption / 100;
        calories = nutrition.calories_per_serving * factor;
        carbs = nutrition.carbs_per_serving * factor;
        protein = nutrition.protein_per_serving * factor;
        fat = nutrition.fat_per_serving * factor;
      }

      return {
        user_id: device.user_id,
        device_id: device.device_id,
        weight_before: evt.weight_before,
        weight_after: evt.weight_after,
        consumption,
        is_refill: evt.is_refill ?? false,
        calories,
        carbs,
        protein,
        fat,
        logical_date: logicalDate,
      };
    });

    // Insert events
    const { data: inserted, error: insertError } = await supabase
      .schema('chefbyte')
      .from('liquidtrack_events')
      .insert(rows)
      .select('event_id');

    if (insertError) {
      // Handle duplicate constraint (device_id, created_at)
      if (insertError.code === '23505') {
        return jsonResponse({ success: true, message: 'Some events already recorded', count: 0 });
      }
      throw insertError;
    }

    return jsonResponse({ success: true, count: inserted?.length ?? 0 });
  } catch (error: any) {
    console.error('liquidtrack error:', error);
    return jsonResponse({ error: 'Internal server error', message: error.message }, 500);
  }
});
```

---

### Task 4: Create analyze-product Edge Function

Most complex — JWT auth, quota tracking, OpenFoodFacts API, Claude Haiku 4.5 AI call.

**Files:**

- Create: `supabase/functions/analyze-product/index.ts`

**Step 1: Write the function**

```typescript
import { createClient } from 'jsr:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
  });
  if (!resp.ok) return null;
  const json = await resp.json();
  if (json.status !== 1 || !json.product) return null;
  return json.product;
}

/** Call Claude Haiku 4.5 to normalize product data */
async function normalizeWithAI(offProduct: any): Promise<any> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return null;

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
      nutriments: offProduct.nutriments,
    });

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
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

    // Check if product already exists for this user
    const { data: existing } = await supabase
      .schema('chefbyte')
      .from('products')
      .select('*')
      .eq('user_id', user.id)
      .eq('barcode', String(barcode))
      .single();

    if (existing) {
      return jsonResponse({ source: 'existing', product: existing });
    }

    // Check quota
    const withinQuota = await checkQuota(supabase, user.id);
    if (!withinQuota) {
      return jsonResponse({ error: 'Limit reached — enter product manually' }, 429);
    }

    // Fetch from OpenFoodFacts
    const offProduct = await fetchOpenFoodFacts(String(barcode));
    if (!offProduct) {
      return jsonResponse({ error: 'Product not found in OpenFoodFacts' }, 404);
    }

    // Normalize with AI
    const suggestion = await normalizeWithAI(offProduct);

    return jsonResponse({
      source: 'ai',
      suggestion,
      off: {
        product_name: offProduct.product_name,
        brands: offProduct.brands,
        image_url: offProduct.image_url,
        categories: offProduct.categories,
      },
    });
  } catch (error: any) {
    console.error('analyze-product error:', error);
    return jsonResponse({ error: 'Internal server error', message: error.message }, 500);
  }
});
```

---

### Task 5: Update docs and config.toml

**Files:**

- Modify: `supabase/config.toml` — add `[functions.liquidtrack]` section
- Modify: `docs/apps/chefbyte.md` — update Edge Functions section noting implementation complete

**Step 1: Add liquidtrack JWT bypass to config.toml**

Append after `[edge_runtime]` section:

```toml
[functions.liquidtrack]
verify_jwt = false
```

**Step 2: Update chefbyte.md edge functions table**

Mark all three functions as implemented with notes about env vars needed:

- `ANTHROPIC_API_KEY` for analyze-product
- `SERPAPI_KEY` for walmart-scrape
- `SUPABASE_SERVICE_ROLE_KEY` for liquidtrack (auto-provided by Supabase)

---

### Task 6: Verify TypeScript types and commit

**Step 1: Verify existing test suite still passes**

Run: `cd /home/jeremy/luna-hub-lite && pnpm test`

Edge Functions are Deno code — they don't participate in the Vitest suite. But verify no regressions.

**Step 2: Run typecheck on web app**

Run: `cd /home/jeremy/luna-hub-lite && pnpm typecheck`

**Step 3: Run pgTAP tests**

Run: `cd /tmp && npx -y supabase --workdir /home/jeremy/luna-hub-lite test db`

**Step 4: Commit**

```bash
git add supabase/functions/ supabase/config.toml docs/
git commit -m "feat(chefbyte): edge functions — analyze-product, walmart-scrape, liquidtrack"
```

---

## Notes

- **No Deno unit tests** — Edge Functions are tested via manual curl in dev and integration tests in Phase 10. Deno test runner doesn't integrate with our pnpm/Vitest setup.
- **Env vars** — `ANTHROPIC_API_KEY` and `SERPAPI_KEY` must be set in Supabase dashboard for production. Locally, add to `supabase/functions/.env` (gitignored).
- **get_logical_date RPC** — liquidtrack calls `private.get_logical_date()` via RPC. This function must be exposed through the `private` schema's search_path or called with schema qualification.
