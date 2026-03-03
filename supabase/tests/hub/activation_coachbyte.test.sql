BEGIN;
SELECT plan(14);

-- Setup: create user and activate CoachByte
SELECT tests.create_supabase_user('cb_activator');
SELECT tests.authenticate_as('cb_activator');

------------------------------------------------------------
-- Activation
------------------------------------------------------------

-- Test 1: Activate CoachByte succeeds
SELECT lives_ok(
  $$ SELECT hub.activate_app('coachbyte') $$,
  'Activate CoachByte succeeds'
);

-- Test 2: app_activations row exists
SELECT is(
  (SELECT count(*)::integer FROM hub.app_activations
    WHERE user_id = tests.get_supabase_uid('cb_activator') AND app_name = 'coachbyte'),
  1,
  'CoachByte activation row created'
);

-- Test 3: user_settings seeded with defaults
SELECT is(
  (SELECT default_rest_seconds FROM coachbyte.user_settings
    WHERE user_id = tests.get_supabase_uid('cb_activator')),
  90,
  'user_settings default_rest_seconds = 90'
);

SELECT is(
  (SELECT bar_weight_lbs FROM coachbyte.user_settings
    WHERE user_id = tests.get_supabase_uid('cb_activator')),
  45::numeric,
  'user_settings bar_weight_lbs = 45'
);

-- Test 4 (implied): Verify available_plates default
SELECT is(
  (SELECT available_plates FROM coachbyte.user_settings
    WHERE user_id = tests.get_supabase_uid('cb_activator')),
  '[45,35,25,10,5,2.5]'::jsonb,
  'user_settings available_plates default correct'
);

-- Test 5: Global exercises accessible
SELECT ok(
  (SELECT count(*)::integer FROM coachbyte.exercises WHERE user_id IS NULL) >= 20,
  'Global exercises accessible after activation'
);

------------------------------------------------------------
-- Seed some CoachByte data to verify cascade on deactivation
------------------------------------------------------------

-- Insert a split
INSERT INTO coachbyte.splits (user_id, weekday, template_sets)
VALUES (tests.get_supabase_uid('cb_activator'), 1, '[]'::jsonb);

-- Insert a daily plan
INSERT INTO coachbyte.daily_plans (user_id, plan_date, logical_date)
VALUES (tests.get_supabase_uid('cb_activator'), '2026-03-02', '2026-03-02');

-- Insert a timer
INSERT INTO coachbyte.timers (user_id, state, duration_seconds, end_time)
VALUES (tests.get_supabase_uid('cb_activator'), 'running', 90, now() + interval '90 seconds');

------------------------------------------------------------
-- Deactivation
------------------------------------------------------------

-- Test 6: Deactivate CoachByte succeeds
SELECT lives_ok(
  $$ SELECT hub.deactivate_app('coachbyte') $$,
  'Deactivate CoachByte succeeds'
);

-- Test 7: All CoachByte user data deleted
SELECT is(
  (SELECT count(*)::integer FROM coachbyte.user_settings
    WHERE user_id = tests.get_supabase_uid('cb_activator')),
  0,
  'user_settings deleted after deactivation'
);

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.splits
    WHERE user_id = tests.get_supabase_uid('cb_activator')),
  0,
  'splits deleted after deactivation'
);

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.daily_plans
    WHERE user_id = tests.get_supabase_uid('cb_activator')),
  0,
  'daily_plans deleted after deactivation'
);

-- Test 9: Timers deleted after deactivation
SELECT is(
  (SELECT count(*)::integer FROM coachbyte.timers
    WHERE user_id = tests.get_supabase_uid('cb_activator')),
  0,
  'timers deleted after deactivation'
);

------------------------------------------------------------
-- Reactivation
------------------------------------------------------------

-- Test 10: Reactivate CoachByte → clean slate
SELECT lives_ok(
  $$ SELECT hub.activate_app('coachbyte') $$,
  'Reactivate CoachByte succeeds'
);

-- Test 11: Reactivation re-seeds user_settings with defaults
SELECT is(
  (SELECT default_rest_seconds FROM coachbyte.user_settings
    WHERE user_id = tests.get_supabase_uid('cb_activator')),
  90,
  'Reactivation re-seeds user_settings default_rest_seconds = 90'
);

SELECT is(
  (SELECT bar_weight_lbs FROM coachbyte.user_settings
    WHERE user_id = tests.get_supabase_uid('cb_activator')),
  45::numeric,
  'Reactivation re-seeds user_settings bar_weight_lbs = 45'
);

-- Cleanup
SELECT tests.delete_supabase_user('cb_activator');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
