BEGIN;
SELECT plan(4);

-- Setup: create test user
SELECT tests.create_supabase_user('act_user', 'actuser@test.com');
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

-- Test 3: Deactivate app that's not activated -> no-op, no error
SELECT hub.deactivate_app('coachbyte');

SELECT is(
  (SELECT count(*)::integer FROM hub.app_activations
   WHERE user_id = tests.get_supabase_uid('act_user')),
  0,
  'Deactivate unactivated app is a no-op'
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

-- Cleanup
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('act_user');

SELECT * FROM finish();
ROLLBACK;
