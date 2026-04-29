-- pgTAP — recipe_ingredients.visual_unit_label + visual_quantity
--
-- Covers:
--   1. INSERT with both visual fields set succeeds
--   2. INSERT with both visual fields NULL succeeds
--   3. INSERT with only label set raises check_violation (23514)
--   4. INSERT with only qty set raises check_violation (23514)
--   5. INSERT with visual_quantity = 0 raises check_violation (23514)
--   6. mark_meal_done with absurd visual_quantity (99) uses canonical
--      quantity+unit for stock decrement — NOT the visual value.
--   7. Stock after mark_meal_done is 4 (5 - 1 canonical), not affected by visual 99.

BEGIN;
SELECT plan(7);

-- ─────────────────────────────────────────────────────────────
-- Setup
-- ─────────────────────────────────────────────────────────────

SELECT tests.create_supabase_user('rvu_tester');
SELECT tests.authenticate_as('rvu_tester');
SELECT hub.activate_app('chefbyte');

CREATE TEMP TABLE _rvu_state (
  key  TEXT PRIMARY KEY,
  val  TEXT NOT NULL
);

-- Product: Bacon, 4 servings/container, 100cal/5p/8f/1c, net_weight_g=200
WITH ins AS (
  INSERT INTO chefbyte.products (
    user_id, name,
    servings_per_container, calories_per_serving,
    protein_per_serving, fat_per_serving, carbs_per_serving,
    net_weight_g
  ) VALUES (
    tests.get_supabase_uid('rvu_tester'),
    'Test Bacon',
    4, 100, 5, 8, 1,
    200
  ) RETURNING product_id
)
INSERT INTO _rvu_state SELECT 'pid', product_id::text FROM ins;

-- Stock lot: 5 containers
WITH fridge AS (
  SELECT location_id FROM chefbyte.locations
   WHERE user_id = tests.get_supabase_uid('rvu_tester') AND name = 'Fridge'
),
ins AS (
  INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
  SELECT
    tests.get_supabase_uid('rvu_tester'),
    (SELECT val::uuid FROM _rvu_state WHERE key = 'pid'),
    fridge.location_id,
    5,
    '2099-12-31'
  FROM fridge
  RETURNING lot_id
)
INSERT INTO _rvu_state SELECT 'lot_id', lot_id::text FROM ins;

-- Recipe
WITH ins AS (
  INSERT INTO chefbyte.recipes (user_id, name, base_servings)
  VALUES (tests.get_supabase_uid('rvu_tester'), 'Visual Unit Test Recipe', 1)
  RETURNING recipe_id
)
INSERT INTO _rvu_state SELECT 'recipe_id', recipe_id::text FROM ins;

-- ─────────────────────────────────────────────────────────────
-- Test 1: Both visual fields set → succeeds
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  format($$
    INSERT INTO chefbyte.recipe_ingredients
      (user_id, recipe_id, product_id, quantity, unit, visual_quantity, visual_unit_label)
    VALUES (
      %L::uuid,
      %L::uuid,
      %L::uuid,
      30, 'gram', 1, 'slice'
    )
  $$,
    tests.get_supabase_uid('rvu_tester')::text,
    (SELECT val FROM _rvu_state WHERE key = 'recipe_id'),
    (SELECT val FROM _rvu_state WHERE key = 'pid')
  ),
  'INSERT with both visual fields set succeeds'
);

-- ─────────────────────────────────────────────────────────────
-- Test 2: Both visual fields NULL → succeeds
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  format($$
    INSERT INTO chefbyte.recipe_ingredients
      (user_id, recipe_id, product_id, quantity, unit, visual_quantity, visual_unit_label)
    VALUES (
      %L::uuid,
      %L::uuid,
      %L::uuid,
      1, 'container', NULL, NULL
    )
  $$,
    tests.get_supabase_uid('rvu_tester')::text,
    (SELECT val FROM _rvu_state WHERE key = 'recipe_id'),
    (SELECT val FROM _rvu_state WHERE key = 'pid')
  ),
  'INSERT with both visual fields NULL succeeds'
);

-- ─────────────────────────────────────────────────────────────
-- Test 3: Only label set → check_violation (23514)
-- ─────────────────────────────────────────────────────────────

SELECT throws_matching(
  format($$
    INSERT INTO chefbyte.recipe_ingredients
      (user_id, recipe_id, product_id, quantity, unit, visual_quantity, visual_unit_label)
    VALUES (
      %L::uuid,
      %L::uuid,
      %L::uuid,
      1, 'container', NULL, 'slice'
    )
  $$,
    tests.get_supabase_uid('rvu_tester')::text,
    (SELECT val FROM _rvu_state WHERE key = 'recipe_id'),
    (SELECT val FROM _rvu_state WHERE key = 'pid')
  ),
  'check',
  'INSERT with only visual_unit_label raises check_violation'
);

-- ─────────────────────────────────────────────────────────────
-- Test 4: Only qty set → check_violation (23514)
-- ─────────────────────────────────────────────────────────────

SELECT throws_matching(
  format($$
    INSERT INTO chefbyte.recipe_ingredients
      (user_id, recipe_id, product_id, quantity, unit, visual_quantity, visual_unit_label)
    VALUES (
      %L::uuid,
      %L::uuid,
      %L::uuid,
      1, 'container', 2.5, NULL
    )
  $$,
    tests.get_supabase_uid('rvu_tester')::text,
    (SELECT val FROM _rvu_state WHERE key = 'recipe_id'),
    (SELECT val FROM _rvu_state WHERE key = 'pid')
  ),
  'check',
  'INSERT with only visual_quantity raises check_violation'
);

-- ─────────────────────────────────────────────────────────────
-- Test 5: visual_quantity = 0 → check_violation (23514)
-- ─────────────────────────────────────────────────────────────

SELECT throws_matching(
  format($$
    INSERT INTO chefbyte.recipe_ingredients
      (user_id, recipe_id, product_id, quantity, unit, visual_quantity, visual_unit_label)
    VALUES (
      %L::uuid,
      %L::uuid,
      %L::uuid,
      1, 'container', 0, 'slice'
    )
  $$,
    tests.get_supabase_uid('rvu_tester')::text,
    (SELECT val FROM _rvu_state WHERE key = 'recipe_id'),
    (SELECT val FROM _rvu_state WHERE key = 'pid')
  ),
  'check',
  'INSERT with visual_quantity = 0 raises check_violation'
);

-- ─────────────────────────────────────────────────────────────
-- Tests 6 + 7: mark_meal_done with absurd visual_quantity=99 uses
--   canonical quantity+unit for stock decrement, NOT visual.
--
--   Setup: recipe has 1 ingredient — 1 container canonical, 99 'kg' visual.
--   Stock: 5 containers before. After mark_meal_done: should be 4 (5-1),
--   not -94 (5-99). Proves visual fields are ignored by business logic.
-- ─────────────────────────────────────────────────────────────

-- Clear constraint-test inserts; insert the canonical-1-container ingredient
-- with absurd visual_quantity=99 that must NOT affect stock math.
DELETE FROM chefbyte.recipe_ingredients
 WHERE recipe_id = (SELECT val::uuid FROM _rvu_state WHERE key = 'recipe_id')
   AND user_id   = tests.get_supabase_uid('rvu_tester');

INSERT INTO chefbyte.recipe_ingredients
  (user_id, recipe_id, product_id, quantity, unit, visual_quantity, visual_unit_label)
VALUES (
  tests.get_supabase_uid('rvu_tester'),
  (SELECT val::uuid FROM _rvu_state WHERE key = 'recipe_id'),
  (SELECT val::uuid FROM _rvu_state WHERE key = 'pid'),
  1,          -- canonical: 1 container
  'container',
  99,         -- absurd visual quantity — must NOT affect stock math
  'kg'
);

-- Insert a meal plan entry
WITH ins AS (
  INSERT INTO chefbyte.meal_plan_entries (
    user_id, recipe_id, meal_type, servings, logical_date
  ) VALUES (
    tests.get_supabase_uid('rvu_tester'),
    (SELECT val::uuid FROM _rvu_state WHERE key = 'recipe_id'),
    'lunch',
    1,
    CURRENT_DATE
  ) RETURNING meal_id
)
INSERT INTO _rvu_state SELECT 'meal_id', meal_id::text FROM ins;

-- Test 6: mark_meal_done runs without error
SELECT lives_ok(
  format($$
    SELECT chefbyte.mark_meal_done(%L::uuid)
  $$,
    (SELECT val FROM _rvu_state WHERE key = 'meal_id')
  ),
  'mark_meal_done with absurd visual_quantity=99 runs without error'
);

-- Test 7: stock decremented by canonical 1 container (not by visual 99)
SELECT is(
  (SELECT COALESCE(SUM(qty_containers), 0)
     FROM chefbyte.stock_lots
    WHERE product_id = (SELECT val::uuid FROM _rvu_state WHERE key = 'pid')
      AND user_id    = tests.get_supabase_uid('rvu_tester'))::numeric,
  4::numeric,
  'stock is 4 after consuming 1 canonical container (visual_quantity=99 ignored)'
);

SELECT finish();
ROLLBACK;
