-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — food_logs.logical_date MUST NOT be recomputed
-- from now() on UPDATE.
-- ════════════════════════════════════════════════════════════════════════════
-- Phase 1 audit finding L11/HIGH (AUDIT_FINDINGS_PHASE1.md):
--
--   "Edits must NOT recompute logical_date from now() on update"
--      — docs/superpowers/plans/2026-04-21-pi-to-cloud-audit.md:150
--
-- The grep evidence cited covers INSERT-time logical_date selection (e.g.
-- consume_product.test.sql:399-404) but no test asserts that an UPDATE on an
-- existing row preserves the original logical_date. A regression here
-- silently re-buckets historical macros into today's totals — the macro
-- column for "yesterday" loses a row, today's totals gain it, and the user
-- sees their macro chart shift retroactively whenever they edit a past meal.
--
-- This file pins the rule against three classes of regression:
--   1. A naive trigger that sets logical_date := private.get_logical_date(...)
--      on every UPDATE.
--   2. A trigger that recomputes only when ``qty_consumed`` changed (still
--      catches the "edit yesterday's portion" case).
--   3. A trigger that recomputes only when ``unit`` changed (catches
--      container↔serving conversions on past rows).
--
-- The companion test_quality-tier mutation: introducing
--
--    BEFORE UPDATE ... NEW.logical_date := private.get_logical_date(now(), ...)
--
-- as a trigger function on chefbyte.food_logs trips assertions 1, 3, 5 below.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(6);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('fl_immut_alice');
SELECT tests.authenticate_as('fl_immut_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('fl_immut_alice'),
  'Immutability Test Product',
  500.000, 4,
  100, 10, 5, 2
);

SELECT product_id AS p_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('fl_immut_alice')
   AND name = 'Immutability Test Product' \gset

------------------------------------------------------------
-- Case 1: INSERT a food_logs row dated to a fixed historical date
--         (10 days ago); UPDATE qty_consumed; assert logical_date
--         is still the historical date.
------------------------------------------------------------

INSERT INTO chefbyte.food_logs (
  user_id, product_id, logical_date,
  qty_consumed, unit, calories, carbs, protein, fat,
  created_at
) VALUES (
  tests.get_supabase_uid('fl_immut_alice'),
  :'p_id',
  CURRENT_DATE - INTERVAL '10 days',
  1.0, 'serving', 100, 10, 5, 2,
  now() - INTERVAL '10 days'
);

SELECT log_id AS l1_id
  FROM chefbyte.food_logs
 WHERE user_id = tests.get_supabase_uid('fl_immut_alice')
   AND qty_consumed = 1.0 \gset

UPDATE chefbyte.food_logs
   SET qty_consumed = 2.0,
       calories = 200, carbs = 20, protein = 10, fat = 4
 WHERE log_id = :'l1_id'::UUID;

SELECT is(
  (SELECT logical_date FROM chefbyte.food_logs WHERE log_id = :'l1_id'::UUID),
  (CURRENT_DATE - INTERVAL '10 days')::DATE,
  'case 1: editing qty_consumed on a 10-day-old food_logs row MUST preserve '
    'the original logical_date. Re-bucketing into today silently shifts '
    'historical macros into the current day''s totals.'
);

SELECT isnt(
  (SELECT logical_date FROM chefbyte.food_logs WHERE log_id = :'l1_id'::UUID),
  CURRENT_DATE,
  'case 1: logical_date is NOT today after the qty_consumed UPDATE — '
    'pinning the negative form of the assertion.'
);

------------------------------------------------------------
-- Case 2: UPDATE that touches `unit` (container ↔ serving conversion).
--         The "edit unit on past row" path is the second class the
--         invariant must hold for.
------------------------------------------------------------

INSERT INTO chefbyte.food_logs (
  user_id, product_id, logical_date,
  qty_consumed, unit, calories, carbs, protein, fat,
  created_at
) VALUES (
  tests.get_supabase_uid('fl_immut_alice'),
  :'p_id',
  CURRENT_DATE - INTERVAL '5 days',
  1.0, 'container', 400, 40, 20, 8,
  now() - INTERVAL '5 days'
);

SELECT log_id AS l2_id
  FROM chefbyte.food_logs
 WHERE user_id = tests.get_supabase_uid('fl_immut_alice')
   AND unit = 'container' \gset

UPDATE chefbyte.food_logs
   SET unit = 'serving', qty_consumed = 4.0
 WHERE log_id = :'l2_id'::UUID;

SELECT is(
  (SELECT logical_date FROM chefbyte.food_logs WHERE log_id = :'l2_id'::UUID),
  (CURRENT_DATE - INTERVAL '5 days')::DATE,
  'case 2: editing the unit (container → serving conversion) on a 5-day-old '
    'food_logs row MUST preserve logical_date.'
);

------------------------------------------------------------
-- Case 3: UPDATE that touches no fields the bug would key off of.
--         Bumping created_at (or any unrelated field) on a past row also
--         must NOT recompute logical_date.
------------------------------------------------------------

UPDATE chefbyte.food_logs
   SET meal_id = NULL  -- benign no-op-ish edit
 WHERE log_id = :'l1_id'::UUID;

SELECT is(
  (SELECT logical_date FROM chefbyte.food_logs WHERE log_id = :'l1_id'::UUID),
  (CURRENT_DATE - INTERVAL '10 days')::DATE,
  'case 3: a benign UPDATE (clearing meal_id) on a past row MUST preserve '
    'logical_date — the rule must hold for ANY UPDATE shape, not just qty/unit.'
);

------------------------------------------------------------
-- Case 4: Manually setting logical_date to a different date
--         WORKS (the rule forbids automatic recomputation, not
--         deliberate user-driven change). Sanity-check we haven't
--         accidentally added an immutable column.
------------------------------------------------------------

UPDATE chefbyte.food_logs
   SET logical_date = CURRENT_DATE - INTERVAL '15 days'
 WHERE log_id = :'l1_id'::UUID;

SELECT is(
  (SELECT logical_date FROM chefbyte.food_logs WHERE log_id = :'l1_id'::UUID),
  (CURRENT_DATE - INTERVAL '15 days')::DATE,
  'case 4: explicit logical_date UPDATE works (the invariant is '
    'no-automatic-recomputation, not column-immutability). A regression '
    'that locks the column out would break the manual-correction UX.'
);

------------------------------------------------------------
-- Case 5: Repeat case 1 after the explicit logical_date set above
--         to confirm subsequent UPDATEs still preserve whatever the
--         column currently holds (15 days ago, not today).
------------------------------------------------------------

UPDATE chefbyte.food_logs
   SET qty_consumed = 3.0, calories = 300
 WHERE log_id = :'l1_id'::UUID;

SELECT is(
  (SELECT logical_date FROM chefbyte.food_logs WHERE log_id = :'l1_id'::UUID),
  (CURRENT_DATE - INTERVAL '15 days')::DATE,
  'case 5: after a manual logical_date set, a subsequent qty UPDATE STILL '
    'preserves the (now 15-day-old) logical_date — the invariant is "do not '
    'recompute from now()" regardless of whether logical_date was originally '
    'inserted or manually corrected.'
);

SELECT * FROM finish();
ROLLBACK;
