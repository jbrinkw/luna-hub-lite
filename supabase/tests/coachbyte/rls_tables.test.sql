-- RLS isolation tests for CoachByte tables:
-- daily_plans, planned_sets, completed_sets, splits, user_settings
BEGIN;
SELECT plan(18);

-- Setup: two users
SELECT tests.create_supabase_user('cb_rls_a');
SELECT tests.create_supabase_user('cb_rls_b');

SELECT tests.authenticate_as('cb_rls_a');
SELECT hub.activate_app('coachbyte');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('cb_rls_b');
SELECT hub.activate_app('coachbyte');
SELECT tests.clear_authentication();

-- ═══════════════════════════════════════════════════════════════
-- USER_SETTINGS (PK = user_id, columns: default_rest_seconds, bar_weight_lbs, available_plates)
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('cb_rls_a');

-- Activation seeds user_settings, so update instead of insert
UPDATE coachbyte.user_settings SET default_rest_seconds = 120
  WHERE user_id = tests.get_supabase_uid('cb_rls_a');

SELECT ok(
  EXISTS (SELECT 1 FROM coachbyte.user_settings
    WHERE user_id = tests.get_supabase_uid('cb_rls_a')),
  'User A can SELECT own user_settings'
);

SELECT tests.authenticate_as('cb_rls_b');

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.user_settings
    WHERE user_id = tests.get_supabase_uid('cb_rls_a')),
  0,
  'User B cannot SELECT User A user_settings'
);

UPDATE coachbyte.user_settings SET default_rest_seconds = 999
  WHERE user_id = tests.get_supabase_uid('cb_rls_a');
SELECT tests.authenticate_as('cb_rls_a');
SELECT is(
  (SELECT default_rest_seconds FROM coachbyte.user_settings
    WHERE user_id = tests.get_supabase_uid('cb_rls_a')),
  120,
  'User B cannot UPDATE User A user_settings'
);

SELECT tests.authenticate_as('cb_rls_b');
DELETE FROM coachbyte.user_settings
  WHERE user_id = tests.get_supabase_uid('cb_rls_a');
SELECT tests.authenticate_as('cb_rls_a');
SELECT ok(
  EXISTS (SELECT 1 FROM coachbyte.user_settings
    WHERE user_id = tests.get_supabase_uid('cb_rls_a')),
  'User B cannot DELETE User A user_settings'
);

-- ═══════════════════════════════════════════════════════════════
-- SPLITS
-- ═══════════════════════════════════════════════════════════════

INSERT INTO coachbyte.splits (split_id, user_id, weekday, split_notes)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('cb_rls_a'),
  1, 'Push Day'
);

SELECT ok(
  EXISTS (SELECT 1 FROM coachbyte.splits
    WHERE split_id = 'a0000000-0000-0000-0000-000000000001'),
  'User A can SELECT own splits'
);

SELECT tests.authenticate_as('cb_rls_b');

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.splits
    WHERE user_id = tests.get_supabase_uid('cb_rls_a')),
  0,
  'User B cannot SELECT User A splits'
);

UPDATE coachbyte.splits SET split_notes = 'Hacked'
  WHERE split_id = 'a0000000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('cb_rls_a');
SELECT is(
  (SELECT split_notes FROM coachbyte.splits
    WHERE split_id = 'a0000000-0000-0000-0000-000000000001'),
  'Push Day',
  'User B cannot UPDATE User A splits'
);

SELECT tests.authenticate_as('cb_rls_b');
DELETE FROM coachbyte.splits
  WHERE split_id = 'a0000000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('cb_rls_a');
SELECT ok(
  EXISTS (SELECT 1 FROM coachbyte.splits
    WHERE split_id = 'a0000000-0000-0000-0000-000000000001'),
  'User B cannot DELETE User A splits'
);

-- ═══════════════════════════════════════════════════════════════
-- DAILY_PLANS
-- ═══════════════════════════════════════════════════════════════

INSERT INTO coachbyte.daily_plans (plan_id, user_id, plan_date, logical_date, summary)
VALUES (
  'a0000000-0000-0000-0000-000000000010',
  tests.get_supabase_uid('cb_rls_a'),
  '2026-03-03', '2026-03-03', 'A plan'
);

SELECT ok(
  EXISTS (SELECT 1 FROM coachbyte.daily_plans
    WHERE plan_id = 'a0000000-0000-0000-0000-000000000010'),
  'User A can SELECT own daily_plans'
);

SELECT tests.authenticate_as('cb_rls_b');

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.daily_plans
    WHERE plan_id = 'a0000000-0000-0000-0000-000000000010'),
  0,
  'User B cannot SELECT User A daily_plans'
);

UPDATE coachbyte.daily_plans SET summary = 'Hacked'
  WHERE plan_id = 'a0000000-0000-0000-0000-000000000010';
SELECT tests.authenticate_as('cb_rls_a');
SELECT is(
  (SELECT summary FROM coachbyte.daily_plans
    WHERE plan_id = 'a0000000-0000-0000-0000-000000000010'),
  'A plan',
  'User B cannot UPDATE User A daily_plans'
);

-- ═══════════════════════════════════════════════════════════════
-- PLANNED_SETS
-- ═══════════════════════════════════════════════════════════════

-- Get a global exercise for FK
SELECT exercise_id AS squat_id FROM coachbyte.exercises
  WHERE user_id IS NULL AND name = 'Squat' LIMIT 1 \gset

INSERT INTO coachbyte.planned_sets (planned_set_id, plan_id, user_id, exercise_id, "order", target_reps, target_load, rest_seconds)
VALUES (
  'a0000000-0000-0000-0000-000000000020',
  'a0000000-0000-0000-0000-000000000010',
  tests.get_supabase_uid('cb_rls_a'),
  :'squat_id', 1, 5, 100, 90
);

SELECT ok(
  EXISTS (SELECT 1 FROM coachbyte.planned_sets
    WHERE planned_set_id = 'a0000000-0000-0000-0000-000000000020'),
  'User A can SELECT own planned_sets'
);

SELECT tests.authenticate_as('cb_rls_b');

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.planned_sets
    WHERE planned_set_id = 'a0000000-0000-0000-0000-000000000020'),
  0,
  'User B cannot SELECT User A planned_sets'
);

UPDATE coachbyte.planned_sets SET target_reps = 99
  WHERE planned_set_id = 'a0000000-0000-0000-0000-000000000020';
SELECT tests.authenticate_as('cb_rls_a');
SELECT is(
  (SELECT target_reps FROM coachbyte.planned_sets
    WHERE planned_set_id = 'a0000000-0000-0000-0000-000000000020'),
  5,
  'User B cannot UPDATE User A planned_sets'
);

-- ═══════════════════════════════════════════════════════════════
-- COMPLETED_SETS
-- ═══════════════════════════════════════════════════════════════

INSERT INTO coachbyte.completed_sets (completed_set_id, plan_id, planned_set_id, user_id, exercise_id, actual_reps, actual_load, logical_date)
VALUES (
  'a0000000-0000-0000-0000-000000000030',
  'a0000000-0000-0000-0000-000000000010',
  'a0000000-0000-0000-0000-000000000020',
  tests.get_supabase_uid('cb_rls_a'),
  :'squat_id', 5, 100.0, '2026-03-03'
);

SELECT ok(
  EXISTS (SELECT 1 FROM coachbyte.completed_sets
    WHERE completed_set_id = 'a0000000-0000-0000-0000-000000000030'),
  'User A can SELECT own completed_sets'
);

SELECT tests.authenticate_as('cb_rls_b');

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.completed_sets
    WHERE completed_set_id = 'a0000000-0000-0000-0000-000000000030'),
  0,
  'User B cannot SELECT User A completed_sets'
);

UPDATE coachbyte.completed_sets SET actual_reps = 99
  WHERE completed_set_id = 'a0000000-0000-0000-0000-000000000030';
SELECT tests.authenticate_as('cb_rls_a');
SELECT is(
  (SELECT actual_reps FROM coachbyte.completed_sets
    WHERE completed_set_id = 'a0000000-0000-0000-0000-000000000030'),
  5,
  'User B cannot UPDATE User A completed_sets'
);

SELECT tests.authenticate_as('cb_rls_b');
DELETE FROM coachbyte.completed_sets
  WHERE completed_set_id = 'a0000000-0000-0000-0000-000000000030';
SELECT tests.authenticate_as('cb_rls_a');
SELECT ok(
  EXISTS (SELECT 1 FROM coachbyte.completed_sets
    WHERE completed_set_id = 'a0000000-0000-0000-0000-000000000030'),
  'User B cannot DELETE User A completed_sets'
);

-- Teardown
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('cb_rls_a');
SELECT tests.delete_supabase_user('cb_rls_b');

SELECT * FROM finish();
ROLLBACK;
