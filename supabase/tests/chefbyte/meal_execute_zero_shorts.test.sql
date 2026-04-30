-- meal_execute_zero_shorts: zero-shorts behaviour for mark_meal_done
--
-- Covers the new behaviour from 20260430020000_meal_execute_unification.sql:
--   * Partial stock: deduct available, complete meal, log partial macros
--   * Zero stock: skip ingredient deduct, still complete meal
--   * Partials array in return payload
--   * Full-stock happy path: no partials in return
--   * Meal-prep partial: [MEAL] lot created with partial-yield macros
--   * Already-completed still raises (unchanged)

BEGIN;
SELECT plan(14);

-- ─────────────────────────────────────────────────────────────
-- Setup
-- ─────────────────────────────────────────────────────────────
SELECT tests.create_supabase_user('zero_shorts_tester');
SELECT tests.authenticate_as('zero_shorts_tester');
SELECT hub.activate_app('chefbyte');

SELECT location_id AS fridge_id
  FROM chefbyte.locations
  WHERE user_id = tests.get_supabase_uid('zero_shorts_tester') AND name = 'Fridge' \gset

-- Products
INSERT INTO chefbyte.products (product_id, user_id, name,
  servings_per_container, calories_per_serving, protein_per_serving,
  fat_per_serving, carbs_per_serving)
VALUES
  (
    'a0000000-0000-0000-0000-000000000001',
    tests.get_supabase_uid('zero_shorts_tester'),
    'ZeroChicken', 4, 160, 30, 4, 0
  ),
  (
    'a0000000-0000-0000-0000-000000000002',
    tests.get_supabase_uid('zero_shorts_tester'),
    'ZeroRice', 3, 120, 3, 1, 25
  );

-- Chicken: 5 containers (full stock)
-- Rice: 0 containers (completely out of stock)
INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
VALUES
  (tests.get_supabase_uid('zero_shorts_tester'), 'a0000000-0000-0000-0000-000000000001',
   :'fridge_id', 5.0, '2026-06-01');
-- No rice lot inserted — stock = 0.

-- Recipe using 1 container chicken + 1 container rice (base_servings=1)
INSERT INTO chefbyte.recipes (recipe_id, user_id, name, base_servings)
VALUES (
  'b0000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('zero_shorts_tester'),
  'ZeroBowl', 1
);

INSERT INTO chefbyte.recipe_ingredients (user_id, recipe_id, product_id, quantity, unit)
VALUES
  (tests.get_supabase_uid('zero_shorts_tester'),
   'b0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000001', 1, 'container'),
  (tests.get_supabase_uid('zero_shorts_tester'),
   'b0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000002', 1, 'container');

-- Meal 1: non-prep recipe meal (rice out of stock)
INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
) VALUES (
  'c0000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('zero_shorts_tester'),
  'b0000000-0000-0000-0000-000000000001',
  '2026-05-01', 1, false
);

-- ─────────────────────────────────────────────────────────────
-- T1: Partial stock — mark_meal_done succeeds (no RAISE)
-- ─────────────────────────────────────────────────────────────
SELECT lives_ok(
  $$ SELECT chefbyte.mark_meal_done('c0000000-0000-0000-0000-000000000001'::uuid) $$,
  'mark_meal_done completes with zero-stock ingredient (no raise)'
);

-- ─────────────────────────────────────────────────────────────
-- T2: Meal is marked completed despite missing rice
-- ─────────────────────────────────────────────────────────────
SELECT isnt(
  (SELECT completed_at FROM chefbyte.meal_plan_entries
    WHERE meal_id = 'c0000000-0000-0000-0000-000000000001'),
  NULL::timestamptz,
  'meal is marked completed even with zero-stock ingredient'
);

-- ─────────────────────────────────────────────────────────────
-- T3: Chicken deducted (1 container → 4 remaining)
-- ─────────────────────────────────────────────────────────────
SELECT is(
  (SELECT COALESCE(SUM(qty_containers), 0::numeric)
     FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('zero_shorts_tester')
      AND product_id = 'a0000000-0000-0000-0000-000000000001'),
  4.000::numeric,
  'chicken deducted (1 container taken from 5)'
);

-- ─────────────────────────────────────────────────────────────
-- T4: Rice stock stays at 0 (nothing to deduct, no negative lots)
-- ─────────────────────────────────────────────────────────────
SELECT is(
  (SELECT COALESCE(SUM(qty_containers), 0::numeric)
     FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('zero_shorts_tester')
      AND product_id = 'a0000000-0000-0000-0000-000000000002'),
  0.000::numeric,
  'rice stock stays at 0 — no negative lots created'
);

-- ─────────────────────────────────────────────────────────────
-- T5: food_log written only for chicken (rice skipped, qty=0 not logged)
-- ─────────────────────────────────────────────────────────────
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('zero_shorts_tester')
      AND meal_id = 'c0000000-0000-0000-0000-000000000001'),
  1,
  'exactly 1 food_log (chicken only) — zero-stock rice not logged'
);

-- ─────────────────────────────────────────────────────────────
-- T6: partials array in return contains the rice entry
-- ─────────────────────────────────────────────────────────────

-- Re-mark a fresh meal to test the return payload.
-- We need a fresh (uncompleted) meal for this.
INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
) VALUES (
  'c0000000-0000-0000-0000-000000000099',
  tests.get_supabase_uid('zero_shorts_tester'),
  'b0000000-0000-0000-0000-000000000001',
  '2026-05-02', 1, false
);

SELECT is(
  jsonb_array_length(
    (SELECT chefbyte.mark_meal_done('c0000000-0000-0000-0000-000000000099'::uuid))->'partials'
  ),
  1,
  'partials array has 1 entry (rice is short)'
);

-- ─────────────────────────────────────────────────────────────
-- T7: partials[0].product_id matches rice
-- ─────────────────────────────────────────────────────────────

-- Meal 99 is now done; we need a third meal for return-payload inspection.
INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
) VALUES (
  'c0000000-0000-0000-0000-000000000098',
  tests.get_supabase_uid('zero_shorts_tester'),
  'b0000000-0000-0000-0000-000000000001',
  '2026-05-03', 1, false
);

SELECT is(
  (SELECT chefbyte.mark_meal_done('c0000000-0000-0000-0000-000000000098'::uuid)
  )->'partials'->0->>'product_id',
  'a0000000-0000-0000-0000-000000000002',
  'partials[0].product_id is rice UUID'
);

-- ─────────────────────────────────────────────────────────────
-- T8: Full-stock happy path — partials is empty array
-- ─────────────────────────────────────────────────────────────

-- Refill rice for the next tests.
INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
VALUES
  (tests.get_supabase_uid('zero_shorts_tester'), 'a0000000-0000-0000-0000-000000000002',
   :'fridge_id', 5.0, '2026-06-15');

INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
) VALUES (
  'c0000000-0000-0000-0000-000000000010',
  tests.get_supabase_uid('zero_shorts_tester'),
  'b0000000-0000-0000-0000-000000000001',
  '2026-05-04', 1, false
);

SELECT is(
  jsonb_array_length(
    (SELECT chefbyte.mark_meal_done('c0000000-0000-0000-0000-000000000010'::uuid))->'partials'
  ),
  0,
  'full-stock happy path: partials is empty array'
);

-- ─────────────────────────────────────────────────────────────
-- T9: mode='recipe' in full-stock return
-- ─────────────────────────────────────────────────────────────

INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
) VALUES (
  'c0000000-0000-0000-0000-000000000011',
  tests.get_supabase_uid('zero_shorts_tester'),
  'b0000000-0000-0000-0000-000000000001',
  '2026-05-05', 1, false
);

SELECT is(
  (SELECT chefbyte.mark_meal_done('c0000000-0000-0000-0000-000000000011'::uuid))->>'mode',
  'recipe',
  'return payload mode=recipe for non-prep meal'
);

-- ─────────────────────────────────────────────────────────────
-- T10: Meal-prep with partial stock still creates [MEAL] lot
-- ─────────────────────────────────────────────────────────────

-- Drain chicken to 0.5 so next prep meal is partially stocked.
-- rice is already at ~3 from refill minus two prior happy-path deducts.
UPDATE chefbyte.stock_lots
SET qty_containers = 0.5
WHERE user_id = tests.get_supabase_uid('zero_shorts_tester')
  AND product_id = 'a0000000-0000-0000-0000-000000000001';

INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
) VALUES (
  'c0000000-0000-0000-0000-000000000020',
  tests.get_supabase_uid('zero_shorts_tester'),
  'b0000000-0000-0000-0000-000000000001',
  '2026-05-06', 1, true
);

-- Execute prep with partial chicken (0.5 of needed 1).
SELECT lives_ok(
  $$ SELECT chefbyte.mark_meal_done('c0000000-0000-0000-0000-000000000020'::uuid) $$,
  'meal_prep with partial stock executes without error'
);

-- ─────────────────────────────────────────────────────────────
-- T11: meal_prep partial — [MEAL] product created
-- ─────────────────────────────────────────────────────────────
SELECT ok(
  EXISTS(
    SELECT 1 FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('zero_shorts_tester')
      AND name LIKE '[MEAL] ZeroBowl%'
  ),
  '[MEAL] product created even for partial-stock meal_prep execution'
);

-- ─────────────────────────────────────────────────────────────
-- T12: meal_prep partial — mode='meal_prep' in return
-- ─────────────────────────────────────────────────────────────

-- Reset chicken, rice stocks for this last meal test.
INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
VALUES
  (tests.get_supabase_uid('zero_shorts_tester'), 'a0000000-0000-0000-0000-000000000001',
   :'fridge_id', 2.0, '2026-07-01');

INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
) VALUES (
  'c0000000-0000-0000-0000-000000000021',
  tests.get_supabase_uid('zero_shorts_tester'),
  'b0000000-0000-0000-0000-000000000001',
  '2026-05-07', 1, true
);

SELECT is(
  (SELECT chefbyte.mark_meal_done('c0000000-0000-0000-0000-000000000021'::uuid))->>'mode',
  'meal_prep',
  'return payload mode=meal_prep for meal_prep execution'
);

-- ─────────────────────────────────────────────────────────────
-- T13: Already-completed still raises (unchanged behaviour)
-- ─────────────────────────────────────────────────────────────
SELECT throws_ok(
  $$ SELECT chefbyte.mark_meal_done('c0000000-0000-0000-0000-000000000021'::uuid) $$,
  'Meal already completed',
  'second call on completed meal still raises (atomicity unchanged)'
);

-- ─────────────────────────────────────────────────────────────
-- T14: Product-based meal with zero stock — completes + returns partial
-- ─────────────────────────────────────────────────────────────

-- A product-based (no recipe) meal entry using ZeroRice (drain it to 0).
DELETE FROM chefbyte.stock_lots
WHERE user_id = tests.get_supabase_uid('zero_shorts_tester')
  AND product_id = 'a0000000-0000-0000-0000-000000000002';

INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, product_id, logical_date, servings, meal_prep
) VALUES (
  'c0000000-0000-0000-0000-000000000030',
  tests.get_supabase_uid('zero_shorts_tester'),
  'a0000000-0000-0000-0000-000000000002',
  '2026-05-08', 1, false
);

SELECT is(
  jsonb_array_length(
    (SELECT chefbyte.mark_meal_done('c0000000-0000-0000-0000-000000000030'::uuid))->'partials'
  ),
  1,
  'product-based meal with zero stock: completes with 1 partial entry'
);

-- ─────────────────────────────────────────────────────────────
-- Teardown
-- ─────────────────────────────────────────────────────────────
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('zero_shorts_tester');

SELECT * FROM finish();
ROLLBACK;
