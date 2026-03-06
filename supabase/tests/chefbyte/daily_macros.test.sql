BEGIN;
SELECT plan(31);

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

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'protein'->>'consumed')::numeric),
  0::numeric,
  'no data returns protein consumed = 0'
);

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'fat'->>'consumed')::numeric),
  0::numeric,
  'no data returns fat consumed = 0'
);

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'carbs'->>'consumed')::numeric),
  0::numeric,
  'no data returns carbs consumed = 0'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Remaining is 0 (not NULL) in zero-data case
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'calories'->>'remaining')::numeric),
  2000::numeric,
  'calories remaining = default goal (2000) when no data and no user config'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Insert food_log (product, 200cal/30p/5f/10c)
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
-- Test 6: get_daily_macros returns fat consumed = 7
-- (5 from food_log + 2 from temp_item)
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'fat'->>'consumed')::numeric),
  7::numeric,
  'fat consumed = 7 (5 food_log + 2 temp_item)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 7: get_daily_macros returns carbs consumed = 15
-- (10 from food_log + 5 from temp_item)
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'carbs'->>'consumed')::numeric),
  15::numeric,
  'carbs consumed = 15 (10 food_log + 5 temp_item)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 8: Goal = 0 when no config exists
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'calories'->>'goal')::numeric),
  2000::numeric,
  'calories goal = server default (2000) when no user_config set'
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
-- Test: goal_protein config key
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  format(
    'INSERT INTO chefbyte.user_config (user_id, key, value)
     VALUES (%L, ''goal_protein'', ''150'')',
    tests.get_supabase_uid('macro_tester')
  ),
  'insert user_config goal_protein=150 succeeds'
);

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'protein'->>'goal')::numeric),
  150::numeric,
  'protein goal = 150 after setting goal_protein config'
);

-- ─────────────────────────────────────────────────────────────
-- Test: goal_carbs config key
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  format(
    'INSERT INTO chefbyte.user_config (user_id, key, value)
     VALUES (%L, ''goal_carbs'', ''250'')',
    tests.get_supabase_uid('macro_tester')
  ),
  'insert user_config goal_carbs=250 succeeds'
);

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'carbs'->>'goal')::numeric),
  250::numeric,
  'carbs goal = 250 after setting goal_carbs config'
);

-- ─────────────────────────────────────────────────────────────
-- Test: goal_fat config key (note: key is goal_fat, output is fat)
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  format(
    'INSERT INTO chefbyte.user_config (user_id, key, value)
     VALUES (%L, ''goal_fat'', ''65'')',
    tests.get_supabase_uid('macro_tester')
  ),
  'insert user_config goal_fat=65 succeeds'
);

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'fat'->>'goal')::numeric),
  65::numeric,
  'fat goal = 65 after setting goal_fat config'
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
-- Test 13: Insert liquidtrack device + event with known macros
-- Device with product, event with 100cal/8p/4f/12c
-- ─────────────────────────────────────────────────────────────

INSERT INTO chefbyte.liquidtrack_devices (
  device_id, user_id, device_name, product_id, import_key_hash
) VALUES (
  '70000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('macro_tester'),
  'Kitchen Scale',
  '60000000-0000-0000-0000-000000000001',
  'testhash123'
);

INSERT INTO chefbyte.liquidtrack_events (
  user_id, device_id, weight_before, weight_after, consumption,
  calories, carbs, protein, fat, logical_date
) VALUES (
  tests.get_supabase_uid('macro_tester'),
  '70000000-0000-0000-0000-000000000001',
  500, 400, 100,
  100, 12, 8, 4,
  '2026-03-03'
);

-- ─────────────────────────────────────────────────────────────
-- Test 14: Daily macros now include liquidtrack event
-- Total calories: 250 (food+temp) + 100 (lt) = 350
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'calories'->>'consumed')::numeric),
  350::numeric,
  'calories consumed = 350 after adding liquidtrack event (250 + 100)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 15: Protein includes liquidtrack contribution
-- Total protein: 30 (food+temp) + 8 (lt) = 38
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'protein'->>'consumed')::numeric),
  38::numeric,
  'protein consumed = 38 after adding liquidtrack event (30 + 8)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 16: Fat includes liquidtrack contribution
-- Total fat: 7 (food+temp) + 4 (lt) = 11
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'fat'->>'consumed')::numeric),
  11::numeric,
  'fat consumed = 11 after adding liquidtrack event (7 + 4)'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Carbs includes liquidtrack contribution
-- Total carbs: 15 (food+temp) + 12 (lt) = 27
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'carbs'->>'consumed')::numeric),
  27::numeric,
  'carbs consumed = 27 after adding liquidtrack event (15 + 12)'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Negative remaining when consumed exceeds goal
-- Set goal to 1000 cal, already consumed 350 from earlier tests.
-- Add 700 more to bring total to 1050, verify remaining = -50
-- (goal 1000 was set earlier but actually the goal is 2000;
-- we'll use a different date to isolate and set goal to 1000)
-- ─────────────────────────────────────────────────────────────

-- Use a new date to isolate this test
INSERT INTO chefbyte.food_logs (user_id, product_id, logical_date,
  qty_consumed, unit, calories, carbs, protein, fat)
VALUES (
  tests.get_supabase_uid('macro_tester'),
  '60000000-0000-0000-0000-000000000001',
  '2026-03-10', 5, 'container', 1500, 50, 150, 25
);

-- Update goal_calories to 1000 (applies to all dates since user_config is not per-date)
UPDATE chefbyte.user_config
SET value = '1000'
WHERE user_id = tests.get_supabase_uid('macro_tester')
  AND key = 'goal_calories';

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-10'::date))->'calories'->>'remaining')::numeric),
  -500::numeric,
  'negative remaining = 1000 - 1500 = -500 when consumed exceeds goal'
);

-- Reset goal back to 2000 for subsequent tests
UPDATE chefbyte.user_config
SET value = '2000'
WHERE user_id = tests.get_supabase_uid('macro_tester')
  AND key = 'goal_calories';

-- ─────────────────────────────────────────────────────────────
-- Test: Multiple food_logs on same date sum correctly
-- Insert 3 food_logs for a fresh date with different calories
-- and verify the total is the sum
-- ─────────────────────────────────────────────────────────────

INSERT INTO chefbyte.food_logs (user_id, product_id, logical_date,
  qty_consumed, unit, calories, carbs, protein, fat)
VALUES
  (tests.get_supabase_uid('macro_tester'),
   '60000000-0000-0000-0000-000000000001',
   '2026-03-11', 1, 'container', 200, 10, 30, 5),
  (tests.get_supabase_uid('macro_tester'),
   '60000000-0000-0000-0000-000000000001',
   '2026-03-11', 1, 'container', 350, 20, 40, 8),
  (tests.get_supabase_uid('macro_tester'),
   '60000000-0000-0000-0000-000000000001',
   '2026-03-11', 1, 'container', 450, 30, 50, 12);

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-11'::date))->'calories'->>'consumed')::numeric),
  1000::numeric,
  'multiple food_logs on same date: calories sum = 200 + 350 + 450 = 1000'
);

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-11'::date))->'protein'->>'consumed')::numeric),
  120::numeric,
  'multiple food_logs on same date: protein sum = 30 + 40 + 50 = 120'
);

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-11'::date))->'fat'->>'consumed')::numeric),
  25::numeric,
  'multiple food_logs on same date: fat sum = 5 + 8 + 12 = 25'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Cross-user isolation — User B sees no macros from User A
-- ─────────────────────────────────────────────────────────────

SELECT tests.clear_authentication();
SELECT tests.create_supabase_user('macro_intruder');
SELECT tests.authenticate_as('macro_intruder');
SELECT hub.activate_app('chefbyte');

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-03-03'::date))->'calories'->>'consumed')::numeric),
  0::numeric,
  'User B sees 0 calories consumed — cannot see User A macros (cross-user isolation)'
);

-- ─────────────────────────────────────────────────────────────
-- Teardown
-- ─────────────────────────────────────────────────────────────

SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('macro_intruder');
SELECT tests.delete_supabase_user('macro_tester');

SELECT * FROM finish();
ROLLBACK;
