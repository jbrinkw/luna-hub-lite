BEGIN;
SELECT plan(12);

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

SELECT lives_ok(
  $$
    SELECT chefbyte.mark_meal_done('50000000-0000-0000-0000-000000000001'::uuid)
  $$,
  'mark_meal_done on regular recipe meal succeeds'
);

-- ─────────────────────────────────────────────────────────────
-- Test 2: Returns success=true
-- ─────────────────────────────────────────────────────────────

-- Already called above; verify completed_at is set instead
-- We re-call to check the return, but it was already completed.
-- Instead, check the state left behind.
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
-- Test 6: Meal entry has completed_at set (NOT NULL)
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
-- Teardown
-- ─────────────────────────────────────────────────────────────

SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('meal_tester');

SELECT * FROM finish();
ROLLBACK;
