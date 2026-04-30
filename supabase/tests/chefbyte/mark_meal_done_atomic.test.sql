-- Atomicity + zero-shorts tests for private.mark_meal_done.
--
-- Originally tested the pre-check RAISE on insufficient stock.
-- Updated in 20260430020000_meal_execute_unification.sql: insufficient
-- stock no longer raises — instead the function takes MIN(needed,
-- available) per ingredient and completes the meal regardless.
--
-- Retained invariants:
--   * FOR UPDATE lock on meal_plan_entry
--   * Zero-shorts: partial deduct + partials array in return
--   * Richer JSONB return payload (mode / deducted / partials / food_log_ids)
--   * RAISE on already-completed (unchanged)
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
-- T1: Partial stock — mark_meal_done completes (no RAISE)
-- ─────────────────────────────────────────────────────────────
-- Rice has 0.1 containers; recipe needs 1.0 → zero-shorts: deduct 0.1,
-- complete the meal, return partials array.

SELECT lives_ok(
  $$ SELECT chefbyte.mark_meal_done('90000000-0000-0000-0000-000000000001'::uuid) $$,
  'mark_meal_done completes even when rice is short (zero-shorts)'
);

-- ─────────────────────────────────────────────────────────────
-- T2: Meal is marked completed despite short rice
-- ─────────────────────────────────────────────────────────────

SELECT isnt(
  (SELECT completed_at FROM chefbyte.meal_plan_entries
    WHERE meal_id = '90000000-0000-0000-0000-000000000001'),
  NULL::timestamptz,
  'meal is completed even when an ingredient was short'
);

-- ─────────────────────────────────────────────────────────────
-- T3: Chicken stock deducted (1 container taken from 5)
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT COALESCE(SUM(qty_containers), 0::numeric) FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('atomic_tester')
      AND product_id = '70000000-0000-0000-0000-000000000001'),
  4.000::numeric,
  'chicken stock deducted (1 of 5 containers taken)'
);

-- ─────────────────────────────────────────────────────────────
-- T4: Rice stock drained to 0 (0.1 taken, no negative lots)
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT COALESCE(SUM(qty_containers), 0::numeric) FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('atomic_tester')
      AND product_id = '70000000-0000-0000-0000-000000000002'),
  0.000::numeric,
  'rice stock drained to 0 — no negative lots'
);

-- ─────────────────────────────────────────────────────────────
-- T5: 1 food_log written (chicken only — rice qty was 0.1, logged)
-- ─────────────────────────────────────────────────────────────
-- consume_product is called for each ingredient with actual amount.
-- Chicken: 1 container. Rice: 0.1 container (what was available).

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('atomic_tester')
      AND meal_id = '90000000-0000-0000-0000-000000000001'),
  2,
  '2 food_logs written (chicken full + rice partial 0.1 container)'
);

-- ─────────────────────────────────────────────────────────────
-- Refill rice to run the rest of the happy-path tests.
-- ─────────────────────────────────────────────────────────────

INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
VALUES (
  tests.get_supabase_uid('atomic_tester'), '70000000-0000-0000-0000-000000000002',
  :'fridge_id', 2.0, '2026-05-26'
);

-- ─────────────────────────────────────────────────────────────
-- T6: Happy path — mode='recipe' (fresh meal, full stock)
-- ─────────────────────────────────────────────────────────────
-- Meal 001 is already completed; insert a new meal for T6-T9.

INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
) VALUES (
  '90000000-0000-0000-0000-000000000003',
  tests.get_supabase_uid('atomic_tester'),
  '80000000-0000-0000-0000-000000000001',
  '2026-04-12', 2, false
);

SELECT is(
  (SELECT (chefbyte.mark_meal_done('90000000-0000-0000-0000-000000000003'::uuid))->>'mode'),
  'recipe',
  'happy path return payload has mode=recipe'
);

-- ─────────────────────────────────────────────────────────────
-- T7: Meal completed_at set after happy path
-- ─────────────────────────────────────────────────────────────

SELECT isnt(
  (SELECT completed_at FROM chefbyte.meal_plan_entries
    WHERE meal_id = '90000000-0000-0000-0000-000000000003'),
  NULL::timestamptz,
  'meal.completed_at set after happy path'
);

-- ─────────────────────────────────────────────────────────────
-- T8: 2 food_logs written (one per ingredient), tagged with meal_id
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('atomic_tester')
      AND meal_id = '90000000-0000-0000-0000-000000000003'),
  2,
  'happy path writes 2 food_logs tagged with the meal_id'
);

-- ─────────────────────────────────────────────────────────────
-- T9: Second call raises (already completed)
-- ─────────────────────────────────────────────────────────────

SELECT throws_ok(
  $$ SELECT chefbyte.mark_meal_done('90000000-0000-0000-0000-000000000003'::uuid) $$,
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
