# Phase 8: Edge Functions Design

## Overview

Three Supabase Edge Functions (Deno/TypeScript) ported from legacy Vercel serverless functions. Key changes: Vercel → Deno.serve, OpenAI → Anthropic Claude Haiku 4.5, schema-aware queries (`chefbyte` schema), Web Crypto API (no Node.js `crypto`).

## 1. analyze-product

**Auth:** Supabase JWT (Authorization: Bearer header)
**Quota:** 100/user/day tracked in `chefbyte.user_config` (key: `analyze_quota`, value: JSON string `{"date":"2026-03-03","count":5}`)
**Rate limit note:** Per CLAUDE.md — "last-write-wins concurrency, acceptable for single-user MVP"

### Flow

1. Extract JWT → `supabase.auth.getUser()` → get user_id
2. Validate barcode in request body
3. Check if product already exists for user (barcode match) → return existing if found
4. Check quota via user_config (read key `analyze_quota`, compare date + count)
5. Fetch OpenFoodFacts: `https://world.openfoodfacts.org/api/v0/product/{barcode}.json`
6. If OFF returns status !== 1 → return 404
7. Call Claude Haiku 4.5 (Anthropic SDK) to normalize product data
8. Increment quota counter
9. Return suggestion

### Claude Haiku 4.5 Prompt

System: normalize OFF data into our product schema fields. Return strict JSON:

```json
{
  "name": "Brand Product Name",
  "servings_per_container": 12,
  "calories_per_serving": 150,
  "carbs_per_serving": 20,
  "protein_per_serving": 5,
  "fat_per_serving": 6,
  "description": "Brief product description"
}
```

Rules:

- Name: `brand + product_name`, fix formatting only
- Nutrition: per-serving. If OFF only has per-100g, calculate using serving_size
- Apply 4-4-9 validation: `carbs×4 + protein×4 + fat×9` should approximate calories. Adjust calories if >10% off
- servings_per_container: from OFF `product_quantity / serving_size` or default 1

### Response Shape

```typescript
// Success
{ source: 'existing', product: {...} }        // product already in DB
{ source: 'ai', suggestion: {...}, off: {...} } // new AI suggestion
// Error
{ error: 'Product not found in OpenFoodFacts' }  // 404
{ error: 'Limit reached — enter product manually' } // 429
```

## 2. walmart-scrape

**Auth:** Supabase JWT
**External API:** SerpApi (`serpapi.com/search.json`, engine: walmart)
**Env var:** `SERPAPI_KEY`

### Flow

1. Extract JWT → validate user
2. Require `barcode` or `search_term` in body
3. Call SerpApi with query + optional `store_id`
4. Map results (up to 6): url, title, price, price_per_unit, image_url
5. Return results

### Response Shape

```typescript
{
  success: true,
  query: string,
  store_id: string | null,
  results: Array<{
    url: string,
    title: string | null,
    price: number | null,
    price_per_unit: number | null,
    image_url: string | null
  }>
}
```

Minimal changes from legacy — direct port to Deno.serve pattern.

## 3. liquidtrack

**Auth:** `x-api-key` header → SHA-256 hash → lookup `liquidtrack_devices.import_key_hash`
**JWT:** Disabled (`verify_jwt = false` in config)
**Supabase client:** Service role key (bypasses RLS for event insertion)

### Flow

1. Extract `x-api-key` header
2. Hash with SHA-256 (Web Crypto API: `crypto.subtle.digest`)
3. Query `chefbyte.liquidtrack_devices` where `import_key_hash = hash` AND `is_active = true`
4. Get `device_id`, `user_id`, `product_id` from device record
5. If device has linked product → fetch product nutrition for macro calculation
6. Validate events array in body
7. Insert events into `chefbyte.liquidtrack_events` with calculated macros + `logical_date` from `private.get_logical_date()`
8. Handle duplicate constraint (device_id, created_at) gracefully
9. Return acknowledged event count

### Request Shape (from ESP8266)

```typescript
{
  events: Array<{
    weight_before: number; // grams
    weight_after: number; // grams
    is_refill: boolean;
  }>;
}
```

Note: device_id comes from the device record lookup (not request body). Macros are calculated server-side from product nutrition × consumption weight.

### Macro Calculation

```
consumption = weight_before - weight_after  (grams)
// Product has per-serving nutrition, need per-gram:
per_gram_factor = 1 / (serving_weight_grams)
calories = consumption × (calories_per_serving / serving_weight_grams)
```

For liquids, serving_weight_grams ≈ serving_size in mL (density ≈ 1).

## Shared Patterns

### CORS Headers (all functions)

```typescript
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
};
```

### Deno.serve Pattern

```typescript
import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  // ...
});
```

### JWT Auth Helper (analyze-product, walmart-scrape)

```typescript
function getSupabaseClient(authHeader: string) {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
}
```

## Testing Approach

Edge Functions are Deno code running in Supabase. Unit testing with Deno test runner is complex in our pnpm monorepo. Instead:

1. **Manual testing** via `supabase functions serve` + curl
2. **Integration tests** as part of Phase 10 (end-to-end with real Supabase)
3. **Pure function extraction** — extract business logic (nutrition calc, macro calc, validation) into testable pure functions if warranted

This matches the project's pattern of deferring integration-heavy tests to Phase 10.

## Config Files

Each function needs a Deno import map. Supabase Edge Functions use `jsr:` imports natively in Deno 2.

### liquidtrack config

`supabase/functions/liquidtrack/.env` (local dev only, not committed):

```
# No special env — uses SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY from supabase start
```

Need to add `verify_jwt = false` to `supabase/config.toml`:

```toml
[functions.liquidtrack]
verify_jwt = false
```
