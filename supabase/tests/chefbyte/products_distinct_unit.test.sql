-- pgTAP tests for is_distinct_unit_item + default_recipe_unit columns
-- and the mark_meal_done [MEAL] product population.
--
-- Run: supabase test db supabase/tests/chefbyte/products_distinct_unit.test.sql

BEGIN;
SELECT plan(11);

-- ─────────────────────────────────────────────────────────────────────────
-- 1. New columns exist with correct defaults
-- ─────────────────────────────────────────────────────────────────────────

SELECT has_column('chefbyte', 'products', 'is_distinct_unit_item',
  'chefbyte.products has is_distinct_unit_item column');

SELECT has_column('chefbyte', 'products', 'default_recipe_unit',
  'chefbyte.products has default_recipe_unit column');

SELECT col_default_is('chefbyte', 'products', 'is_distinct_unit_item', 'false',
  'is_distinct_unit_item defaults to false');

SELECT col_is_null('chefbyte', 'products', 'default_recipe_unit',
  'default_recipe_unit defaults to NULL');

-- ─────────────────────────────────────────────────────────────────────────
-- 2. CHECK constraint rejects invalid values
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_uid UUID := tests.create_supabase_user('distinct-check-user-' || gen_random_uuid()::text);
BEGIN NULL; END$$;

SELECT throws_ok(
  $$INSERT INTO chefbyte.products (user_id, name, default_recipe_unit)
    SELECT id, 'Bad Unit Product', 'oz'
    FROM auth.users
    WHERE raw_user_meta_data->>'test_identifier' LIKE 'distinct-check-user-%'
    LIMIT 1$$,
  23514,
  NULL,
  'default_recipe_unit CHECK rejects "oz" (bogus value)'
);

-- Valid values must be accepted (no exception)
DO $$
DECLARE
  v_uid UUID := tests.create_supabase_user('distinct-valid-user-' || gen_random_uuid()::text);
BEGIN
  INSERT INTO chefbyte.products (user_id, name, default_recipe_unit)
  VALUES (v_uid, 'Test Gram', 'gram');
  INSERT INTO chefbyte.products (user_id, name, default_recipe_unit)
  VALUES (v_uid, 'Test Serving', 'serving');
  INSERT INTO chefbyte.products (user_id, name, default_recipe_unit)
  VALUES (v_uid, 'Test Container', 'container');
  INSERT INTO chefbyte.products (user_id, name, default_recipe_unit)
  VALUES (v_uid, 'Test Null', NULL);
END$$;

SELECT pass('valid default_recipe_unit values accepted without error');

-- ─────────────────────────────────────────────────────────────────────────
-- 3. mark_meal_done [MEAL] product gets is_distinct_unit_item=true, default_recipe_unit='serving'
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_user_id    UUID := tests.create_supabase_user('distinct-meal-user-' || gen_random_uuid()::text);
  v_product_id UUID;
  v_recipe_id  UUID;
  v_location_id UUID;
  v_meal_id    UUID;
BEGIN
  v_product_id  := gen_random_uuid();
  v_recipe_id   := gen_random_uuid();
  v_meal_id     := gen_random_uuid();

  -- Insert a location
  INSERT INTO chefbyte.locations (user_id, name)
  VALUES (v_user_id, 'Fridge')
  RETURNING location_id INTO v_location_id;

  -- Insert a product with macros
  INSERT INTO chefbyte.products (product_id, user_id, name, calories_per_serving, protein_per_serving,
    carbs_per_serving, fat_per_serving, servings_per_container)
  VALUES (v_product_id, v_user_id, 'Chicken Breast', 165, 31, 0, 3.6, 4);

  -- Give it stock
  INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers)
  VALUES (v_user_id, v_product_id, v_location_id, 5);

  -- Insert a recipe with one ingredient
  INSERT INTO chefbyte.recipes (recipe_id, user_id, name, base_servings)
  VALUES (v_recipe_id, v_user_id, 'Grilled Chicken', 2);

  INSERT INTO chefbyte.recipe_ingredients (recipe_id, user_id, product_id, quantity, unit)
  VALUES (v_recipe_id, v_user_id, v_product_id, 1, 'container');

  -- Insert a meal_prep meal plan entry
  INSERT INTO chefbyte.meal_plan_entries (meal_id, user_id, recipe_id, logical_date, meal_type, servings, meal_prep)
  VALUES (v_meal_id, v_user_id, v_recipe_id, CURRENT_DATE, 'lunch', 2, true);

  -- Execute mark_meal_done
  PERFORM private.mark_meal_done(v_user_id, v_meal_id);
END$$;

SELECT results_eq(
  $$SELECT is_distinct_unit_item, default_recipe_unit
    FROM chefbyte.products
    WHERE name LIKE '[MEAL]%'
    ORDER BY created_at DESC
    LIMIT 1$$,
  $$VALUES (true, 'serving')$$,
  '[MEAL] product has is_distinct_unit_item=true, default_recipe_unit=''serving'''
);

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Non-[MEAL] products keep default values (false, NULL)
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_uid UUID := tests.create_supabase_user('distinct-plain-user-' || gen_random_uuid()::text);
BEGIN
  INSERT INTO chefbyte.products (user_id, name)
  VALUES (v_uid, 'Plain Product Distinct Test');
END$$;

SELECT results_eq(
  $$SELECT is_distinct_unit_item, default_recipe_unit
    FROM chefbyte.products
    WHERE name = 'Plain Product Distinct Test'
    ORDER BY created_at DESC
    LIMIT 1$$,
  $$VALUES (false, NULL::TEXT)$$,
  'Plain product keeps default is_distinct_unit_item=false, default_recipe_unit=NULL'
);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Can explicitly set is_distinct_unit_item=true + default_recipe_unit
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_uid UUID := tests.create_supabase_user('distinct-eggs-user-' || gen_random_uuid()::text);
BEGIN
  INSERT INTO chefbyte.products (user_id, name, is_distinct_unit_item, default_recipe_unit)
  VALUES (v_uid, 'Eggs Distinct Test', true, 'serving');
END$$;

SELECT results_eq(
  $$SELECT is_distinct_unit_item, default_recipe_unit
    FROM chefbyte.products
    WHERE name = 'Eggs Distinct Test'
    ORDER BY created_at DESC
    LIMIT 1$$,
  $$VALUES (true, 'serving')$$,
  'Can explicitly set is_distinct_unit_item=true, default_recipe_unit=''serving'''
);

-- ─────────────────────────────────────────────────────────────────────────
-- 6. UPDATE sets the columns correctly
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_uid UUID := tests.create_supabase_user('distinct-yogurt-user-' || gen_random_uuid()::text);
  v_pid UUID;
BEGIN
  INSERT INTO chefbyte.products (user_id, name)
  VALUES (v_uid, 'Yogurt Distinct Test')
  RETURNING product_id INTO v_pid;

  UPDATE chefbyte.products
  SET default_recipe_unit = 'gram'
  WHERE product_id = v_pid;
END$$;

SELECT results_eq(
  $$SELECT default_recipe_unit
    FROM chefbyte.products
    WHERE name = 'Yogurt Distinct Test'
    ORDER BY created_at DESC
    LIMIT 1$$,
  $$VALUES ('gram')$$,
  'Can UPDATE default_recipe_unit to ''gram'''
);

-- ─────────────────────────────────────────────────────────────────────────
-- 7. CHECK constraint validates constraint name exists in DB
-- ─────────────────────────────────────────────────────────────────────────

SELECT ok(
  (SELECT COUNT(*) > 0
   FROM information_schema.table_constraints
   WHERE table_schema = 'chefbyte'
     AND table_name = 'products'
     AND constraint_type = 'CHECK'
     AND constraint_name = 'products_default_recipe_unit_check'),
  'products_default_recipe_unit_check constraint exists'
);

SELECT finish();
ROLLBACK;
