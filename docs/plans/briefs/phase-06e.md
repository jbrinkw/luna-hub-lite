# Phase 06e: analyze-product Edge Function

> Previous: phase-06d.md | Next: phase-07a.md

## Skills

test-driven-development, test-quality-review, claude-developer-platform (Claude Haiku 4.5 call), context7 (Supabase Edge Functions)

## Build

- `supabase/functions/analyze-product/index.ts` — Deno Edge Function
- Pipeline stages:
  1. **Auth:** Validate Supabase JWT, extract user_id
  2. **Quota check:** Query daily usage count for user, reject if >= 100
  3. **OpenFoodFacts lookup:** GET `https://world.openfoodfacts.org/api/v2/product/{barcode}` -> extract product_name, nutrition_data_per (serving vs 100g), nutriments (energy-kcal, proteins, carbohydrates, fat)
  4. **Claude Haiku 4.5 normalization:** Send OFF data to Claude for name cleanup, nutrition extraction/normalization to per-container values, 4-4-9 calorie validation ((protein*4)+(carbs*4)+(fats\*9) vs reported calories)
  5. **Response:** Return normalized name, calories, protein_g, carbs_g, fats_g, servings_per_container, 4-4-9 validation result
- Error handling: OFF miss -> error response (no fallback to Claude without OFF data). Claude failure -> error response. No auto-creation of product on any failure.
- Quota tracking: `chefbyte.analyze_quota` table (user_id, logical_date, count) or increment pattern
- Environment variables: `ANTHROPIC_API_KEY` (platform-paid), `OFF_BASE_URL` (overridable for testing)
- `supabase/functions/analyze-product/.env.local` — mock server URLs for testing

## Test (TDD)

### Integration: `apps/web/src/__tests__/integration/edge-functions/analyze-product.test.ts`

Tests run against locally-served Edge Function (`http://localhost:54321/functions/v1/analyze-product`). External APIs mocked via overridden base URLs pointing to a local mock HTTP server started by the test.

- POST with valid barcode -> mock OFF returns product data -> mock Claude normalizes -> response contains:
  - Normalized product name (cleaned by Claude)
  - calories, protein_g, carbs_g, fats_g (NUMERIC precision)
  - servings_per_container
  - 4-4-9 validation result (pass/fail + delta)
- POST with barcode not found in OFF -> error response with clear message ("Product not found")
- POST with barcode where OFF returns null/zero macros -> falls through to Claude analysis -> normalized result
- POST with valid OFF data but Claude API failure -> error response ("Analysis failed"), no partial product creation
- POST with valid OFF data but Claude returns invalid format -> error response
- Quota: 100th call in same day -> success (at limit)
- Quota: 101st call in same day -> quota error ("Daily limit reached — enter product manually")
- Quota resets on new logical_date (next day call succeeds)
- Missing/invalid JWT -> 401 Unauthorized
- Missing barcode in request body -> 400 Bad Request
- 4-4-9 validation: response includes whether reported calories match computed (protein*4 + carbs*4 + fats\*9) within tolerance
- Response does NOT auto-create a product row (caller decides whether to create)

### Quality gate

After all tests in each layer pass, dispatch `test-quality-review` per-batch before marking done.

## Legacy Reference

- `legacy/luna-ext-chefbyte/lib/api.py` — full pipeline: OFF lookup -> GPT-4 normalize -> 4-4-9 validate (rewrite GPT-4 to Claude Haiku 4.5)
- `legacy/luna-ext-chefbyte/lib/services/products.py` — product creation validation, nutrition normalization
- `legacy/luna-ext-chefbyte/lib/core/qu_resolver.py` — servings_per_container extraction from OFF data

## Commit

`feat: analyze-product edge function`

## Acceptance

- [ ] Edge Function deployed locally via `supabase start`
- [ ] Pipeline: barcode -> OFF lookup -> Claude Haiku 4.5 normalization -> structured response
- [ ] OFF miss returns error, not partial data
- [ ] Claude failure returns error, no auto-creation
- [ ] Per-user daily quota (100/day) enforced with clear error message
- [ ] 4-4-9 calorie validation included in response
- [ ] Integration tests pass: `pnpm --filter web test -- -c vitest.integration.config.ts run src/__tests__/integration/edge-functions/analyze-product`
- [ ] `pnpm typecheck` passes

---

## Phase 6 Overall Acceptance

All ChefByte DB + Edge Function work complete:

- [ ] All ChefByte tables created with correct columns, indexes, RLS
- [ ] All private functions working: consume_product, mark_meal_done, get_daily_macros, sync_meal_plan_to_shopping, import_shopping_to_inventory
- [ ] Liquid Log writes to liquidtrack_events with device_id='manual' (decision #22)
- [ ] analyze-product Edge Function operational
- [ ] ChefByte activation/deactivation integrated
- [ ] DB types regenerated
- [ ] All pgTAP tests pass: `supabase test db`
- [ ] All integration tests pass: `pnpm --filter web test -- -c vitest.integration.config.ts run src/__tests__/integration/chefbyte`
- [ ] All flow tests pass: `pnpm --filter web test -- -c vitest.integration.config.ts run src/__tests__/flows/chefbyte-scanner src/__tests__/flows/chefbyte-mealprep src/__tests__/flows/chefbyte-shopping`
- [ ] `pnpm typecheck` passes
