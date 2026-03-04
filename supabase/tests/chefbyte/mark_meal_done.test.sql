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
-- Test 3: Chicken stock reduced by 0.5 container (2.0 → 1.5)
-- qty = ingredient.quantity(1) * scale_factor(1/2) = 0.5 container
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000001'),
  1.500::numeric,
  'chicken stock reduced from 2.0 to 1.5 after regular meal (scale 0.5)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 4: Rice stock reduced by 0.5 container (2.0 → 1.5)
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000002'),
  1.500::numeric,
  'rice stock reduced from 2.0 to 1.5 after regular meal (scale 0.5)'
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
-- Recipe base_servings=2, meal servings=1, scale_factor=1/2=0.5
-- Chicken ingredient: qty=1 container * 0.5 = 0.5 container consumed
-- 0.5 container * 4 spc * 165cal = 330cal, 0.5*4*31=62p, 0.5*4*3.6=7.2f
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT calories FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000001'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  330.000::numeric,
  'food_log chicken calories = 0.5 container * 4 spc * 165 = 330'
);

SELECT is(
  (SELECT protein FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000001'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  62.000::numeric,
  'food_log chicken protein = 0.5 container * 4 spc * 31 = 62'
);

SELECT is(
  (SELECT fat FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000001'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  7.200::numeric,
  'food_log chicken fat = 0.5 container * 4 spc * 3.6 = 7.2'
);

-- ─────────────────────────────────────────────────────────────
-- Test 7-8: Verify macro VALUES on food_log — Rice entry
-- Rice ingredient: qty=1 container * scale_factor(0.5) = 0.5 container consumed
-- 0.5 container * 3 spc * 130cal = 195cal, 0.5*3*2.7=4.05p, 0.5*3*0.3=0.45f, 0.5*3*28=42c
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT calories FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000002'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  195.000::numeric,
  'food_log rice calories = 0.5 container * 3 spc * 130 = 195'
);

SELECT is(
  (SELECT carbs FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000002'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  42.000::numeric,
  'food_log rice carbs = 0.5 container * 3 spc * 28 = 42'
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
-- scale_factor = meal.servings(2) / recipe.base_servings(2) = 1.0
-- Chicken: 1 container * 1.0 = 1 container → 1*4*165=660cal,
--          1*4*31=124p, 1*4*3.6=14.4f, 1*4*0=0c
-- Rice:    1 container * 1.0 = 1 container → 1*3*130=390cal,
--          1*3*2.7=8.1p, 1*3*0.3=0.9f, 1*3*28=84c
-- Total: 1050cal, 132.1p, 15.3f, 84c
-- Per serving (servings_per_container=2): 525cal, 66.05p, 7.65f, 42c
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT calories_per_serving FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND name LIKE '[MEAL] Chicken Rice Bowl 03-03%'),
  525.000::numeric,
  '[MEAL] product calories_per_serving = 1050 / 2 = 525'
);

SELECT is(
  (SELECT protein_per_serving FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND name LIKE '[MEAL] Chicken Rice Bowl 03-03%'),
  66.050::numeric,
  '[MEAL] product protein_per_serving = 132.1 / 2 = 66.05'
);

SELECT is(
  (SELECT fat_per_serving FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND name LIKE '[MEAL] Chicken Rice Bowl 03-03%'),
  7.650::numeric,
  '[MEAL] product fat_per_serving = 15.3 / 2 = 7.65'
);

SELECT is(
  (SELECT carbs_per_serving FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND name LIKE '[MEAL] Chicken Rice Bowl 03-03%'),
  42.000::numeric,
  '[MEAL] product carbs_per_serving = 84 / 2 = 42'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Verify ingredient stock deducted after meal-prep
-- Both chicken and rice: started 2.0, regular meal took 0.5 (→1.5),
-- meal-prep (scale=1.0) takes 1.0 more → 0.5 remaining
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000001'),
  0.500::numeric,
  'chicken stock after regular + meal-prep = 2.0 - 0.5 - 1.0 = 0.5'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000002'),
  0.500::numeric,
  'rice stock after regular + meal-prep = 2.0 - 0.5 - 1.0 = 0.5'
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
-- servings=1 → consume 1 serving → 1 * 150cal = 150cal
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT calories FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000003'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  150.000::numeric,
  'product-based meal food_log calories = 1 serving * 150 = 150'
);

SELECT is(
  (SELECT protein FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000003'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  5.000::numeric,
  'product-based meal food_log protein = 1 serving * 5 = 5'
);

SELECT is(
  (SELECT fat FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000003'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  3.000::numeric,
  'product-based meal food_log fat = 1 serving * 3 = 3'
);

SELECT is(
  (SELECT carbs FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000003'
      AND logical_date = '2026-03-03'
    ORDER BY created_at ASC LIMIT 1),
  27.000::numeric,
  'product-based meal food_log carbs = 1 serving * 27 = 27'
);

-- ─────────────────────────────────────────────────────────────
-- Test 23: Product-based meal deducts stock (3.0 → 2.5)
-- 1 serving / 2 spc = 0.5 containers deducted
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('meal_tester')
      AND product_id = '30000000-0000-0000-0000-000000000003'),
  2.500::numeric,
  'product-based meal oats stock reduced from 3.0 to 2.5 (1 serving = 0.5 container)'
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
