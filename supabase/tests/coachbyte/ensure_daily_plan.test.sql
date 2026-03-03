BEGIN;
SELECT plan(29);

-- Setup
SELECT tests.create_supabase_user('edp_user');
SELECT tests.authenticate_as('edp_user');
SELECT hub.activate_app('coachbyte');

-- Get global exercise IDs
CREATE TEMP TABLE _ex ON COMMIT DROP AS
  SELECT exercise_id, LOWER(name) AS ex_name
  FROM coachbyte.exercises
  WHERE user_id IS NULL AND LOWER(name) IN ('squat', 'bench press');

------------------------------------------------------------
-- Setup: Monday split (Squat 3x5 @ 80%, Bench 3x5 @ 185lb)
------------------------------------------------------------
DO $$
DECLARE
  v_squat UUID; v_bench UUID; v_uid UUID;
BEGIN
  SELECT exercise_id INTO v_squat FROM _ex WHERE ex_name = 'squat';
  SELECT exercise_id INTO v_bench FROM _ex WHERE ex_name = 'bench press';
  v_uid := tests.get_supabase_uid('edp_user');

  -- Monday = weekday 1
  INSERT INTO coachbyte.splits (user_id, weekday, template_sets) VALUES (
    v_uid, 1, jsonb_build_array(
      jsonb_build_object('exercise_id', v_squat, 'target_reps', 5, 'target_load_percentage', 80, 'rest_seconds', 180),
      jsonb_build_object('exercise_id', v_squat, 'target_reps', 5, 'target_load_percentage', 80, 'rest_seconds', 180),
      jsonb_build_object('exercise_id', v_squat, 'target_reps', 5, 'target_load_percentage', 80, 'rest_seconds', 180),
      jsonb_build_object('exercise_id', v_bench, 'target_reps', 5, 'target_load', 185, 'rest_seconds', 180),
      jsonb_build_object('exercise_id', v_bench, 'target_reps', 5, 'target_load', 185, 'rest_seconds', 180),
      jsonb_build_object('exercise_id', v_bench, 'target_reps', 5, 'target_load', 185, 'rest_seconds', 180)
    )
  );
END $$;

------------------------------------------------------------
-- Seed PR: Squat e1RM ~302.5 (275lb x 3 reps = 275*1.1 = 302.5)
-- 80% of 302.5 = 242 → round to nearest 5 = 240
------------------------------------------------------------
DO $$
DECLARE
  v_squat UUID; v_uid UUID; v_plan UUID;
BEGIN
  SELECT exercise_id INTO v_squat FROM _ex WHERE ex_name = 'squat';
  v_uid := tests.get_supabase_uid('edp_user');

  INSERT INTO coachbyte.daily_plans (user_id, plan_date, logical_date)
  VALUES (v_uid, '2026-01-01', '2026-01-01')
  RETURNING plan_id INTO v_plan;

  INSERT INTO coachbyte.completed_sets (plan_id, user_id, exercise_id, actual_reps, actual_load, logical_date)
  VALUES (v_plan, v_uid, v_squat, 3, 275, '2026-01-01');
END $$;

------------------------------------------------------------
-- TEST 1-2: ensure_daily_plan for Monday creates plan
-- 2026-03-02 is a Monday
------------------------------------------------------------
SELECT is(
  (SELECT (coachbyte.ensure_daily_plan('2026-03-02'::date))->>'status'),
  'created',
  'ensure_daily_plan returns status=created for new Monday plan'
);

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.daily_plans
   WHERE user_id = tests.get_supabase_uid('edp_user') AND plan_date = '2026-03-02'),
  1,
  'daily_plan row created for 2026-03-02'
);

------------------------------------------------------------
-- TEST 3: 6 planned sets (3 squat + 3 bench)
------------------------------------------------------------
SELECT is(
  (SELECT count(*)::integer FROM coachbyte.planned_sets ps
   JOIN coachbyte.daily_plans dp ON dp.plan_id = ps.plan_id
   WHERE dp.user_id = tests.get_supabase_uid('edp_user') AND dp.plan_date = '2026-03-02'),
  6,
  '6 planned_sets created (3 squat + 3 bench)'
);

------------------------------------------------------------
-- TEST 4-5: Squat loads resolved to 240lb
------------------------------------------------------------
SELECT is(
  (SELECT count(*)::integer FROM coachbyte.planned_sets ps
   JOIN coachbyte.daily_plans dp ON dp.plan_id = ps.plan_id
   WHERE dp.plan_date = '2026-03-02'
     AND ps.exercise_id = (SELECT exercise_id FROM _ex WHERE ex_name = 'squat')
     AND ps.target_load = 240),
  3,
  'Squat target_load = 240 (80% of 302.5, rounded to 5)'
);

SELECT is(
  (SELECT DISTINCT target_reps FROM coachbyte.planned_sets ps
   JOIN coachbyte.daily_plans dp ON dp.plan_id = ps.plan_id
   WHERE dp.plan_date = '2026-03-02'
     AND ps.exercise_id = (SELECT exercise_id FROM _ex WHERE ex_name = 'squat')),
  5,
  'Squat target_reps = 5'
);

------------------------------------------------------------
-- TEST 6-7: Bench at 185lb absolute
------------------------------------------------------------
SELECT is(
  (SELECT count(*)::integer FROM coachbyte.planned_sets ps
   JOIN coachbyte.daily_plans dp ON dp.plan_id = ps.plan_id
   WHERE dp.plan_date = '2026-03-02'
     AND ps.exercise_id = (SELECT exercise_id FROM _ex WHERE ex_name = 'bench press')
     AND ps.target_load = 185),
  3,
  'Bench target_load = 185 (absolute)'
);

SELECT is(
  (SELECT DISTINCT target_reps FROM coachbyte.planned_sets ps
   JOIN coachbyte.daily_plans dp ON dp.plan_id = ps.plan_id
   WHERE dp.plan_date = '2026-03-02'
     AND ps.exercise_id = (SELECT exercise_id FROM _ex WHERE ex_name = 'bench press')),
  5,
  'Bench target_reps = 5'
);

------------------------------------------------------------
-- TEST 8-10: Idempotency
------------------------------------------------------------
SELECT is(
  (SELECT (coachbyte.ensure_daily_plan('2026-03-02'::date))->>'status'),
  'existing',
  'Second call returns status=existing (idempotent)'
);

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.daily_plans
   WHERE user_id = tests.get_supabase_uid('edp_user') AND plan_date = '2026-03-02'),
  1,
  'Still exactly 1 plan after second call'
);

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.planned_sets ps
   JOIN coachbyte.daily_plans dp ON dp.plan_id = ps.plan_id
   WHERE dp.plan_date = '2026-03-02'
     AND dp.user_id = tests.get_supabase_uid('edp_user')),
  6,
  'Still 6 planned_sets (no duplicates)'
);

------------------------------------------------------------
-- TEST 11-13: Tuesday with no split → empty plan
-- 2026-03-03 is a Tuesday
------------------------------------------------------------
SELECT is(
  (SELECT (coachbyte.ensure_daily_plan('2026-03-03'::date))->>'status'),
  'empty',
  'ensure_daily_plan returns status=empty for Tuesday (no split)'
);

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.daily_plans
   WHERE user_id = tests.get_supabase_uid('edp_user') AND plan_date = '2026-03-03'),
  1,
  'Plan row created for Tuesday'
);

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.planned_sets ps
   JOIN coachbyte.daily_plans dp ON dp.plan_id = ps.plan_id
   WHERE dp.plan_date = '2026-03-03'
     AND dp.user_id = tests.get_supabase_uid('edp_user')),
  0,
  'Zero planned_sets for Tuesday (no split)'
);

------------------------------------------------------------
-- TEST 14-16: Day X (0 completed) deleted on Day X+1
-- Day X = 2026-03-04 (Wed), Day X+1 = 2026-03-05 (Thu)
------------------------------------------------------------
SELECT coachbyte.ensure_daily_plan('2026-03-04'::date);

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.daily_plans
   WHERE user_id = tests.get_supabase_uid('edp_user') AND plan_date = '2026-03-04'),
  1,
  'Day X plan exists before Day X+1 ensure'
);

SELECT coachbyte.ensure_daily_plan('2026-03-05'::date);

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.daily_plans
   WHERE user_id = tests.get_supabase_uid('edp_user') AND plan_date = '2026-03-04'),
  0,
  'Day X plan deleted (had 0 completed sets)'
);

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.daily_plans
   WHERE user_id = tests.get_supabase_uid('edp_user') AND plan_date = '2026-03-05'),
  1,
  'Day X+1 plan exists'
);

------------------------------------------------------------
-- TEST 17-20: Day X (1+ completed) preserved on Day X+1
-- Day X = 2026-03-09 (Mon, has split), Day X+1 = 2026-03-10
------------------------------------------------------------
SELECT coachbyte.ensure_daily_plan('2026-03-09'::date);

-- Insert a completed set
DO $$
DECLARE v_uid UUID; v_plan UUID; v_squat UUID;
BEGIN
  v_uid := tests.get_supabase_uid('edp_user');
  SELECT exercise_id INTO v_squat FROM _ex WHERE ex_name = 'squat';
  SELECT plan_id INTO v_plan FROM coachbyte.daily_plans
    WHERE user_id = v_uid AND plan_date = '2026-03-09';

  INSERT INTO coachbyte.completed_sets (plan_id, user_id, exercise_id, actual_reps, actual_load, logical_date)
  VALUES (v_plan, v_uid, v_squat, 5, 240, '2026-03-09');
END $$;

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.daily_plans
   WHERE user_id = tests.get_supabase_uid('edp_user') AND plan_date = '2026-03-09'),
  1,
  'Day X plan exists with completed set'
);

SELECT coachbyte.ensure_daily_plan('2026-03-10'::date);

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.daily_plans
   WHERE user_id = tests.get_supabase_uid('edp_user') AND plan_date = '2026-03-09'),
  1,
  'Day X plan preserved (had completed sets)'
);

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.daily_plans
   WHERE user_id = tests.get_supabase_uid('edp_user') AND plan_date = '2026-03-10'),
  1,
  'Day X+1 plan created'
);

------------------------------------------------------------
-- TEST 21-23: Percentage with no PR → NULL target_load
------------------------------------------------------------
DO $$
DECLARE v_bench UUID; v_uid UUID;
BEGIN
  SELECT exercise_id INTO v_bench FROM _ex WHERE ex_name = 'bench press';
  v_uid := tests.get_supabase_uid('edp_user');

  INSERT INTO coachbyte.splits (user_id, weekday, template_sets) VALUES (
    v_uid, 3, -- Wednesday
    jsonb_build_array(
      jsonb_build_object('exercise_id', v_bench, 'target_reps', 5, 'target_load_percentage', 75, 'rest_seconds', 120)
    )
  );
END $$;

-- 2026-03-11 is a Wednesday. Bench has no completed_sets → no e1RM
SELECT coachbyte.ensure_daily_plan('2026-03-11'::date);

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.planned_sets ps
   JOIN coachbyte.daily_plans dp ON dp.plan_id = ps.plan_id
   WHERE dp.plan_date = '2026-03-11'
     AND dp.user_id = tests.get_supabase_uid('edp_user')),
  1,
  '1 planned_set for Wednesday bench % plan'
);

SELECT ok(
  (SELECT target_load IS NULL FROM coachbyte.planned_sets ps
   JOIN coachbyte.daily_plans dp ON dp.plan_id = ps.plan_id
   WHERE dp.plan_date = '2026-03-11'
     AND dp.user_id = tests.get_supabase_uid('edp_user')
   LIMIT 1),
  'Bench target_load is NULL (no PR history for percentage resolution)'
);

SELECT is(
  (SELECT target_load_percentage FROM coachbyte.planned_sets ps
   JOIN coachbyte.daily_plans dp ON dp.plan_id = ps.plan_id
   WHERE dp.plan_date = '2026-03-11'
     AND dp.user_id = tests.get_supabase_uid('edp_user')
   LIMIT 1),
  75::numeric,
  'target_load_percentage stored as 75 even with NULL resolved load'
);

------------------------------------------------------------
-- TEST 24: Return value has plan_id key
------------------------------------------------------------
SELECT ok(
  (SELECT coachbyte.ensure_daily_plan('2026-03-02'::date) ? 'plan_id'),
  'Return JSONB contains plan_id key'
);

------------------------------------------------------------
-- TEST 25-26: rest_seconds copied from template
------------------------------------------------------------
SELECT is(
  (SELECT count(*)::integer FROM coachbyte.planned_sets ps
   JOIN coachbyte.daily_plans dp ON dp.plan_id = ps.plan_id
   WHERE dp.plan_date = '2026-03-02'
     AND dp.user_id = tests.get_supabase_uid('edp_user')
     AND ps.rest_seconds = 180),
  6,
  'All 6 planned_sets have rest_seconds = 180'
);

SELECT is(
  (SELECT rest_seconds FROM coachbyte.planned_sets ps
   JOIN coachbyte.daily_plans dp ON dp.plan_id = ps.plan_id
   WHERE dp.plan_date = '2026-03-11'
     AND dp.user_id = tests.get_supabase_uid('edp_user')
   LIMIT 1),
  120,
  'Wednesday bench planned_set has rest_seconds = 120'
);

------------------------------------------------------------
-- TEST 27-28: RLS isolation
------------------------------------------------------------
SELECT tests.create_supabase_user('edp_other');
SELECT tests.authenticate_as('edp_other');
SELECT hub.activate_app('coachbyte');

SELECT coachbyte.ensure_daily_plan('2026-03-02'::date);

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.daily_plans WHERE plan_date = '2026-03-02'),
  1,
  'Second user sees only their own Monday plan (RLS)'
);

SELECT tests.authenticate_as('edp_user');
SELECT is(
  (SELECT count(*)::integer FROM coachbyte.daily_plans WHERE plan_date = '2026-03-02'),
  1,
  'First user still sees only their own Monday plan (RLS)'
);

------------------------------------------------------------
-- TEST 28-29: 0-rep completed sets excluded from PR calculation
------------------------------------------------------------
-- Seed a 0-rep completed set with a high load for Squat.
-- If included, Epley would give 500*(1+0/30) = 500, 80% = 400, rounded = 400.
-- With the 0-rep excluded, the existing PR (275 x 3 = 302.5) should still
-- resolve to 80% = 242, rounded to 240.
SELECT tests.authenticate_as('edp_user');

DO $$
DECLARE v_squat UUID; v_uid UUID; v_plan UUID;
BEGIN
  SELECT exercise_id INTO v_squat FROM _ex WHERE ex_name = 'squat';
  v_uid := tests.get_supabase_uid('edp_user');

  -- Use a past plan for the 0-rep set
  INSERT INTO coachbyte.daily_plans (user_id, plan_date, logical_date)
  VALUES (v_uid, '2026-01-02', '2026-01-02')
  RETURNING plan_id INTO v_plan;

  INSERT INTO coachbyte.completed_sets (plan_id, user_id, exercise_id, actual_reps, actual_load, logical_date)
  VALUES (v_plan, v_uid, v_squat, 0, 500, '2026-01-02');
END $$;

-- Generate a plan for a new Monday that hasn't been bootstrapped yet
-- 2026-03-16 is a Monday
SELECT coachbyte.ensure_daily_plan('2026-03-16'::date);

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.planned_sets ps
   JOIN coachbyte.daily_plans dp ON dp.plan_id = ps.plan_id
   WHERE dp.plan_date = '2026-03-16'
     AND dp.user_id = tests.get_supabase_uid('edp_user')
     AND ps.exercise_id = (SELECT exercise_id FROM _ex WHERE ex_name = 'squat')),
  3,
  '3 Squat planned_sets created for 2026-03-16'
);

SELECT is(
  (SELECT DISTINCT target_load FROM coachbyte.planned_sets ps
   JOIN coachbyte.daily_plans dp ON dp.plan_id = ps.plan_id
   WHERE dp.plan_date = '2026-03-16'
     AND dp.user_id = tests.get_supabase_uid('edp_user')
     AND ps.exercise_id = (SELECT exercise_id FROM _ex WHERE ex_name = 'squat')),
  240::numeric,
  'Squat load is 240 (0-rep set at 500lb excluded from PR calculation)'
);

-- Cleanup
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('edp_user');
SELECT tests.delete_supabase_user('edp_other');

SELECT * FROM finish();
ROLLBACK;
