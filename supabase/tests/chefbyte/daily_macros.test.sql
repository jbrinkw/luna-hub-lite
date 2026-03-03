BEGIN;
SELECT plan(10);

-- ─────────────────────────────────────────────────────────────
-- Setup
-- ─────────────────────────────────────────────────────────────

SELECT tests.create_supabase_user('macro_tester');
SELECT tests.authenticate_as('macro_tester');
SELECT hub.activate_app('chefbyte');

-- Create a product for food_log entries
INSERT INTO chefbyte.products (product_id, user_id, name,
  servings_per_container, calories_per_serving,
  protein_per_serving, fat_per_serving, carbs_per_serving)
VALUES (
  '60000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('macro_tester'),
  'Test Product', 1, 200, 30, 5, 10
);

-- ─────────────────────────────────────────────────────────────
-- Test 1: No data returns all zeros
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'calories'->>'consumed')::numeric),
  0::numeric,
  'no data returns calories consumed = 0'
);

-- ─────────────────────────────────────────────────────────────
-- Test 2: Insert food_log (product, 200cal/30p/5f/10c)
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  format(
    'INSERT INTO chefbyte.food_logs (user_id, product_id, logical_date,
       qty_consumed, unit, calories, carbs, protein, fat)
     VALUES (%L, %L, ''2026-03-03'', 1, ''container'', 200, 10, 30, 5)',
    tests.get_supabase_uid('macro_tester'),
    '60000000-0000-0000-0000-000000000001'
  ),
  'insert food_log entry succeeds'
);

-- ─────────────────────────────────────────────────────────────
-- Test 3: Insert temp_item ("Coffee", 50cal/0p/2f/5c)
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  format(
    'INSERT INTO chefbyte.temp_items (user_id, name, logical_date,
       calories, carbs, protein, fat)
     VALUES (%L, ''Coffee'', ''2026-03-03'', 50, 5, 0, 2)',
    tests.get_supabase_uid('macro_tester')
  ),
  'insert temp_item entry succeeds'
);

-- ─────────────────────────────────────────────────────────────
-- Test 4: get_daily_macros returns calories consumed = 250
-- (200 from food_log + 50 from temp_item)
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'calories'->>'consumed')::numeric),
  250::numeric,
  'calories consumed = 250 (200 food_log + 50 temp_item)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 5: get_daily_macros returns protein consumed = 30
-- (30 from food_log + 0 from temp_item)
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'protein'->>'consumed')::numeric),
  30::numeric,
  'protein consumed = 30 (30 food_log + 0 temp_item)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 6: Goal = 0 when no config exists
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'calories'->>'goal')::numeric),
  0::numeric,
  'calories goal = 0 when no user_config set'
);

-- ─────────────────────────────────────────────────────────────
-- Test 7: Insert user_config goal_calories=2000
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  format(
    'INSERT INTO chefbyte.user_config (user_id, key, value)
     VALUES (%L, ''goal_calories'', ''2000'')',
    tests.get_supabase_uid('macro_tester')
  ),
  'insert user_config goal_calories=2000 succeeds'
);

-- ─────────────────────────────────────────────────────────────
-- Test 8: get_daily_macros returns calories goal = 2000
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'calories'->>'goal')::numeric),
  2000::numeric,
  'calories goal = 2000 after setting user_config'
);

-- ─────────────────────────────────────────────────────────────
-- Test 9: get_daily_macros returns calories remaining = 1750
-- (2000 goal - 250 consumed)
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'calories'->>'remaining')::numeric),
  1750::numeric,
  'calories remaining = 1750 (2000 goal - 250 consumed)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 10: Different date returns all zeros (isolation)
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-04'::date))->'calories'->>'consumed')::numeric),
  0::numeric,
  'different date returns calories consumed = 0 (date isolation)'
);

-- ─────────────────────────────────────────────────────────────
-- Teardown
-- ─────────────────────────────────────────────────────────────

SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('macro_tester');

SELECT * FROM finish();
ROLLBACK;
