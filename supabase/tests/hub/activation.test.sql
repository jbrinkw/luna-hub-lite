BEGIN;
SELECT plan(7);

-- Setup: create two test users
SELECT tests.create_supabase_user('act_user', 'actuser@test.com');
SELECT tests.create_supabase_user('act_other', 'actother@test.com');
SELECT tests.authenticate_as('act_user');

-- Test 1: activate_app creates row
SELECT hub.activate_app('coachbyte');

SELECT is(
  (SELECT count(*)::integer FROM hub.app_activations
   WHERE user_id = tests.get_supabase_uid('act_user') AND app_name = 'coachbyte'),
  1,
  'activate_app creates app_activations row'
);

-- Test 2: deactivate_app removes row
SELECT hub.deactivate_app('coachbyte');

SELECT is(
  (SELECT count(*)::integer FROM hub.app_activations
   WHERE user_id = tests.get_supabase_uid('act_user') AND app_name = 'coachbyte'),
  0,
  'deactivate_app removes app_activations row'
);

-- Test 3: Deactivate app that's not activated -> no error
SELECT lives_ok(
  $$SELECT hub.deactivate_app('coachbyte')$$,
  'Deactivate unactivated app does not throw'
);

-- Test 4: Activate + deactivate + reactivate -> clean cycle
SELECT hub.activate_app('chefbyte');
SELECT hub.deactivate_app('chefbyte');
SELECT hub.activate_app('chefbyte');

SELECT is(
  (SELECT count(*)::integer FROM hub.app_activations
   WHERE user_id = tests.get_supabase_uid('act_user') AND app_name = 'chefbyte'),
  1,
  'Activate-deactivate-reactivate cycle works cleanly'
);

-- Test 5: Duplicate activation is idempotent (ON CONFLICT DO NOTHING)
SELECT hub.activate_app('chefbyte');

SELECT is(
  (SELECT count(*)::integer FROM hub.app_activations
   WHERE user_id = tests.get_supabase_uid('act_user') AND app_name = 'chefbyte'),
  1,
  'Duplicate activation is idempotent'
);

-- Test 6: User B cannot see User A activations
SELECT tests.authenticate_as('act_other');

SELECT is(
  (SELECT count(*)::integer FROM hub.app_activations),
  0,
  'User B cannot see User A activations'
);

-- Test 7: User B cannot deactivate User A apps (function uses auth.uid())
SELECT hub.deactivate_app('chefbyte');

SELECT tests.authenticate_as('act_user');
SELECT is(
  (SELECT count(*)::integer FROM hub.app_activations
   WHERE user_id = tests.get_supabase_uid('act_user') AND app_name = 'chefbyte'),
  1,
  'User B cannot deactivate User A apps'
);

-- Cleanup
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('act_user');
SELECT tests.delete_supabase_user('act_other');

SELECT * FROM finish();
ROLLBACK;
