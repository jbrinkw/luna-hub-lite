# Phase 06c: ChefByte DB — Shopping + Macros + Logging + Flow Tests

> Previous: phase-06b.md | Next: phase-06d.md

## Skills

test-driven-development, test-quality-review, context7 (Supabase)

## Build

- Migration: `supabase/migrations/YYYYMMDD_chefbyte_shopping_macros.sql`
- `chefbyte.shopping_list` — shopping_id UUID PK, user_id FK auth.users CASCADE, product_id FK CASCADE, qty_containers NUMERIC(10,3) NOT NULL DEFAULT 1, purchased BOOLEAN DEFAULT false, UNIQUE(user_id, product_id)
- `chefbyte.food_logs` — log_id UUID PK, user_id FK auth.users CASCADE, product_id UUID FK SET NULL, qty_consumed_containers NUMERIC(10,3), calories NUMERIC(10,3), protein NUMERIC(10,3), carbs NUMERIC(10,3), fats NUMERIC(10,3), logical_date DATE NOT NULL, created_at TIMESTAMPTZ
- `chefbyte.temp_items` — temp_id UUID PK, user_id FK auth.users CASCADE, name TEXT NOT NULL, calories NUMERIC(10,3), protein_g NUMERIC(10,3), carbs_g NUMERIC(10,3), fats_g NUMERIC(10,3), logical_date DATE NOT NULL, created_at TIMESTAMPTZ
- `chefbyte.target_macros` — target_id UUID PK, user_id FK auth.users CASCADE UNIQUE, target_calories NUMERIC(10,3), target_protein_g NUMERIC(10,3), target_carbs_g NUMERIC(10,3), target_fats_g NUMERIC(10,3), taste_profile TEXT
- Index: `(user_id, logical_date)` on food_logs and temp_items
- RLS on all tables: `(select auth.uid()) = user_id TO authenticated`
- `private.get_daily_macros(p_user_id UUID, p_logical_date DATE)` — aggregate food_logs + temp_items + liquidtrack_events for the given date, return JSON with calories/protein/carbs/fats totals
- `private.sync_meal_plan_to_shopping(p_user_id UUID, p_days_ahead INTEGER)` — scan meal_plan for next p_days_ahead days from today's logical_date, aggregate recipe ingredient requirements (qty \* servings multiplier), convert to containers via servings_per_container, subtract current inventory aggregated across lots, round up to whole containers, flag placeholder products, ON CONFLICT update qty
- `private.import_shopping_to_inventory(p_user_id UUID)` — bulk import purchased non-placeholder shopping rows into stock_lots, clear imported items
- `chefbyte.get_daily_macros(p_logical_date)`, `chefbyte.sync_meal_plan_to_shopping(p_days)`, `chefbyte.import_shopping_to_inventory()` — thin RPC wrappers

## Test (TDD)

### pgTAP: `supabase/tests/chefbyte/get_daily_macros.test.sql`

- No logs for date -> returns zeros for all four macro fields
- Single food_log -> returns that log's macros
- Multiple food_logs + temp_items -> returns correct aggregate sum
- Handles liquidtrack_events in aggregate (once table exists in phase-06d, initially empty)
- Different logical_date -> not included in aggregate
- Multiple products in food_logs -> all summed correctly

### pgTAP: `supabase/tests/chefbyte/sync_shopping.test.sql`

- 7-day scan of meal_plan -> correct entries found
- Recipe ingredient aggregation across multiple meals of same recipe
- Convert servings to containers via servings_per_container
- Subtract current inventory aggregated across lots
- Round up to whole containers (CEIL)
- Flag placeholder products (is_placeholder=true)
- Merge with existing shopping items (ON CONFLICT updates qty)
- Products with sufficient inventory -> not added to list
- Manual items preserved on re-sync (items not linked to meal plan untouched)
- Product-based meal entries included in sync

### Integration: `apps/web/src/__tests__/integration/chefbyte/macro-logging.test.ts`

- Consume product with p_log_macros=true -> food_log created with correct macros (qty \* per-container nutrition)
- Log temp_item -> row created with name + macros + logical_date
- get_daily_macros returns sum of food_logs + temp_items
- Day history: multiple logs on same day -> all returned
- Different logical_date logs -> excluded from query
- Pagination: insert 25 days of logs, query page 1 -> 20 results, cursor -> remaining 5

### Integration: `apps/web/src/__tests__/integration/chefbyte/shopping-list.test.ts`

- Add item -> shopping_list row created with correct qty
- Add same product -> qty merged via ON CONFLICT (qty = qty + new_qty)
- Mark purchased -> purchased=true
- Bulk import: mark items purchased -> import_shopping_to_inventory -> stock lots created + shopping items cleared
- Import skips placeholder products (is_placeholder=true)
- Import skips unpurchased items
- Auto-add below min stock: product below threshold -> deficit added to shopping list
- Products at or above min stock -> not added

### Flow: `apps/web/src/__tests__/flows/chefbyte-scanner.flow.test.ts`

1. Set target macros (2000 cal, 150p, 200c, 80f)
2. **Purchase mode:** Create product (300cal, 30p, 40c, 10f) + add stock (qty=1, location=Pantry, expires in 7 days) -> verify lot created
3. **Consume+Macros mode:** Consume 0.5 containers -> verify stock reduced to 0.5 -> verify food_log created (150cal, 15p, 20c, 5f) -> verify get_daily_macros shows consumed amounts
4. **Consume-NoMacros mode:** Consume 0.3 containers -> verify stock reduced to 0.2 -> verify NO new food_log -> get_daily_macros unchanged
5. **Add-to-Shopping mode:** Create second product -> add to shopping list (qty=1) -> verify shopping_list row exists -> verify inventory NOT affected

### Flow: `apps/web/src/__tests__/flows/chefbyte-shopping.flow.test.ts`

1. Create products: Chicken (servings_per_container=4), Rice (servings_per_container=2), Broccoli (is_placeholder=true, servings_per_container=1)
2. Add stock: 2 containers Chicken, 0 Rice, 3 Broccoli
3. Create recipe (base_servings=2): 1 container Chicken + 0.5 containers Rice + 1 container Broccoli
4. Add recipe to meal plan for each of next 3 days (3 meals, servings=1 each)
5. sync_meal_plan_to_shopping(7) -> verify:
   - Chicken: need 3\*1=3, have 2, buy 1
   - Rice: need 3\*0.5=1.5, have 0, buy 2 (rounded up)
   - Broccoli: need 3\*1=3, have 3, buy 0
   - Broccoli flagged as placeholder
6. Manually add unrelated product to shopping list (qty=2)
7. Re-sync -> verify manual item preserved, meal plan items updated correctly

### Quality gate

After all tests in each layer pass, dispatch `test-quality-review` per-batch before marking done.

## Legacy Reference

- `legacy/chefbyte-vercel/apps/web/src/lib/api-supabase.ts` — shopping list queries, macro aggregation, import flow
- `legacy/luna-ext-chefbyte/lib/macro_tracking/` — daily aggregation logic, day utils
- `legacy/chefbyte-vercel/apps/web/src/pages/ShoppingList.tsx` — add/check/import UI patterns
- `legacy/chefbyte-vercel/apps/web/src/pages/Home.tsx` — macro display, temp items

## Commit

`feat: chefbyte shopping + macros + logging + flow tests`

## Acceptance

- [ ] Shopping list with UNIQUE(user_id, product_id) and ON CONFLICT merge
- [ ] Food logs, temp items, target macros tables with RLS
- [ ] get_daily_macros aggregates food_logs + temp_items (+ liquidtrack_events once available)
- [ ] sync_meal_plan_to_shopping: 7-day scan, deficit calc, rounding, placeholder flagging
- [ ] import_shopping_to_inventory: bulk import purchased non-placeholder -> stock lots
- [ ] pgTAP tests pass: `supabase test db --grep chefbyte/get_daily_macros` and `supabase test db --grep chefbyte/sync_shopping`
- [ ] Integration tests pass: `pnpm --filter web test -- -c vitest.integration.config.ts run src/__tests__/integration/chefbyte/macro-logging src/__tests__/integration/chefbyte/shopping-list`
- [ ] Flow tests pass: `pnpm --filter web test -- -c vitest.integration.config.ts run src/__tests__/flows/chefbyte-scanner src/__tests__/flows/chefbyte-shopping`
- [ ] `pnpm typecheck` passes
