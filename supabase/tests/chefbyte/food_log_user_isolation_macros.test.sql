-- Audit item #39: food_log per-user isolation in daily_macros rollup.
--
-- Implicitly covered today by RLS on chefbyte.food_logs and the
-- ``WHERE user_id = p_user_id`` filter inside
-- ``private.get_daily_macros``. This suite makes the guarantee
-- EXPLICIT so a future RLS-policy flip (``USING (true)``) or a typo
-- in the rollup (dropping the user_id filter to chase a "performance"
-- issue) can't silently leak cross-user data into the macros tile.
--
-- Scenario: User A consumes 500 cal on 2026-04-21. User B consumes 500
-- cal on 2026-04-21 (independently). Assert each user's macros RPC
-- returns 500, NOT 1000. Repeat for temp_items (same rollup function,
-- second source). Spot-check mixed sources so a regression in either
-- branch can't mask the other.

BEGIN;
SELECT plan(10);

-- ─────────────────────────────────────────────────────────────
-- Setup: two independent users, each with their own product rows
-- ─────────────────────────────────────────────────────────────

SELECT tests.create_supabase_user('macro_iso_a');
SELECT tests.create_supabase_user('macro_iso_b');

-- User A: create product + log 500 cal via food_logs on 2026-04-21.
SELECT tests.authenticate_as('macro_iso_a');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  product_id, user_id, name,
  servings_per_container, calories_per_serving,
  protein_per_serving, fat_per_serving, carbs_per_serving
) VALUES (
  '70000000-0000-0000-0000-0000000000a1',
  tests.get_supabase_uid('macro_iso_a'),
  'A-Product', 1, 500, 30, 10, 40
);

-- 500 cal food log for User A on 2026-04-21.
INSERT INTO chefbyte.food_logs (
  user_id, product_id, logical_date,
  qty_consumed, unit, calories, carbs, protein, fat
) VALUES (
  tests.get_supabase_uid('macro_iso_a'),
  '70000000-0000-0000-0000-0000000000a1',
  '2026-04-21', 1, 'container', 500, 40, 30, 10
);

-- User B: create product + log 500 cal via food_logs on 2026-04-21.
SELECT tests.authenticate_as('macro_iso_b');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  product_id, user_id, name,
  servings_per_container, calories_per_serving,
  protein_per_serving, fat_per_serving, carbs_per_serving
) VALUES (
  '70000000-0000-0000-0000-0000000000b1',
  tests.get_supabase_uid('macro_iso_b'),
  'B-Product', 1, 500, 50, 20, 30
);

INSERT INTO chefbyte.food_logs (
  user_id, product_id, logical_date,
  qty_consumed, unit, calories, carbs, protein, fat
) VALUES (
  tests.get_supabase_uid('macro_iso_b'),
  '70000000-0000-0000-0000-0000000000b1',
  '2026-04-21', 1, 'container', 500, 30, 50, 20
);

-- ─────────────────────────────────────────────────────────────
-- Part A — As User A, get_daily_macros returns only A's 500 cal.
-- ─────────────────────────────────────────────────────────────

SELECT tests.authenticate_as('macro_iso_a');

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-04-21'::date))->'calories'->>'consumed')::numeric),
  500::numeric,
  'User A calories consumed = 500 (NOT 1000 — User B''s 500 is not included)'
);

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-04-21'::date))->'protein'->>'consumed')::numeric),
  30::numeric,
  'User A protein consumed = 30 (User B''s 50 is not leaked)'
);

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-04-21'::date))->'carbs'->>'consumed')::numeric),
  40::numeric,
  'User A carbs consumed = 40 (User B''s 30 is not leaked)'
);

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-04-21'::date))->'fat'->>'consumed')::numeric),
  10::numeric,
  'User A fat consumed = 10 (User B''s 20 is not leaked)'
);

-- ─────────────────────────────────────────────────────────────
-- Part B — As User B, get_daily_macros returns only B's 500 cal.
-- ─────────────────────────────────────────────────────────────

SELECT tests.authenticate_as('macro_iso_b');

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-04-21'::date))->'calories'->>'consumed')::numeric),
  500::numeric,
  'User B calories consumed = 500 (NOT 1000 — User A''s 500 is not included)'
);

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-04-21'::date))->'protein'->>'consumed')::numeric),
  50::numeric,
  'User B protein consumed = 50 (User A''s 30 is not leaked)'
);

-- ─────────────────────────────────────────────────────────────
-- Part C — temp_items source (second rollup branch inside
-- get_daily_macros). Add a temp_item to User A only; verify it
-- appears for A and does NOT leak to B.
-- ─────────────────────────────────────────────────────────────

SELECT tests.authenticate_as('macro_iso_a');

INSERT INTO chefbyte.temp_items (
  user_id, name, logical_date,
  calories, carbs, protein, fat
) VALUES (
  tests.get_supabase_uid('macro_iso_a'),
  'A-Coffee', '2026-04-21', 50, 5, 0, 2
);

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-04-21'::date))->'calories'->>'consumed')::numeric),
  550::numeric,
  'User A calories = 550 (500 food_logs + 50 temp_item)'
);

-- Switch to User B — their total must still be 500, not 550/1050.
SELECT tests.authenticate_as('macro_iso_b');

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-04-21'::date))->'calories'->>'consumed')::numeric),
  500::numeric,
  'User B calories = 500 after A added a temp_item (A''s 50cal temp_item not leaked)'
);

-- ─────────────────────────────────────────────────────────────
-- Part D — Goal isolation. User A sets a custom calorie goal in
-- user_config. User B reads the default. Goals must be per-user.
-- ─────────────────────────────────────────────────────────────

SELECT tests.authenticate_as('macro_iso_a');
INSERT INTO chefbyte.user_config (user_id, key, value)
VALUES (tests.get_supabase_uid('macro_iso_a'), 'goal_calories', '2500');

SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-04-21'::date))->'calories'->>'goal')::numeric),
  2500::numeric,
  'User A calorie goal = 2500 (custom)'
);

SELECT tests.authenticate_as('macro_iso_b');
SELECT is(
  (SELECT ((chefbyte.get_daily_macros('2026-04-21'::date))->'calories'->>'goal')::numeric),
  2000::numeric,
  'User B calorie goal = 2000 (default, NOT User A''s 2500)'
);

SELECT * FROM finish();
ROLLBACK;
