-- Consume pipeline invariants (2026-04-22 audit).
--
-- Dedicated coverage for the three invariants most prone to silent breakage
-- in the stock_lots → food_logs → daily macros pipeline:
--
--   1. LOGICAL_DATE at the day_start_hour boundary. food_logs inserted via
--      private.consume_product must land on the logical_date supplied by
--      the caller; the UI computes that date via todayStr(dayStartHour).
--      A consume at 05:30 local with day_start_hour=6 must attribute to
--      YESTERDAY's logical_date, NOT today's calendar date.
--
--   2. [MEAL] lot consumption logs macros via the [MEAL] product's
--      per-serving fields — NOT by re-walking the underlying recipe
--      ingredient chain. Meal-prep execution already debited raw
--      ingredients WITHOUT logging macros; re-counting them when the
--      [MEAL] lot is later consumed would double-bill the macros.
--
--   3. MacroPage totals obey the 4-4-9 rule: the sum of per-macro
--      consumed totals (from get_daily_macros) matches 4*protein +
--      4*carbs + 9*fat within a ±10 kcal rounding tolerance when
--      every underlying product itself has a 4-4-9-consistent nutrition
--      label. A silently-buggy macro multiplier (e.g. fat counted as
--      ×4 instead of ×9) would drop the calorie total outside this
--      tolerance.

BEGIN;
SELECT plan(14);

-- ═════════════════════════════════════════════════════════════
-- Invariant 1: logical_date at the day_start_hour boundary
-- ═════════════════════════════════════════════════════════════
--
-- Cross-check the primitive first (unauthenticated — private.* is
-- SECURITY DEFINER but callable with superuser in tests), then verify
-- the caller-supplied value lands on food_logs.logical_date intact.

-- 05:30 local, NY, dsh=6 → before rollover → yesterday's logical_date.
-- 2026-04-22T09:30:00Z is 05:30 EDT on 2026-04-22.
SELECT is(
  private.get_logical_date(
    '2026-04-22T09:30:00Z'::timestamptz,
    'America/New_York',
    6
  ),
  '2026-04-21'::date,
  'get_logical_date(05:30 EDT, dsh=6) = 2026-04-21 (before 6am rollover)'
);

-- 07:30 local, NY, dsh=6 → after rollover → today's logical_date.
SELECT is(
  private.get_logical_date(
    '2026-04-22T11:30:00Z'::timestamptz,
    'America/New_York',
    6
  ),
  '2026-04-22'::date,
  'get_logical_date(07:30 EDT, dsh=6) = 2026-04-22 (after 6am rollover)'
);

-- Now seed a user with dsh=6 and verify a consume_product call at the
-- pre-rollover wall clock DOES stamp food_logs.logical_date with the
-- yesterday-attributed date.
SELECT tests.create_supabase_user('pipeline_dsh');
SELECT tests.authenticate_as('pipeline_dsh');
SELECT hub.activate_app('chefbyte');

UPDATE hub.profiles
   SET timezone = 'America/New_York',
       day_start_hour = 6
 WHERE user_id = tests.get_supabase_uid('pipeline_dsh');

SELECT location_id AS fridge_id
  FROM chefbyte.locations
  WHERE user_id = tests.get_supabase_uid('pipeline_dsh') AND name = 'Fridge' \gset

-- 4-4-9-consistent product: 1 spc, 4cal/1p/0c/0f per serving
--   → 1 serving = 1g protein * 4 = 4 cal ✓
INSERT INTO chefbyte.products (product_id, user_id, name,
  servings_per_container, calories_per_serving, protein_per_serving,
  fat_per_serving, carbs_per_serving)
VALUES (
  'a1111111-1111-1111-1111-111111111111',
  tests.get_supabase_uid('pipeline_dsh'),
  'Pipeline Chicken', 1, 4, 1, 0, 0
);

INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
VALUES (
  tests.get_supabase_uid('pipeline_dsh'),
  'a1111111-1111-1111-1111-111111111111',
  :'fridge_id', 10.0, '2026-06-01'
);

-- Simulate a consume at 05:30 local on 2026-04-22 — client passed
-- yesterday's logical_date (2026-04-21). food_logs must stamp exactly
-- that, untouched by server wall clock.
SELECT chefbyte.consume_product(
  'a1111111-1111-1111-1111-111111111111'::uuid,
  1, 'container', true, '2026-04-21'::date
);

SELECT is(
  (SELECT logical_date FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('pipeline_dsh')
      AND product_id = 'a1111111-1111-1111-1111-111111111111'
    ORDER BY created_at DESC LIMIT 1),
  '2026-04-21'::date,
  'consume at 05:30 local (dsh=6) stamps food_logs.logical_date = 2026-04-21 (yesterday)'
);

-- And the daily-macros RPC for 2026-04-21 sees those 4 cal (not 2026-04-22).
SELECT is(
  ((chefbyte.get_daily_macros('2026-04-21'::date))->'calories'->>'consumed')::numeric,
  4::numeric,
  'get_daily_macros(2026-04-21) sees the yesterday-stamped consume (4 cal)'
);

SELECT is(
  ((chefbyte.get_daily_macros('2026-04-22'::date))->'calories'->>'consumed')::numeric,
  0::numeric,
  'get_daily_macros(2026-04-22) sees zero cal — row stamped to yesterday, not today'
);

-- ═════════════════════════════════════════════════════════════
-- Invariant 2: [MEAL] lot consumption does NOT double-count macros
-- ═════════════════════════════════════════════════════════════
--
-- Scenario:
--   Recipe "TestBowl" base_servings=2 with 2 ingredients:
--     Chicken (50cal/10p/0c/1.11f per serving, 1 spc) × 1 container
--     Rice    (100cal/2p/22c/0.22f per serving, 1 spc) × 1 container
--
--   Recipe per-base-serving:
--     cal = (50 + 100) / 2 = 75
--     p   = (10 + 2)   / 2 = 6
--     c   = (0 + 22)   / 2 = 11
--     f   = (1.11 + 0.22)/2 = 0.665
--
--   Meal (servings=2, meal_prep=true) → consumes ingredients WITHOUT
--   logging macros, produces [MEAL] lot with per-serving:
--     cal_per_serving = (50 + 100) / 2 servings = 75
--     ... (matching recipe per-serving by construction).
--
--   Then consume 1 container (1 serving) of the [MEAL] lot WITH
--   p_log_macros=true. That single food_logs row must carry the
--   [MEAL] product's per-serving macros (cal=75, p=6, c=11, f=0.665)
--   NOT twice those values.
--
--   If a future refactor "helpfully" also logged the raw ingredient
--   macros during meal-prep execution (re-setting log_macros=true on
--   the ingredient consumes), the [MEAL] consume would produce the
--   SAME 75 cal while the prior step already logged 150. This test
--   pins the single-logging behavior.

-- Chicken (4-4-9-consistent: 10p × 4 = 40cal + 1.11f × 9 ≈ 10cal → ~50cal)
INSERT INTO chefbyte.products (product_id, user_id, name,
  servings_per_container, calories_per_serving, protein_per_serving,
  fat_per_serving, carbs_per_serving)
VALUES (
  'a2222222-2222-2222-2222-222222222221',
  tests.get_supabase_uid('pipeline_dsh'),
  'MealChicken', 1, 50, 10, 1.11, 0
);

-- Rice (4-4-9-consistent: 2p × 4 + 22c × 4 + 0.22f × 9 ≈ 8 + 88 + 2 = 98 ≈ 100cal)
INSERT INTO chefbyte.products (product_id, user_id, name,
  servings_per_container, calories_per_serving, protein_per_serving,
  fat_per_serving, carbs_per_serving)
VALUES (
  'a2222222-2222-2222-2222-222222222222',
  tests.get_supabase_uid('pipeline_dsh'),
  'MealRice', 1, 100, 2, 0.22, 22
);

INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
VALUES
  (tests.get_supabase_uid('pipeline_dsh'), 'a2222222-2222-2222-2222-222222222221',
   :'fridge_id', 5.0, '2026-06-10'),
  (tests.get_supabase_uid('pipeline_dsh'), 'a2222222-2222-2222-2222-222222222222',
   :'fridge_id', 5.0, '2026-06-10');

INSERT INTO chefbyte.recipes (recipe_id, user_id, name, base_servings)
VALUES (
  'b3333333-3333-3333-3333-333333333333',
  tests.get_supabase_uid('pipeline_dsh'),
  'TestBowl', 2
);

INSERT INTO chefbyte.recipe_ingredients (user_id, recipe_id, product_id, quantity, unit)
VALUES
  (tests.get_supabase_uid('pipeline_dsh'),
   'b3333333-3333-3333-3333-333333333333',
   'a2222222-2222-2222-2222-222222222221', 1, 'container'),
  (tests.get_supabase_uid('pipeline_dsh'),
   'b3333333-3333-3333-3333-333333333333',
   'a2222222-2222-2222-2222-222222222222', 1, 'container');

-- Meal prep entry on 2026-05-01 with 2 servings (scale_factor = 1.0)
INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
) VALUES (
  'c4444444-4444-4444-4444-444444444444',
  tests.get_supabase_uid('pipeline_dsh'),
  'b3333333-3333-3333-3333-333333333333',
  '2026-05-01', 2, true
);

-- Execute meal prep — consumes ingredients silently, creates [MEAL] product
SELECT chefbyte.mark_meal_done('c4444444-4444-4444-4444-444444444444'::uuid);

-- KEY: meal-prep execution must NOT write food_logs. Macros come only
-- from the [MEAL] lot consume below.
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('pipeline_dsh')
      AND logical_date = '2026-05-01'),
  0,
  '[MEAL] invariant: meal_prep execution writes 0 food_logs (macros deferred until lot consume)'
);

-- Locate the auto-created [MEAL] product
SELECT product_id AS meal_product_id
  FROM chefbyte.products
  WHERE user_id = tests.get_supabase_uid('pipeline_dsh')
    AND name LIKE '[MEAL] TestBowl 05-01%' \gset

SELECT ok(
  :'meal_product_id' IS NOT NULL,
  '[MEAL] product auto-created by mark_meal_done (meal_prep branch)'
);

-- The [MEAL] product stores aggregated per-serving macros. Meal had
-- servings=2; total cal = 50 + 100 = 150; per-serving cal = 75.
-- protein total = 10 + 2 = 12 → per-serving = 6.
SELECT is(
  (SELECT calories_per_serving FROM chefbyte.products
    WHERE product_id = :'meal_product_id'::uuid),
  75.000::numeric,
  '[MEAL] product per-serving calories = 75 (150 total / 2 servings)'
);

-- Consume 1 container (= 1 serving, spc=meal.servings=2, wait... careful:
-- mark_meal_done sets servings_per_container = v_meal.servings = 2 and
-- container qty = 1. So the [MEAL] lot has qty_containers=1 containing 2
-- servings. Consume 1 container → 2 servings × 75 cal = 150 cal total.
SELECT chefbyte.consume_product(
  :'meal_product_id'::uuid,
  1, 'container', true, '2026-05-02'::date
);

SELECT is(
  (SELECT calories FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('pipeline_dsh')
      AND product_id = :'meal_product_id'::uuid
    ORDER BY created_at DESC LIMIT 1),
  150.000::numeric,
  '[MEAL] lot consume logs 150 cal (2 servings * 75 cal/serving) — NOT re-counted via ingredients'
);

-- food_logs count for the [MEAL] consume day is exactly 1 (just the
-- [MEAL] lot row). If a regression caused ingredient double-logging,
-- we'd see 3 rows (1 + 2 raw ingredients).
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('pipeline_dsh')
      AND logical_date = '2026-05-02'),
  1,
  '[MEAL] lot consume writes exactly 1 food_log — no ingredient double-count'
);

-- ═════════════════════════════════════════════════════════════
-- Invariant 3: 4-4-9 calorie math on MacroPage totals
-- ═════════════════════════════════════════════════════════════
--
-- get_daily_macros aggregates calories + protein + carbs + fat from
-- food_logs + temp_items. Each underlying product was defined with
-- 4-4-9-consistent macros. The totals for the day MUST satisfy:
--   |total_cal - (4*protein + 4*carbs + 9*fat)| ≤ 10 kcal
--
-- We've already logged:
--   - 1 Pipeline Chicken consume at 2026-04-21 (1 container × 1 spc ×
--     {4cal/1p/0c/0f}) → food_log: 4 cal, 1 p, 0 c, 0 f
-- Add more 4-4-9-consistent entries on 2026-04-21 for a richer total.

-- Temp item (quick-add coffee with butter): 100cal, 0p, 1c, 10.67f
--   Check: 4*0 + 4*1 + 9*10.67 ≈ 96 + 4 = 100 ✓
INSERT INTO chefbyte.temp_items (user_id, name, logical_date,
  calories, protein, carbs, fat)
VALUES (
  tests.get_supabase_uid('pipeline_dsh'),
  'Bulletproof Coffee', '2026-04-21'::date,
  100, 0, 1, 10.67
);

-- Consume more Pipeline Chicken: 5 containers more
SELECT chefbyte.consume_product(
  'a1111111-1111-1111-1111-111111111111'::uuid,
  5, 'container', true, '2026-04-21'::date
);

-- Pull the aggregated totals
SELECT
  ((chefbyte.get_daily_macros('2026-04-21'::date))->'calories'->>'consumed')::numeric AS d_cal,
  ((chefbyte.get_daily_macros('2026-04-21'::date))->'protein'->>'consumed')::numeric  AS d_p,
  ((chefbyte.get_daily_macros('2026-04-21'::date))->'carbs'->>'consumed')::numeric    AS d_c,
  ((chefbyte.get_daily_macros('2026-04-21'::date))->'fat'->>'consumed')::numeric      AS d_f
  \gset

-- Expected: 4 (first consume) + 5*4 (second) + 100 (temp) = 124 cal
SELECT is(
  :d_cal,
  124::numeric,
  '4-4-9 invariant: daily total calories = 124 (4 + 20 + 100)'
);

-- 4-4-9 check: |cal - (4*p + 4*c + 9*f)| ≤ 10
SELECT ok(
  abs(:d_cal - (4 * :d_p + 4 * :d_c + 9 * :d_f)) <= 10,
  format(
    '4-4-9 invariant: |%s - (4*%s + 4*%s + 9*%s)| = %s ≤ 10 kcal tolerance',
    :d_cal, :d_p, :d_c, :d_f,
    abs(:d_cal - (4 * :d_p + 4 * :d_c + 9 * :d_f))
  )
);

-- Tighter sanity: if every input obeys 4-4-9 and computed cal = stored cal
-- (which consume_product enforces via qty × per_serving), then the
-- Pythagorean check should be very tight, typically ≤ 2 kcal. Pin that.
SELECT ok(
  abs(:d_cal - (4 * :d_p + 4 * :d_c + 9 * :d_f)) <= 2,
  '4-4-9 invariant: actual drift ≤ 2 kcal (tighter bound — all inputs are 4-4-9 consistent)'
);

-- Counter-example confidence check: manually insert a temp item that
-- VIOLATES 4-4-9 (cal claims 500 but macros imply 50). Daily totals must
-- now fail the ≤10 kcal tolerance — proving the assertion actually bites.
INSERT INTO chefbyte.temp_items (user_id, name, logical_date,
  calories, protein, carbs, fat)
VALUES (
  tests.get_supabase_uid('pipeline_dsh'),
  'Ghost Calories (test probe)', '2026-04-20'::date,
  500, 0, 0, 0  -- 500 cal with ZERO macros → breaks 4-4-9
);

SELECT
  ((chefbyte.get_daily_macros('2026-04-20'::date))->'calories'->>'consumed')::numeric AS g_cal,
  ((chefbyte.get_daily_macros('2026-04-20'::date))->'protein'->>'consumed')::numeric  AS g_p,
  ((chefbyte.get_daily_macros('2026-04-20'::date))->'carbs'->>'consumed')::numeric    AS g_c,
  ((chefbyte.get_daily_macros('2026-04-20'::date))->'fat'->>'consumed')::numeric      AS g_f
  \gset

SELECT ok(
  abs(:g_cal - (4 * :g_p + 4 * :g_c + 9 * :g_f)) > 10,
  '4-4-9 invariant: counter-example (ghost cal) fails ≤10 kcal bound — assertion has teeth'
);

-- ─────────────────────────────────────────────────────────────
-- Teardown
-- ─────────────────────────────────────────────────────────────
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('pipeline_dsh');

SELECT * FROM finish();
ROLLBACK;
