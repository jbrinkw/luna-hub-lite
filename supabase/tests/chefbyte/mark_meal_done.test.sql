BEGIN;
SELECT plan(34);

-- ─────────────────────────────────────────────────────────────
-- Setup
-- ─────────────────────────────────────────────────────────────

SELECT tests.create_supabase_user('meal_tester');
SELECT tests.authenticate_as('meal_tester');
SELECT hub.activate_app('chefbyte');

-- Get Fridge location
SELECT location_id AS fridge_id
  FROM chefbyte.locations
  WHERE user_id = tests.get_supabase_uid('meal_tester') AND name = 'Fridge' \gset

-- Create Chicken product: 4 spc, 165cal/31p/3.6f/0c per serving
INSERT INTO chefbyte.products (product_id, user_id, name,
  servings_per_container, calories_per_serving, protein_per_serving,
  fat_per_serving, carbs_per_serving)
VALUES (
  '30000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('meal_tester'),
  'Chicken', 4, 165, 31, 3.6, 0
);

-- Create Rice product: 3 spc, 130cal/2.7p/0.3f/28c per serving
INSERT INTO chefbyte.products (product_id, user_id, name,
  servings_per_container, calories_per_serving, protein_per_serving,
  fat_per_serving, carbs_per_serving)
VALUES (
  '30000000-0000-0000-0000-000000000002',
  tests.get_supabase_uid('meal_tester'),
  'Rice', 3, 130, 2.7, 0.3, 28
);

-- Stock both: 2 containers each in Fridge
INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
VALUES
  (tests.get_supabase_uid('meal_tester'), '30000000-0000-0000-0000-000000000001',
   :'fridge_id', 2.0, '2026-03-20'),
  (tests.get_supabase_uid('meal_tester'), '30000000-0000-0000-0000-000000000002',
   :'fridge_id', 2.0, '2026-03-25');

-- Create recipe: Chicken Rice Bowl, base_servings=2
INSERT INTO chefbyte.recipes (recipe_id, user_id, name, base_servings)
VALUES (
  '40000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('meal_tester'),
  'Chicken Rice Bowl', 2
);

-- Ingredients: 1 container chicken, 1 container rice
INSERT INTO chefbyte.recipe_ingredients (user_id, recipe_id, product_id, quantity, unit)
VALUES
  (tests.get_supabase_uid('meal_tester'),
   '40000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', 1, 'container'),
  (tests.get_supabase_uid('meal_tester'),
   '40000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000002', 1, 'container');

-- ─────────────────────────────────────────────────────────────
-- Test 1: Create regular meal plan entry (recipe, servings=1)
-- ─────────────────────────────────────────────────────────────

INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
) VALUES (
  '50000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('meal_tester'),
  '40000000-0000-0000-0000-000000000001',
  '2026-03-03', 1, false
);

-- Capture the return value from the first call to verify success=true
SELECT is(
  (SELECT (chefbyte.mark_meal_done('50000000-0000-0000-0000-000000000001'::uuid))->>'success'),
  'true',
  'first mark_meal_done call returns success=true'
);

-- ─────────────────────────────────────────────────────────────
-- Test 2: Calling again on already-completed meal returns success=false
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT (chefbyte.mark_meal_done('50000000-0000-0000-0000-000000000001'::uuid))->>'success'),
  'false',
  'calling mark_meal_done on already-completed meal returns success=false'
);

-- ─────────────────────────────────────────────────────────────
-- Test 3: Chicken stock reduced by 1 container (2.0 → 1.0)
-- qty = ingredient.quantity(1) * meal.servings(1) = 1 container
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000001'),
  1.000::numeric,
  'chicken stock reduced from 2.0 to 1.0 after regular meal'
);

-- ─────────────────────────────────────────────────────────────
-- Test 4: Rice stock reduced by 1 container (2.0 → 1.0)
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000002'),
  1.000::numeric,
  'rice stock reduced from 2.0 to 1.0 after regular meal'
);

-- ─────────────────────────────────────────────────────────────
-- Test 5: food_logs has entries for both ingredients
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND logical_date = '2026-03-03'),
  2,
  'food_logs has 2 entries (one per ingredient) after regular meal'
);

-- ─────────────────────────────────────────────────────────────
-- Test 6: Verify macro VALUES on food_log — Chicken entry
-- Recipe base_servings=2, meal servings=1
-- Chicken ingredient: qty=1 container * meal_servings=1 = 1 container consumed
-- 1 container * 4 spc * 165cal = 660cal, 4*31=124p, 4*3.6=14.4f, 4*0=0c
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT calories FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000001'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  660.000::numeric,
  'food_log chicken calories = 1 container * 4 spc * 165 = 660'
);

SELECT is(
  (SELECT protein FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000001'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  124.000::numeric,
  'food_log chicken protein = 1 container * 4 spc * 31 = 124'
);

SELECT is(
  (SELECT fat FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000001'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  14.400::numeric,
  'food_log chicken fat = 1 container * 4 spc * 3.6 = 14.4'
);

-- ─────────────────────────────────────────────────────────────
-- Test 7-8: Verify macro VALUES on food_log — Rice entry
-- Rice ingredient: qty=1 container * meal_servings=1 = 1 container consumed
-- 1 container * 3 spc * 130cal = 390cal, 3*2.7=8.1p, 3*0.3=0.9f, 3*28=84c
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT calories FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000002'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  390.000::numeric,
  'food_log rice calories = 1 container * 3 spc * 130 = 390'
);

SELECT is(
  (SELECT carbs FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000002'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  84.000::numeric,
  'food_log rice carbs = 1 container * 3 spc * 28 = 84'
);

-- ─────────────────────────────────────────────────────────────
-- Test 9: Meal entry has completed_at set (NOT NULL)
-- ─────────────────────────────────────────────────────────────

SELECT isnt(
  (SELECT completed_at FROM chefbyte.meal_plan_entries
    WHERE meal_id = '50000000-0000-0000-0000-000000000001'),
  NULL::timestamptz,
  'completed_at is set (NOT NULL) after mark_meal_done'
);

-- ─────────────────────────────────────────────────────────────
-- Test 7: Marking already-completed meal returns success=false
-- (already tested in test 2, but here we verify the error msg)
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT (chefbyte.mark_meal_done('50000000-0000-0000-0000-000000000001'::uuid))->>'error'),
  'Meal already completed',
  'already-completed meal returns error message'
);

-- ─────────────────────────────────────────────────────────────
-- Test 8: Create meal-prep entry (same recipe, servings=2)
-- ─────────────────────────────────────────────────────────────

INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
) VALUES (
  '50000000-0000-0000-0000-000000000002',
  tests.get_supabase_uid('meal_tester'),
  '40000000-0000-0000-0000-000000000001',
  '2026-03-03', 2, true
);

SELECT lives_ok(
  $$
    SELECT chefbyte.mark_meal_done('50000000-0000-0000-0000-000000000002'::uuid)
  $$,
  'mark_meal_done on meal-prep entry succeeds'
);

-- ─────────────────────────────────────────────────────────────
-- Test 9: mark_meal_done returns success=true for meal prep
-- (verify via completed_at being set)
-- ─────────────────────────────────────────────────────────────

SELECT isnt(
  (SELECT completed_at FROM chefbyte.meal_plan_entries
    WHERE meal_id = '50000000-0000-0000-0000-000000000002'),
  NULL::timestamptz,
  'meal-prep entry has completed_at set after mark_meal_done'
);

-- ─────────────────────────────────────────────────────────────
-- Test 10: [MEAL] product created with correct name pattern
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND name LIKE '[MEAL] Chicken Rice Bowl 03-03%'),
  1,
  '[MEAL] product created with correct name pattern'
);

-- ─────────────────────────────────────────────────────────────
-- Test 11: [MEAL] stock lot created with qty_containers=1
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT sl.qty_containers FROM chefbyte.stock_lots sl
    JOIN chefbyte.products p ON sl.product_id = p.product_id
    WHERE p.user_id = tests.get_supabase_uid('meal_tester')
      AND p.name LIKE '[MEAL] Chicken Rice Bowl 03-03%'),
  1.000::numeric,
  '[MEAL] stock lot created with qty_containers=1'
);

-- ─────────────────────────────────────────────────────────────
-- Test: [MEAL] stock lot expires_on = logical_date + 7
-- logical_date = 2026-03-03, so expires_on = 2026-03-10
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT sl.expires_on FROM chefbyte.stock_lots sl
    JOIN chefbyte.products p ON sl.product_id = p.product_id
    WHERE p.user_id = tests.get_supabase_uid('meal_tester')
      AND p.name LIKE '[MEAL] Chicken Rice Bowl 03-03%'),
  '2026-03-10'::date,
  '[MEAL] stock lot expires_on = logical_date + 7 (2026-03-10)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 12: No food_logs created for meal prep
-- (still only the 2 from the regular meal)
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND logical_date = '2026-03-03'),
  2,
  'no food_logs created for meal prep — still only 2 from regular meal'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Verify [MEAL] product per-serving macro values
-- NOTE on base_servings: The mark_meal_done function intentionally
-- ignores recipe.base_servings. It uses ingredient.quantity * meal.servings
-- directly for consumption. This means base_servings is a UI hint only;
-- the function treats each meal entry's servings field as the multiplier.
--
-- Chicken: 1 container * 2 servings = 2 containers → 2*4*165=1320cal,
--          2*4*31=248p, 2*4*3.6=28.8f, 2*4*0=0c
-- Rice:    1 container * 2 servings = 2 containers → 2*3*130=780cal,
--          2*3*2.7=16.2p, 2*3*0.3=1.8f, 2*3*28=168c
-- Total: 2100cal, 264.2p, 30.6f, 168c
-- Per serving (servings_per_container=2): 1050cal, 132.1p, 15.3f, 84c
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT calories_per_serving FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND name LIKE '[MEAL] Chicken Rice Bowl 03-03%'),
  1050.000::numeric,
  '[MEAL] product calories_per_serving = 2100 / 2 = 1050'
);

SELECT is(
  (SELECT protein_per_serving FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND name LIKE '[MEAL] Chicken Rice Bowl 03-03%'),
  132.100::numeric,
  '[MEAL] product protein_per_serving = 264.2 / 2 = 132.1'
);

SELECT is(
  (SELECT fat_per_serving FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND name LIKE '[MEAL] Chicken Rice Bowl 03-03%'),
  15.300::numeric,
  '[MEAL] product fat_per_serving = 30.6 / 2 = 15.3'
);

SELECT is(
  (SELECT carbs_per_serving FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND name LIKE '[MEAL] Chicken Rice Bowl 03-03%'),
  84.000::numeric,
  '[MEAL] product carbs_per_serving = 168 / 2 = 84'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Verify ingredient stock deducted after meal-prep
-- Both chicken and rice: started 2.0, regular meal took 1.0 (→1.0),
-- meal-prep takes 2.0 more → floors at 0 (lots deleted)
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000001'),
  0,
  'chicken stock fully depleted after meal-prep (2.0 - 1.0 regular - 2.0 prep = 0)'
);

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000002'),
  0,
  'rice stock fully depleted after meal-prep (2.0 - 1.0 regular - 2.0 prep = 0)'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Product-based meal path (no recipe)
-- Create a product-based meal_plan_entry (product_id, no recipe_id)
-- Oats: 2 spc, 150cal/5p/3f/27c per serving, stock 1 container in Fridge
-- ─────────────────────────────────────────────────────────────

INSERT INTO chefbyte.products (product_id, user_id, name,
  servings_per_container, calories_per_serving, protein_per_serving,
  fat_per_serving, carbs_per_serving)
VALUES (
  '30000000-0000-0000-0000-000000000003',
  tests.get_supabase_uid('meal_tester'),
  'Oats', 2, 150, 5, 3, 27
);

INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
VALUES (
  tests.get_supabase_uid('meal_tester'), '30000000-0000-0000-0000-000000000003',
  :'fridge_id', 3.0, '2026-03-28'
);

INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, product_id, logical_date, servings, meal_prep
) VALUES (
  '50000000-0000-0000-0000-000000000003',
  tests.get_supabase_uid('meal_tester'),
  '30000000-0000-0000-0000-000000000003',
  '2026-03-03', 1, false
);

SELECT lives_ok(
  $$
    SELECT chefbyte.mark_meal_done('50000000-0000-0000-0000-000000000003'::uuid)
  $$,
  'mark_meal_done on product-based meal (no recipe) succeeds'
);

-- ─────────────────────────────────────────────────────────────
-- Test 19: Product-based meal creates food_log entry
-- ─────────────────────────────────────────────────────────────

SELECT ok(
  EXISTS (
    SELECT 1 FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000003'
      AND logical_date = '2026-03-03'
  ),
  'product-based meal creates food_log entry for the product'
);

-- ─────────────────────────────────────────────────────────────
-- Test 20: Product-based meal food_log has correct macros
-- servings=1 → consume 1 container → 2 spc * 150cal = 300cal
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT calories FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000003'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  300.000::numeric,
  'product-based meal food_log calories = 1 container * 2 spc * 150 = 300'
);

SELECT is(
  (SELECT protein FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000003'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  10.000::numeric,
  'product-based meal food_log protein = 1 container * 2 spc * 5 = 10'
);

SELECT is(
  (SELECT fat FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000003'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  6.000::numeric,
  'product-based meal food_log fat = 1 container * 2 spc * 3 = 6'
);

SELECT is(
  (SELECT carbs FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000003'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  54.000::numeric,
  'product-based meal food_log carbs = 1 container * 2 spc * 27 = 54'
);

-- ─────────────────────────────────────────────────────────────
-- Test 23: Product-based meal deducts stock (3.0 → 2.0)
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000003'),
  2.000::numeric,
  'product-based meal oats stock reduced from 3.0 to 2.0'
);

-- ─────────────────────────────────────────────────────────────
-- Test 24: Product-based meal completed_at is set
-- ─────────────────────────────────────────────────────────────

SELECT isnt(
  (SELECT completed_at FROM chefbyte.meal_plan_entries
    WHERE meal_id = '50000000-0000-0000-0000-000000000003'),
  NULL::timestamptz,
  'product-based meal completed_at is set after mark_meal_done'
);

-- ─────────────────────────────────────────────────────────────
-- Test 25: Cross-user isolation — User B cannot mark User A's meal
-- ─────────────────────────────────────────────────────────────

SELECT tests.clear_authentication();
SELECT tests.create_supabase_user('meal_intruder');
SELECT tests.authenticate_as('meal_intruder');
SELECT hub.activate_app('chefbyte');

-- Create a new uncompleted meal for meal_tester to attempt marking
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('meal_tester');

INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, product_id, logical_date, servings, meal_prep
) VALUES (
  '50000000-0000-0000-0000-000000000004',
  tests.get_supabase_uid('meal_tester'),
  '30000000-0000-0000-0000-000000000003',
  '2026-03-04', 1, false
);

-- Switch to intruder and try to mark meal_tester's meal
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('meal_intruder');

SELECT throws_ok(
  $$
    SELECT chefbyte.mark_meal_done('50000000-0000-0000-0000-000000000004'::uuid)
  $$,
  'Meal not found or not owned by user',
  'User B cannot mark_meal_done on User A meal (cross-user isolation)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 26: Verify User A's meal is still uncompleted after intruder attempt
-- ─────────────────────────────────────────────────────────────

SELECT tests.clear_authentication();
SELECT tests.authenticate_as('meal_tester');

SELECT is(
  (SELECT completed_at FROM chefbyte.meal_plan_entries
    WHERE meal_id = '50000000-0000-0000-0000-000000000004'),
  NULL::timestamptz,
  'User A meal still uncompleted after User B attempt'
);

-- ─────────────────────────────────────────────────────────────
-- Teardown
-- ─────────────────────────────────────────────────────────────

SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('meal_intruder');
SELECT tests.delete_supabase_user('meal_tester');

SELECT * FROM finish();
ROLLBACK;
