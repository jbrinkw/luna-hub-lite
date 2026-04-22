-- Atomicity + stock-precheck tests for private.mark_meal_done.
--
-- Covers behavior introduced in 20260424070000_mark_meal_done_atomic.sql:
--   * FOR UPDATE lock on meal_plan_entry
--   * Pre-check ingredient stock before any mutation
--   * RAISE on insufficient stock → full rollback (zero partial state)
--   * Richer JSONB return payload (mode / deducted / food_log_ids)
--   * RAISE on already-completed (instead of returning success=false)
--   * Cross-user isolation (RAISE "not found")

BEGIN;
SELECT plan(10);

-- ─────────────────────────────────────────────────────────────
-- Setup
-- ─────────────────────────────────────────────────────────────
SELECT tests.create_supabase_user('atomic_tester');
SELECT tests.authenticate_as('atomic_tester');
SELECT hub.activate_app('chefbyte');

SELECT location_id AS fridge_id
  FROM chefbyte.locations
  WHERE user_id = tests.get_supabase_uid('atomic_tester') AND name = 'Fridge' \gset

-- Two products: Chicken (plenty of stock) + Rice (insufficient stock).
INSERT INTO chefbyte.products (product_id, user_id, name,
  servings_per_container, calories_per_serving, protein_per_serving,
  fat_per_serving, carbs_per_serving)
VALUES (
  '70000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('atomic_tester'),
  'AtomicChicken', 4, 165, 31, 3.6, 0
);

INSERT INTO chefbyte.products (product_id, user_id, name,
  servings_per_container, calories_per_serving, protein_per_serving,
  fat_per_serving, carbs_per_serving)
VALUES (
  '70000000-0000-0000-0000-000000000002',
  tests.get_supabase_uid('atomic_tester'),
  'AtomicRice', 3, 130, 2.7, 0.3, 28
);

-- Chicken: 5 containers (plenty). Rice: 0.1 container (NOT enough
-- when the recipe calls for 1 container scaled by 1.0).
INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
VALUES
  (tests.get_supabase_uid('atomic_tester'), '70000000-0000-0000-0000-000000000001',
   :'fridge_id', 5.0, '2026-05-20'),
  (tests.get_supabase_uid('atomic_tester'), '70000000-0000-0000-0000-000000000002',
   :'fridge_id', 0.1, '2026-05-25');

INSERT INTO chefbyte.recipes (recipe_id, user_id, name, base_servings)
VALUES (
  '80000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('atomic_tester'),
  'AtomicBowl', 2
);

INSERT INTO chefbyte.recipe_ingredients (user_id, recipe_id, product_id, quantity, unit)
VALUES
  (tests.get_supabase_uid('atomic_tester'),
   '80000000-0000-0000-0000-000000000001',
   '70000000-0000-0000-0000-000000000001', 1, 'container'),
  (tests.get_supabase_uid('atomic_tester'),
   '80000000-0000-0000-0000-000000000001',
   '70000000-0000-0000-0000-000000000002', 1, 'container');

-- Meal with servings=2 → scale_factor 1.0 → needs 1 chicken + 1 rice.
-- Rice stock is only 0.1 → mark_meal_done must raise and roll back.
INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
) VALUES (
  '90000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('atomic_tester'),
  '80000000-0000-0000-0000-000000000001',
  '2026-04-10', 2, false
);

-- ─────────────────────────────────────────────────────────────
-- T1: Insufficient-stock raises (full rollback)
-- ─────────────────────────────────────────────────────────────

SELECT throws_like(
  $$ SELECT chefbyte.mark_meal_done('90000000-0000-0000-0000-000000000001'::uuid) $$,
  'Insufficient stock for AtomicRice%',
  'mark_meal_done raises "Insufficient stock" when an ingredient is short'
);

-- ─────────────────────────────────────────────────────────────
-- T2: Chicken stock untouched after the raise (no partial deduct)
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('atomic_tester')
      AND product_id = '70000000-0000-0000-0000-000000000001'),
  5.000::numeric,
  'chicken stock untouched after insufficient-stock raise (rollback)'
);

-- ─────────────────────────────────────────────────────────────
-- T3: Rice stock untouched after the raise
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('atomic_tester')
      AND product_id = '70000000-0000-0000-0000-000000000002'),
  0.100::numeric,
  'rice stock untouched after insufficient-stock raise (rollback)'
);

-- ─────────────────────────────────────────────────────────────
-- T4: Meal stays uncompleted after the raise
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT completed_at FROM chefbyte.meal_plan_entries
    WHERE meal_id = '90000000-0000-0000-0000-000000000001'),
  NULL::timestamptz,
  'meal stays uncompleted after insufficient-stock raise'
);

-- ─────────────────────────────────────────────────────────────
-- T5: No food_logs created during the raised call
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('atomic_tester')
      AND meal_id = '90000000-0000-0000-0000-000000000001'),
  0,
  'no food_logs created during the raised mark_meal_done call'
);

-- ─────────────────────────────────────────────────────────────
-- Refill rice and run happy path, then verify rich return shape.
-- ─────────────────────────────────────────────────────────────

INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
VALUES (
  tests.get_supabase_uid('atomic_tester'), '70000000-0000-0000-0000-000000000002',
  :'fridge_id', 2.0, '2026-05-26'
);

-- ─────────────────────────────────────────────────────────────
-- T6: Happy path — mode='recipe'
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT (chefbyte.mark_meal_done('90000000-0000-0000-0000-000000000001'::uuid))->>'mode'),
  'recipe',
  'happy path return payload has mode=recipe'
);

-- ─────────────────────────────────────────────────────────────
-- T7: Meal completed_at set after happy path
-- ─────────────────────────────────────────────────────────────

SELECT isnt(
  (SELECT completed_at FROM chefbyte.meal_plan_entries
    WHERE meal_id = '90000000-0000-0000-0000-000000000001'),
  NULL::timestamptz,
  'meal.completed_at set after happy path'
);

-- ─────────────────────────────────────────────────────────────
-- T8: 2 food_logs written (one per ingredient), tagged with meal_id
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('atomic_tester')
      AND meal_id = '90000000-0000-0000-0000-000000000001'),
  2,
  'happy path writes 2 food_logs tagged with the meal_id'
);

-- ─────────────────────────────────────────────────────────────
-- T9: Second call raises (already completed)
-- ─────────────────────────────────────────────────────────────

SELECT throws_ok(
  $$ SELECT chefbyte.mark_meal_done('90000000-0000-0000-0000-000000000001'::uuid) $$,
  'Meal already completed',
  'second call on a completed meal raises (atomic — no silent success=false)'
);

-- ─────────────────────────────────────────────────────────────
-- T10: Cross-user isolation — user B sees "not found"
-- ─────────────────────────────────────────────────────────────

SELECT tests.clear_authentication();
SELECT tests.create_supabase_user('atomic_intruder');
SELECT tests.authenticate_as('atomic_intruder');
SELECT hub.activate_app('chefbyte');

SELECT tests.clear_authentication();
SELECT tests.authenticate_as('atomic_tester');
INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
) VALUES (
  '90000000-0000-0000-0000-000000000002',
  tests.get_supabase_uid('atomic_tester'),
  '80000000-0000-0000-0000-000000000001',
  '2026-04-11', 1, false
);

SELECT tests.clear_authentication();
SELECT tests.authenticate_as('atomic_intruder');

SELECT throws_ok(
  $$ SELECT chefbyte.mark_meal_done('90000000-0000-0000-0000-000000000002'::uuid) $$,
  'Meal not found or not owned by user',
  'cross-user: user B cannot mark user A meal (raises "not found")'
);

-- ─────────────────────────────────────────────────────────────
-- Teardown
-- ─────────────────────────────────────────────────────────────
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('atomic_intruder');
SELECT tests.delete_supabase_user('atomic_tester');

SELECT * FROM finish();
ROLLBACK;
