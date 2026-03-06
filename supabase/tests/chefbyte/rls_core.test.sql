-- RLS isolation tests for ChefByte core tables:
-- locations, recipes, recipe_ingredients, meal_plan_entries, food_logs, temp_items
BEGIN;
SELECT plan(21);

-- Setup: two users
SELECT tests.create_supabase_user('cf_rls_a');
SELECT tests.create_supabase_user('cf_rls_b');

SELECT tests.authenticate_as('cf_rls_a');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('cf_rls_b');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();

-- ═══════════════════════════════════════════════════════════════
-- LOCATIONS
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('cf_rls_a');

-- Activation seeds Fridge/Pantry, so User A already has locations
SELECT ok(
  (SELECT count(*) FROM chefbyte.locations
    WHERE user_id = tests.get_supabase_uid('cf_rls_a')) >= 1,
  'User A can SELECT own locations'
);

SELECT tests.authenticate_as('cf_rls_b');

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.locations
    WHERE user_id = tests.get_supabase_uid('cf_rls_a')),
  0,
  'User B cannot SELECT User A locations'
);

-- Get a location_id from User A for update/delete attempts
SELECT tests.authenticate_as('cf_rls_a');
SELECT location_id AS a_loc_id FROM chefbyte.locations
  WHERE user_id = tests.get_supabase_uid('cf_rls_a') LIMIT 1 \gset

SELECT tests.authenticate_as('cf_rls_b');
UPDATE chefbyte.locations SET name = 'Hacked'
  WHERE location_id = :'a_loc_id';
SELECT tests.authenticate_as('cf_rls_a');
SELECT isnt(
  (SELECT name FROM chefbyte.locations WHERE location_id = :'a_loc_id'),
  'Hacked',
  'User B cannot UPDATE User A locations'
);

SELECT tests.authenticate_as('cf_rls_b');
DELETE FROM chefbyte.locations WHERE location_id = :'a_loc_id';
SELECT tests.authenticate_as('cf_rls_a');
SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.locations WHERE location_id = :'a_loc_id'),
  'User B cannot DELETE User A locations'
);

-- ═══════════════════════════════════════════════════════════════
-- RECIPES + RECIPE_INGREDIENTS
-- ═══════════════════════════════════════════════════════════════

-- Need a product for recipe ingredients
INSERT INTO chefbyte.products (product_id, user_id, name, servings_per_container,
  calories_per_serving, protein_per_serving, fat_per_serving, carbs_per_serving)
VALUES (
  'b0000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('cf_rls_a'),
  'RLS Test Product', 1, 100, 10, 5, 20
);

INSERT INTO chefbyte.recipes (recipe_id, user_id, name, base_servings)
VALUES (
  'b0000000-0000-0000-0000-000000000010',
  tests.get_supabase_uid('cf_rls_a'),
  'RLS Test Recipe', 2
);

INSERT INTO chefbyte.recipe_ingredients (user_id, recipe_id, product_id, quantity, unit)
VALUES (
  tests.get_supabase_uid('cf_rls_a'),
  'b0000000-0000-0000-0000-000000000010',
  'b0000000-0000-0000-0000-000000000001',
  1, 'container'
);

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.recipes
    WHERE recipe_id = 'b0000000-0000-0000-0000-000000000010'),
  'User A can SELECT own recipes'
);

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.recipe_ingredients
    WHERE recipe_id = 'b0000000-0000-0000-0000-000000000010'),
  'User A can SELECT own recipe_ingredients'
);

SELECT tests.authenticate_as('cf_rls_b');

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.recipes
    WHERE user_id = tests.get_supabase_uid('cf_rls_a')),
  0,
  'User B cannot SELECT User A recipes'
);

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.recipe_ingredients
    WHERE user_id = tests.get_supabase_uid('cf_rls_a')),
  0,
  'User B cannot SELECT User A recipe_ingredients'
);

UPDATE chefbyte.recipes SET name = 'Hacked'
  WHERE recipe_id = 'b0000000-0000-0000-0000-000000000010';
SELECT tests.authenticate_as('cf_rls_a');
SELECT is(
  (SELECT name FROM chefbyte.recipes
    WHERE recipe_id = 'b0000000-0000-0000-0000-000000000010'),
  'RLS Test Recipe',
  'User B cannot UPDATE User A recipes'
);

-- ═══════════════════════════════════════════════════════════════
-- MEAL_PLAN_ENTRIES
-- ═══════════════════════════════════════════════════════════════

INSERT INTO chefbyte.meal_plan_entries (meal_id, user_id, product_id, logical_date, servings, meal_prep)
VALUES (
  'b0000000-0000-0000-0000-000000000020',
  tests.get_supabase_uid('cf_rls_a'),
  'b0000000-0000-0000-0000-000000000001',
  '2026-03-03', 1, false
);

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.meal_plan_entries
    WHERE meal_id = 'b0000000-0000-0000-0000-000000000020'),
  'User A can SELECT own meal_plan_entries'
);

SELECT tests.authenticate_as('cf_rls_b');

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.meal_plan_entries
    WHERE user_id = tests.get_supabase_uid('cf_rls_a')),
  0,
  'User B cannot SELECT User A meal_plan_entries'
);

UPDATE chefbyte.meal_plan_entries SET servings = 99
  WHERE meal_id = 'b0000000-0000-0000-0000-000000000020';
SELECT tests.authenticate_as('cf_rls_a');
SELECT is(
  (SELECT servings FROM chefbyte.meal_plan_entries
    WHERE meal_id = 'b0000000-0000-0000-0000-000000000020'),
  1.000::numeric,
  'User B cannot UPDATE User A meal_plan_entries'
);

SELECT tests.authenticate_as('cf_rls_b');
DELETE FROM chefbyte.meal_plan_entries
  WHERE meal_id = 'b0000000-0000-0000-0000-000000000020';
SELECT tests.authenticate_as('cf_rls_a');
SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.meal_plan_entries
    WHERE meal_id = 'b0000000-0000-0000-0000-000000000020'),
  'User B cannot DELETE User A meal_plan_entries'
);

-- ═══════════════════════════════════════════════════════════════
-- FOOD_LOGS
-- ═══════════════════════════════════════════════════════════════

INSERT INTO chefbyte.food_logs (user_id, product_id, logical_date,
  qty_consumed, unit, calories, carbs, protein, fat)
VALUES (
  tests.get_supabase_uid('cf_rls_a'),
  'b0000000-0000-0000-0000-000000000001',
  '2026-03-03', 1, 'container', 100, 20, 10, 5
);

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_rls_a')),
  'User A can SELECT own food_logs'
);

SELECT tests.authenticate_as('cf_rls_b');

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_rls_a')),
  0,
  'User B cannot SELECT User A food_logs'
);

UPDATE chefbyte.food_logs SET calories = 999
  WHERE user_id = tests.get_supabase_uid('cf_rls_a');
SELECT tests.authenticate_as('cf_rls_a');
SELECT is(
  (SELECT calories FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_rls_a') LIMIT 1),
  100.000::numeric,
  'User B cannot UPDATE User A food_logs'
);

SELECT tests.authenticate_as('cf_rls_b');
DELETE FROM chefbyte.food_logs WHERE user_id = tests.get_supabase_uid('cf_rls_a');
SELECT tests.authenticate_as('cf_rls_a');
SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_rls_a')),
  'User B cannot DELETE User A food_logs'
);

-- ═══════════════════════════════════════════════════════════════
-- TEMP_ITEMS
-- ═══════════════════════════════════════════════════════════════

INSERT INTO chefbyte.temp_items (user_id, name, logical_date,
  calories, carbs, protein, fat)
VALUES (
  tests.get_supabase_uid('cf_rls_a'),
  'Test Snack', '2026-03-03', 50, 5, 2, 1
);

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.temp_items
    WHERE user_id = tests.get_supabase_uid('cf_rls_a')),
  'User A can SELECT own temp_items'
);

SELECT tests.authenticate_as('cf_rls_b');

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.temp_items
    WHERE user_id = tests.get_supabase_uid('cf_rls_a')),
  0,
  'User B cannot SELECT User A temp_items'
);

UPDATE chefbyte.temp_items SET calories = 999
  WHERE user_id = tests.get_supabase_uid('cf_rls_a');
SELECT tests.authenticate_as('cf_rls_a');
SELECT is(
  (SELECT calories FROM chefbyte.temp_items
    WHERE user_id = tests.get_supabase_uid('cf_rls_a') LIMIT 1),
  50.000::numeric,
  'User B cannot UPDATE User A temp_items'
);

SELECT tests.authenticate_as('cf_rls_b');
DELETE FROM chefbyte.temp_items WHERE user_id = tests.get_supabase_uid('cf_rls_a');
SELECT tests.authenticate_as('cf_rls_a');
SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.temp_items
    WHERE user_id = tests.get_supabase_uid('cf_rls_a')),
  'User B cannot DELETE User A temp_items'
);

-- Teardown
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('cf_rls_a');
SELECT tests.delete_supabase_user('cf_rls_b');

SELECT * FROM finish();
ROLLBACK;
