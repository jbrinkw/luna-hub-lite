-- recipe_gram_unit.test.sql
--
-- pgTAP tests for gram-unit recipe ingredients.
-- Covers:
--   1. INSERT with unit='gram' succeeds when product has net_weight_g
--   2. mark_meal_done with gram ingredient correctly decrements stock
--   3. unmark_meal_done restores stock by the same amount
--   4. mark_meal_done with gram ingredient + null net_weight_g RAISES exception
--   5. Bogus unit values still rejected by CHECK constraint
--   6. Distinct UUIDs via gen_random_uuid + RETURNING (no hardcoded UUIDs)

BEGIN;
SELECT plan(12);

-- ─────────────────────────────────────────────────────────────
-- Setup
-- ─────────────────────────────────────────────────────────────
SELECT tests.create_supabase_user('gram_tester');
SELECT tests.authenticate_as('gram_tester');
SELECT hub.activate_app('chefbyte');

SELECT location_id AS fridge_id
  FROM chefbyte.locations
  WHERE user_id = tests.get_supabase_uid('gram_tester') AND name = 'Fridge' \gset

-- Product WITH net_weight_g (e.g. 500g container of chicken breast)
INSERT INTO chefbyte.products (
  product_id, user_id, name,
  servings_per_container, calories_per_serving,
  protein_per_serving, fat_per_serving, carbs_per_serving,
  net_weight_g
)
SELECT
  gen_random_uuid(),
  tests.get_supabase_uid('gram_tester'),
  'GramChicken', 4, 165, 31, 3.6, 0, 500.0
RETURNING product_id \gset chicken_id_

-- Product WITHOUT net_weight_g (null)
INSERT INTO chefbyte.products (
  product_id, user_id, name,
  servings_per_container, calories_per_serving,
  protein_per_serving, fat_per_serving, carbs_per_serving
)
SELECT
  gen_random_uuid(),
  tests.get_supabase_uid('gram_tester'),
  'NoWeightProduct', 3, 100, 10, 5, 20
RETURNING product_id \gset noweight_id_

-- Recipe using gram ingredient
INSERT INTO chefbyte.recipes (recipe_id, user_id, name, base_servings)
SELECT gen_random_uuid(), tests.get_supabase_uid('gram_tester'), 'GramBowl', 1
RETURNING recipe_id \gset gram_recipe_id_

-- ─────────────────────────────────────────────────────────────
-- T1: unit='gram' INSERT succeeds when product has net_weight_g
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  format(
    $$ INSERT INTO chefbyte.recipe_ingredients
       (user_id, recipe_id, product_id, quantity, unit)
       VALUES (%L::uuid, %L::uuid, %L::uuid, 200, 'gram') $$,
    tests.get_supabase_uid('gram_tester')::text,
    :'gram_recipe_id_recipe_id',
    :'chicken_id_product_id'
  ),
  'INSERT with unit=gram succeeds when product has net_weight_g'
);

-- ─────────────────────────────────────────────────────────────
-- T2: bogus unit value rejected by CHECK constraint
-- ─────────────────────────────────────────────────────────────

SELECT throws_ok(
  format(
    $$ INSERT INTO chefbyte.recipe_ingredients
       (user_id, recipe_id, product_id, quantity, unit)
       VALUES (%L::uuid, %L::uuid, %L::uuid, 1, 'kilogram') $$,
    tests.get_supabase_uid('gram_tester')::text,
    :'gram_recipe_id_recipe_id',
    :'chicken_id_product_id'
  ),
  '23514',
  NULL,
  'bogus unit value rejected by CHECK constraint'
);

-- ─────────────────────────────────────────────────────────────
-- T3: container unit still valid
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  format(
    $$ INSERT INTO chefbyte.recipe_ingredients
       (user_id, recipe_id, product_id, quantity, unit)
       VALUES (%L::uuid, %L::uuid, %L::uuid, 1, 'container') $$,
    tests.get_supabase_uid('gram_tester')::text,
    :'gram_recipe_id_recipe_id',
    :'chicken_id_product_id'
  ),
  'container unit still accepted (backward compat)'
);

-- Remove extra ingredients so recipe has exactly 1 (200g chicken)
DELETE FROM chefbyte.recipe_ingredients
WHERE recipe_id = :'gram_recipe_id_recipe_id'::uuid
  AND unit = 'container';

-- ─────────────────────────────────────────────────────────────
-- Stock: 2 containers of chicken (= 2 × 500g = 1000g)
-- Recipe: 200g → 200/500 = 0.4 containers needed
-- ─────────────────────────────────────────────────────────────

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on
) VALUES (
  tests.get_supabase_uid('gram_tester'),
  :'chicken_id_product_id'::uuid,
  :'fridge_id',
  2.0, '2027-01-01'
);

INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
)
SELECT gen_random_uuid(),
  tests.get_supabase_uid('gram_tester'),
  :'gram_recipe_id_recipe_id'::uuid,
  '2026-05-01', 1, false
RETURNING meal_id \gset gram_meal_id_

-- ─────────────────────────────────────────────────────────────
-- T4: mark_meal_done with gram ingredient decrements stock by 0.4 containers
--     (200g / 500g_per_container = 0.4 containers)
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  format(
    $$ SELECT chefbyte.mark_meal_done(%L::uuid) $$,
    :'gram_meal_id_meal_id'
  ),
  'mark_meal_done with gram ingredient succeeds'
);

SELECT is(
  (SELECT SUM(qty_containers)::numeric(10,3)
     FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('gram_tester')
      AND product_id = :'chicken_id_product_id'::uuid),
  1.600::numeric(10,3),
  'stock decremented by 0.4 containers (200g / 500g net_weight_g) after mark_meal_done'
);

-- ─────────────────────────────────────────────────────────────
-- T5: food_log tagged with meal_id and unit='container'
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT unit FROM chefbyte.food_logs
    WHERE meal_id = :'gram_meal_id_meal_id'::uuid
      AND user_id = tests.get_supabase_uid('gram_tester')
    LIMIT 1),
  'container',
  'food_log unit is container (gram was pre-converted before consume_product)'
);

-- ─────────────────────────────────────────────────────────────
-- T6: unmark_meal_done restores stock by 0.4 containers
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  format(
    $$ SELECT chefbyte.unmark_meal_done(%L::uuid) $$,
    :'gram_meal_id_meal_id'
  ),
  'unmark_meal_done with gram-origin ingredient succeeds'
);

SELECT is(
  (SELECT SUM(qty_containers)::numeric(10,3)
     FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('gram_tester')
      AND product_id = :'chicken_id_product_id'::uuid),
  2.000::numeric(10,3),
  'stock restored to 2.0 containers after unmark_meal_done'
);

-- ─────────────────────────────────────────────────────────────
-- T7: mark_meal_done with gram ingredient + null net_weight_g RAISES
-- ─────────────────────────────────────────────────────────────

-- Recipe using the no-weight product at gram unit
INSERT INTO chefbyte.recipes (recipe_id, user_id, name, base_servings)
SELECT gen_random_uuid(), tests.get_supabase_uid('gram_tester'), 'NoWeightBowl', 1
RETURNING recipe_id \gset noweight_recipe_id_

INSERT INTO chefbyte.recipe_ingredients
  (user_id, recipe_id, product_id, quantity, unit)
VALUES (
  tests.get_supabase_uid('gram_tester'),
  :'noweight_recipe_id_recipe_id'::uuid,
  :'noweight_id_product_id'::uuid,
  100, 'gram'
);

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on
) VALUES (
  tests.get_supabase_uid('gram_tester'),
  :'noweight_id_product_id'::uuid,
  :'fridge_id',
  5.0, '2027-01-01'
);

INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
)
SELECT gen_random_uuid(),
  tests.get_supabase_uid('gram_tester'),
  :'noweight_recipe_id_recipe_id'::uuid,
  '2026-05-02', 1, false
RETURNING meal_id \gset noweight_meal_id_

SELECT throws_like(
  format(
    $$ SELECT chefbyte.mark_meal_done(%L::uuid) $$,
    :'noweight_meal_id_meal_id'
  ),
  '%missing net_weight_g%',
  'mark_meal_done raises when gram ingredient has null net_weight_g'
);

-- ─────────────────────────────────────────────────────────────
-- T8: stock untouched after the null-net_weight_g raise
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT SUM(qty_containers)::numeric(10,3)
     FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('gram_tester')
      AND product_id = :'noweight_id_product_id'::uuid),
  5.000::numeric(10,3),
  'stock untouched after null-net_weight_g raise (full rollback)'
);

-- ─────────────────────────────────────────────────────────────
-- T9: serving unit still works correctly (backward compat)
-- ─────────────────────────────────────────────────────────────

INSERT INTO chefbyte.recipes (recipe_id, user_id, name, base_servings)
SELECT gen_random_uuid(), tests.get_supabase_uid('gram_tester'), 'ServingBowl', 2
RETURNING recipe_id \gset serving_recipe_id_

INSERT INTO chefbyte.recipe_ingredients
  (user_id, recipe_id, product_id, quantity, unit)
VALUES (
  tests.get_supabase_uid('gram_tester'),
  :'serving_recipe_id_recipe_id'::uuid,
  :'chicken_id_product_id'::uuid,
  4, 'serving'   -- 4 servings @ 4spc = 1 container
);

-- Stock already 2.0 from previous tests; recipe needs 1 container → fine
INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
)
SELECT gen_random_uuid(),
  tests.get_supabase_uid('gram_tester'),
  :'serving_recipe_id_recipe_id'::uuid,
  '2026-05-03', 2, false  -- scale_factor = 2/2 = 1.0
RETURNING meal_id \gset serving_meal_id_

SELECT lives_ok(
  format(
    $$ SELECT chefbyte.mark_meal_done(%L::uuid) $$,
    :'serving_meal_id_meal_id'
  ),
  'mark_meal_done with serving ingredient still works (backward compat)'
);

-- 4 servings / 4 spc = 1 container consumed → stock goes from 2.0 to 1.0
SELECT is(
  (SELECT SUM(qty_containers)::numeric(10,3)
     FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('gram_tester')
      AND product_id = :'chicken_id_product_id'::uuid),
  1.000::numeric(10,3),
  'serving unit backward compat: 1 container consumed from stock'
);

-- ─────────────────────────────────────────────────────────────
-- Teardown
-- ─────────────────────────────────────────────────────────────
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('gram_tester');

SELECT * FROM finish();
ROLLBACK;
