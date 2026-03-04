BEGIN;
SELECT plan(23);

-- Setup: create user
SELECT tests.create_supabase_user('cf_activator');
SELECT tests.authenticate_as('cf_activator');

------------------------------------------------------------
-- Activation
------------------------------------------------------------

-- Test 1: Activate ChefByte succeeds
SELECT lives_ok(
  $$ SELECT hub.activate_app('chefbyte') $$,
  'Activate ChefByte succeeds'
);

-- Test 2: app_activations row exists
SELECT is(
  (SELECT count(*)::integer FROM hub.app_activations
    WHERE user_id = tests.get_supabase_uid('cf_activator') AND app_name = 'chefbyte'),
  1,
  'ChefByte activation row created'
);

-- Test 3: Activation seeds 3 default locations (Fridge, Pantry, Freezer)
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.locations
    WHERE user_id = tests.get_supabase_uid('cf_activator')),
  3,
  'Activation seeds exactly 3 default locations'
);

-- Test 4: Verify location names
SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.locations
    WHERE user_id = tests.get_supabase_uid('cf_activator') AND name = 'Fridge')
  AND EXISTS (SELECT 1 FROM chefbyte.locations
    WHERE user_id = tests.get_supabase_uid('cf_activator') AND name = 'Pantry')
  AND EXISTS (SELECT 1 FROM chefbyte.locations
    WHERE user_id = tests.get_supabase_uid('cf_activator') AND name = 'Freezer'),
  'Default locations are Fridge, Pantry, and Freezer'
);

-- Test 5: Idempotent — second activation does NOT create duplicate locations
SELECT lives_ok(
  $$ SELECT hub.activate_app('chefbyte') $$,
  'Second activation call succeeds (idempotent)'
);
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.locations
    WHERE user_id = tests.get_supabase_uid('cf_activator')),
  3,
  'Location count still 3 after second activation (no duplicates)'
);

-- Test 7: After activation, user can create products
SELECT lives_ok(
  $$ INSERT INTO chefbyte.products (user_id, name, calories_per_serving)
     VALUES (tests.get_supabase_uid('cf_activator'), 'Test Rice', 200) $$,
  'User can create products after activation'
);

------------------------------------------------------------
-- Seed data for deactivation cascade verification
------------------------------------------------------------

-- Add stock lot referencing the product + location
INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
VALUES (
  tests.get_supabase_uid('cf_activator'),
  (SELECT product_id FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('cf_activator') AND name = 'Test Rice'),
  (SELECT location_id FROM chefbyte.locations
    WHERE user_id = tests.get_supabase_uid('cf_activator') AND name = 'Fridge'),
  3,
  '2026-04-01'
);

-- Add a recipe + ingredient
INSERT INTO chefbyte.recipes (user_id, name)
VALUES (tests.get_supabase_uid('cf_activator'), 'Test Recipe');

INSERT INTO chefbyte.recipe_ingredients (user_id, recipe_id, product_id, quantity, unit)
VALUES (
  tests.get_supabase_uid('cf_activator'),
  (SELECT recipe_id FROM chefbyte.recipes
    WHERE user_id = tests.get_supabase_uid('cf_activator') AND name = 'Test Recipe'),
  (SELECT product_id FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('cf_activator') AND name = 'Test Rice'),
  2,
  'serving'
);

-- Add a food_log
INSERT INTO chefbyte.food_logs (user_id, product_id, logical_date, qty_consumed, unit, calories, carbs, protein, fat)
VALUES (
  tests.get_supabase_uid('cf_activator'),
  (SELECT product_id FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('cf_activator') AND name = 'Test Rice'),
  '2026-03-01', 1, 'serving', 200, 40, 5, 1
);

-- Add a temp_item
INSERT INTO chefbyte.temp_items (user_id, name, logical_date, calories, carbs, protein, fat)
VALUES (tests.get_supabase_uid('cf_activator'), 'Quick Snack', '2026-03-01', 150, 20, 5, 3);

-- Add a shopping_list item
INSERT INTO chefbyte.shopping_list (user_id, product_id, qty_containers)
VALUES (
  tests.get_supabase_uid('cf_activator'),
  (SELECT product_id FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('cf_activator') AND name = 'Test Rice'),
  2
);

-- Add a meal_plan_entry
INSERT INTO chefbyte.meal_plan_entries (user_id, product_id, logical_date, servings)
VALUES (
  tests.get_supabase_uid('cf_activator'),
  (SELECT product_id FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('cf_activator') AND name = 'Test Rice'),
  '2026-03-01', 1
);

-- Add a user_config entry
INSERT INTO chefbyte.user_config (user_id, key, value)
VALUES (tests.get_supabase_uid('cf_activator'), 'goal_calories', '2000');

-- Add a liquidtrack_device + event
INSERT INTO chefbyte.liquidtrack_devices (user_id, device_name, import_key_hash)
VALUES (tests.get_supabase_uid('cf_activator'), 'Water Bottle', 'hash_test_123');

INSERT INTO chefbyte.liquidtrack_events (user_id, device_id, weight_before, weight_after, consumption, logical_date)
VALUES (
  tests.get_supabase_uid('cf_activator'),
  (SELECT device_id FROM chefbyte.liquidtrack_devices
    WHERE user_id = tests.get_supabase_uid('cf_activator') AND device_name = 'Water Bottle'),
  500, 400, 100, '2026-03-01'
);

------------------------------------------------------------
-- Deactivation
------------------------------------------------------------

-- Test 8: Deactivate ChefByte succeeds
SELECT lives_ok(
  $$ SELECT hub.deactivate_app('chefbyte') $$,
  'Deactivate ChefByte succeeds'
);

-- Test 9: Activation row removed
SELECT is(
  (SELECT count(*)::integer FROM hub.app_activations
    WHERE user_id = tests.get_supabase_uid('cf_activator') AND app_name = 'chefbyte'),
  0,
  'Activation row removed after deactivation'
);

-- Test 10: Verify each chefbyte table is empty after deactivation (separate assertions)
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('cf_activator')),
  0, 'products deleted after deactivation'
);
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('cf_activator')),
  0, 'stock_lots deleted after deactivation'
);
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.locations
    WHERE user_id = tests.get_supabase_uid('cf_activator')),
  0, 'locations deleted after deactivation'
);
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.recipes
    WHERE user_id = tests.get_supabase_uid('cf_activator')),
  0, 'recipes deleted after deactivation'
);
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.recipe_ingredients
    WHERE user_id = tests.get_supabase_uid('cf_activator')),
  0, 'recipe_ingredients deleted after deactivation'
);

-- Test 11: Verify remaining 7 tables also empty after deactivation
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_activator')),
  0, 'food_logs deleted after deactivation'
);
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.temp_items
    WHERE user_id = tests.get_supabase_uid('cf_activator')),
  0, 'temp_items deleted after deactivation'
);
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.shopping_list
    WHERE user_id = tests.get_supabase_uid('cf_activator')),
  0, 'shopping_list deleted after deactivation'
);
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.meal_plan_entries
    WHERE user_id = tests.get_supabase_uid('cf_activator')),
  0, 'meal_plan_entries deleted after deactivation'
);
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.user_config
    WHERE user_id = tests.get_supabase_uid('cf_activator')),
  0, 'user_config deleted after deactivation'
);
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.liquidtrack_devices
    WHERE user_id = tests.get_supabase_uid('cf_activator')),
  0, 'liquidtrack_devices deleted after deactivation'
);
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.liquidtrack_events
    WHERE user_id = tests.get_supabase_uid('cf_activator')),
  0, 'liquidtrack_events deleted after deactivation'
);

------------------------------------------------------------
-- Reactivation
------------------------------------------------------------

-- Test 11: Reactivate after deactivation works cleanly
SELECT lives_ok(
  $$ SELECT hub.activate_app('chefbyte') $$,
  'Reactivate ChefByte after deactivation succeeds'
);

-- Test 12: 3 fresh locations seeded after reactivation
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.locations
    WHERE user_id = tests.get_supabase_uid('cf_activator')),
  3,
  'Reactivation seeds 3 fresh locations'
);

------------------------------------------------------------
-- Cleanup
------------------------------------------------------------
SELECT tests.delete_supabase_user('cf_activator');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
