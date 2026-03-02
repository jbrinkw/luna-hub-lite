# Phase 06b: ChefByte DB — Recipes + Meal Plan + mark_meal_done
> Previous: phase-06a.md | Next: phase-06c.md

## Skills
test-driven-development, context7 (Supabase)

## Build
- Migration: `supabase/migrations/YYYYMMDD_chefbyte_recipes_mealplan.sql`
- `chefbyte.recipes` — recipe_id UUID PK, user_id FK auth.users CASCADE, name TEXT NOT NULL, description TEXT, base_servings NUMERIC(10,3) NOT NULL DEFAULT 1, active_time_minutes INTEGER, total_time_minutes INTEGER, instructions TEXT, created_at TIMESTAMPTZ
- `chefbyte.recipe_ingredients` — ingredient_id UUID PK, recipe_id FK CASCADE, product_id FK CASCADE, quantity NUMERIC(10,3) NOT NULL, unit TEXT NOT NULL CHECK (unit IN ('containers', 'servings')), note TEXT
- `chefbyte.meal_plan` — meal_id UUID PK, user_id FK auth.users CASCADE, recipe_id UUID FK nullable, product_id UUID FK nullable, servings NUMERIC(10,3) DEFAULT 1, logical_date DATE NOT NULL, meal_prep BOOLEAN DEFAULT false, status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'done')), CHECK (recipe_id IS NOT NULL OR product_id IS NOT NULL), created_at TIMESTAMPTZ
- RLS on all three tables: `(select auth.uid()) = user_id TO authenticated` (recipe_ingredients uses JOIN to recipe for user_id check)
- `private.mark_meal_done(p_user_id UUID, p_meal_id UUID)` — resolves recipe ingredients (quantity * servings multiplier), delegates to consume_product for each ingredient (nearest-expiry-first), **Regular mode** (meal_prep=false): log macros for full consumed amount, set status=done. **Meal prep mode** (meal_prep=true): consume ingredients (no macro log), auto-create [MEAL] product if needed, create stock_lot named `[MEAL] RecipeName MM-DD` with frozen nutrition snapshot, set status=done. Product-based entries: consume servings of the product directly.
- `chefbyte.mark_meal_done(p_meal_id)` — thin RPC wrapper, passes auth.uid()
- Test helper: `createRecipeWithIngredients(client, recipe, ingredients)` factory in test-helpers.ts

## Test (TDD)

### pgTAP: `supabase/tests/chefbyte/mark_meal_done.test.sql`
- Regular mode: consumes ingredients + logs macros for full amount -> food_log rows created
- Regular mode: stock shortage -> macros still logged for full consumed amount, stock floors at 0
- Meal prep mode: consumes ingredients + creates [MEAL] lot -> NO food_log entry
- Meal prep mode: [MEAL] lot has frozen nutrition snapshot matching recipe macros at execution time
- Lot depletion order: nearest expiry first across all ingredients
- Status transitions: planned -> done (both modes)
- Product-based entry (recipe_id IS NULL): regular mode consumes product + logs macros

### Integration: `apps/web/src/__tests__/integration/chefbyte/recipe-with-ingredients.test.ts`
- Create recipe + 3 ingredients -> all rows stored correctly
- Query recipe -> dynamic macro sum matches expected (sum of ingredient product macros * qty)
- Per-serving macro display: total macros / base_servings
- Total macro display: sum of all ingredients
- Delete recipe -> ingredients cascade deleted
- Delete product -> cascade to recipe_ingredients (ON DELETE CASCADE)
- Recipe with mixed units (containers + servings) -> macros compute correctly

### Integration: `apps/web/src/__tests__/integration/chefbyte/meal-plan.test.ts`
- Add regular meal entry -> status='planned', meal_prep=false
- Mark done regular -> ingredients consumed + macros logged + status='done'
- Add meal_prep entry -> mark done -> ingredients consumed + [MEAL] lot created + no macros logged
- [MEAL] lot name format: `[MEAL] RecipeName MM-DD` (date from logical_date)
- [MEAL] lot has frozen nutrition snapshot (macros match recipe at execution time)
- Product-based entry (recipe_id IS NULL, product_id set) -> mark done regular -> product consumed + macros logged
- CHECK constraint: recipe_id and product_id both NULL -> rejected
- Servings multiplier: 2 servings -> double ingredient consumption

### Flow: `apps/web/src/__tests__/flows/chefbyte-mealprep.flow.test.ts`
1. Create Chicken (200cal, 40p, 0c, 4f) + Rice (400cal, 8p, 90c, 1f)
2. Add stock: 5 containers Chicken, 5 containers Rice
3. Create recipe "Chicken & Rice" (base_servings=2): 1 container Chicken + 0.5 containers Rice
4. Verify recipe macros: total 400cal (200+200), per-serving 200cal
5. Add meal_plan entry: meal_prep=true, servings=1 (full recipe), logical_date=today
6. Execute mark_meal_done -> verify:
   - Chicken stock: 5 -> 4 (consumed 1 container)
   - Rice stock: 5 -> 4.5 (consumed 0.5 container)
   - [MEAL] lot created with 400cal total frozen nutrition
   - NO food_log entry created
   - get_daily_macros returns 0 for today
7. Consume 0.5 of [MEAL] lot via consume_product(log_macros=true) -> verify:
   - [MEAL] lot qty: 1 -> 0.5
   - food_log created with 200cal (half of frozen 400cal)
   - get_daily_macros returns correct totals (200cal)

## Legacy Reference
- `legacy/chefbyte-vercel/apps/web/src/lib/api-supabase.ts` — recipe/meal plan Supabase queries
- `legacy/luna-ext-chefbyte/lib/services/products.py` — meal prep logic, [MEAL] lot creation
- `legacy/chefbyte-vercel/apps/web/src/pages/MealPlan.tsx` — meal plan UI patterns
- `legacy/chefbyte-vercel/apps/web/src/pages/RecipeCreate.tsx` — recipe + ingredient creation

## Commit
`feat: chefbyte recipes + meal plan + mark_meal_done`

## Acceptance
- [ ] Recipes + recipe_ingredients tables with CASCADE FKs and RLS
- [ ] Meal plan table with CHECK constraints and status enum
- [ ] mark_meal_done: regular mode consumes + logs macros, meal prep mode consumes + creates [MEAL] lot
- [ ] [MEAL] lots have frozen nutrition snapshot
- [ ] createRecipeWithIngredients test helper available
- [ ] pgTAP tests pass: `supabase test db --grep chefbyte/mark_meal_done`
- [ ] Integration tests pass: `pnpm --filter web test -- -c vitest.integration.config.ts run src/__tests__/integration/chefbyte/recipe-with-ingredients src/__tests__/integration/chefbyte/meal-plan`
- [ ] Flow test passes: `pnpm --filter web test -- -c vitest.integration.config.ts run src/__tests__/flows/chefbyte-mealprep`
- [ ] `pnpm typecheck` passes
