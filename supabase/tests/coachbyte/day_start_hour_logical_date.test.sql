-- Audit item #35: day_start_hour → logical_date reassignment semantics.
--
-- ``private.get_logical_date()`` is already unit-tested for DST + edge
-- hours in ``hub/logical_date.test.sql``. This suite extends that
-- coverage to the write-time contract on ``coachbyte.completed_sets``:
--
--   1. When a user changes ``hub.profiles.day_start_hour`` and a NEW
--      daily_plan is created, its ``logical_date`` reflects the NEW
--      day_start_hour (via ``ensure_daily_plan`` → ``get_logical_date``).
--   2. ``completed_sets.logical_date`` is stamped at insert time from
--      the owning ``daily_plans.logical_date`` (via
--      ``private.complete_next_set``). Subsequent day_start_hour
--      changes MUST NOT retroactively rewrite existing rows — logical
--      date is a write-time snapshot, not a derived-on-read value.
--
-- The second property prevents an entire class of UX bugs: a user who
-- tweaks their rollover hour today should not suddenly see yesterday's
-- workout re-dated into "today" in their history view.

BEGIN;
SELECT plan(12);

-- ─────────────────────────────────────────────────────────────
-- Pre-auth sanity checks (Part C, hoisted here): the get_logical_date
-- primitive is SECURITY DEFINER but not granted to authenticated, so
-- we call it directly as superuser BEFORE authenticate_as.
-- ─────────────────────────────────────────────────────────────

-- With day_start_hour=4, 2026-04-21T03:30 America/New_York → previous logical day (2026-04-20).
SELECT is(
  private.get_logical_date(
    '2026-04-21 03:30:00-04'::timestamptz,
    'America/New_York',
    4
  ),
  '2026-04-20'::date,
  'get_logical_date(3:30am, dsh=4) = 2026-04-20 (before rollover)'
);

-- Now same timestamp, but day_start_hour=0 (midnight rollover) → 2026-04-21.
SELECT is(
  private.get_logical_date(
    '2026-04-21 03:30:00-04'::timestamptz,
    'America/New_York',
    0
  ),
  '2026-04-21'::date,
  'get_logical_date(3:30am, dsh=0) = 2026-04-21 (different dsh = different date)'
);

-- ─────────────────────────────────────────────────────────────
-- Setup: one user, day_start_hour = 6 initially.
-- ─────────────────────────────────────────────────────────────

SELECT tests.create_supabase_user('dsh_user');
SELECT tests.authenticate_as('dsh_user');
SELECT hub.activate_app('coachbyte');

-- Pin timezone so the test is deterministic regardless of local tz.
UPDATE hub.profiles
   SET timezone = 'America/New_York',
       day_start_hour = 6
 WHERE user_id = tests.get_supabase_uid('dsh_user');

-- ─────────────────────────────────────────────────────────────
-- Part A — WRITE-TIME CORRECTNESS
-- When day_start_hour = 6, a plan for 2026-04-21 lands with
-- logical_date = 2026-04-21 (because get_logical_date is called at
-- 12:00 local which is >= 6am).
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  $$SELECT coachbyte.ensure_daily_plan('2026-04-21'::date)$$,
  'ensure_daily_plan(2026-04-21) with day_start_hour=6 succeeds'
);

SELECT is(
  (SELECT logical_date
     FROM coachbyte.daily_plans
    WHERE user_id = tests.get_supabase_uid('dsh_user')
      AND plan_date = '2026-04-21'),
  '2026-04-21'::date,
  'daily_plan stamped with logical_date=2026-04-21 under day_start_hour=6'
);

-- Grab global Squat exercise + insert a planned_set so complete_next_set
-- has a target to complete.
DO $$
DECLARE
  v_plan_id UUID;
  v_uid UUID := tests.get_supabase_uid('dsh_user');
  v_squat UUID;
BEGIN
  SELECT plan_id INTO v_plan_id
    FROM coachbyte.daily_plans
   WHERE user_id = v_uid AND plan_date = '2026-04-21';

  SELECT exercise_id INTO v_squat
    FROM coachbyte.exercises
   WHERE user_id IS NULL AND name = 'Squat' LIMIT 1;

  INSERT INTO coachbyte.planned_sets
    (planned_set_id, plan_id, user_id, exercise_id, "order",
     target_reps, target_load, rest_seconds)
  VALUES (
    '10000000-0000-0000-0000-000000000001',
    v_plan_id, v_uid, v_squat, 1, 5, 135.0, 90
  );
END $$;

-- Complete the set → completed_sets row inherits plan's logical_date.
SELECT lives_ok(
  $$SELECT coachbyte.complete_next_set(
      (SELECT plan_id FROM coachbyte.daily_plans
         WHERE user_id = tests.get_supabase_uid('dsh_user')
           AND plan_date = '2026-04-21'),
      5, 135.0)$$,
  'complete_next_set succeeds for day_start_hour=6 plan'
);

SELECT is(
  (SELECT logical_date
     FROM coachbyte.completed_sets
    WHERE user_id = tests.get_supabase_uid('dsh_user')
    ORDER BY completed_at DESC LIMIT 1),
  '2026-04-21'::date,
  'completed_sets.logical_date stamped = 2026-04-21 at insert (inherits from plan)'
);

-- ─────────────────────────────────────────────────────────────
-- Part B — REASSIGNMENT OF FUTURE INSERTS
-- Change day_start_hour to 4 (earlier rollover). A NEW plan created
-- for 2026-04-22 picks up the new hour; the old 2026-04-21 plan does NOT
-- get re-stamped.
-- ─────────────────────────────────────────────────────────────

UPDATE hub.profiles
   SET day_start_hour = 4
 WHERE user_id = tests.get_supabase_uid('dsh_user');

-- EXISTING plan row MUST NOT mutate on profile change — there is no
-- trigger on hub.profiles that touches daily_plans, and logical_date
-- is NOT a GENERATED column. Assert it's still 2026-04-21.
SELECT is(
  (SELECT logical_date
     FROM coachbyte.daily_plans
    WHERE user_id = tests.get_supabase_uid('dsh_user')
      AND plan_date = '2026-04-21'),
  '2026-04-21'::date,
  'existing daily_plan.logical_date UNCHANGED after day_start_hour flipped 6→4'
);

-- Same check on the completed_sets row: it snapshotted 2026-04-21 at
-- insert time and must still be 2026-04-21.
SELECT is(
  (SELECT logical_date
     FROM coachbyte.completed_sets
    WHERE user_id = tests.get_supabase_uid('dsh_user')
    ORDER BY completed_at DESC LIMIT 1),
  '2026-04-21'::date,
  'existing completed_sets.logical_date UNCHANGED after day_start_hour change (write-time snapshot)'
);

-- NEW plan for the next day uses the NEW day_start_hour. The plan_date
-- 2026-04-22 + 12:00 local is >= 4am either way, so logical_date
-- evaluates to 2026-04-22 — but the key check is that the function was
-- called with day_start_hour=4, not 6.
SELECT lives_ok(
  $$SELECT coachbyte.ensure_daily_plan('2026-04-22'::date)$$,
  'ensure_daily_plan(2026-04-22) after day_start_hour→4 succeeds'
);

SELECT is(
  (SELECT logical_date
     FROM coachbyte.daily_plans
    WHERE user_id = tests.get_supabase_uid('dsh_user')
      AND plan_date = '2026-04-22'),
  '2026-04-22'::date,
  'new daily_plan stamped correctly after day_start_hour change'
);

-- ─────────────────────────────────────────────────────────────
-- Part D — RETROACTIVE PROTECTION via stored date
-- Flip day_start_hour a second time (4→0). Neither daily_plans NOR
-- completed_sets is recomputed. This double-flip guards the
-- "cached-on-read" implementation bug, where someone might add a view
-- that re-derives logical_date live from the profile.
-- ─────────────────────────────────────────────────────────────

UPDATE hub.profiles
   SET day_start_hour = 0
 WHERE user_id = tests.get_supabase_uid('dsh_user');

SELECT is(
  (SELECT logical_date
     FROM coachbyte.daily_plans
    WHERE user_id = tests.get_supabase_uid('dsh_user')
      AND plan_date = '2026-04-21'),
  '2026-04-21'::date,
  'second day_start_hour flip still leaves plan.logical_date alone'
);

SELECT is(
  (SELECT logical_date
     FROM coachbyte.completed_sets
    WHERE user_id = tests.get_supabase_uid('dsh_user')
    ORDER BY completed_at DESC LIMIT 1),
  '2026-04-21'::date,
  'second day_start_hour flip still leaves completed_sets.logical_date alone'
);

SELECT * FROM finish();
ROLLBACK;
