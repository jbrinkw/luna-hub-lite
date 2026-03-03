BEGIN;
SELECT plan(9);

-- Setup: create two users
SELECT tests.create_supabase_user('tool_owner');
SELECT tests.create_supabase_user('tool_intruder');

-- Authenticate as tool_owner
SELECT tests.authenticate_as('tool_owner');

-- Test 1: User can INSERT own tool_config
SELECT lives_ok(
  $$ INSERT INTO hub.user_tool_config (user_id, tool_name, enabled)
     VALUES (tests.get_supabase_uid('tool_owner'), 'COACHBYTE_LOG_SET', true) $$,
  'User can insert own tool_config'
);

-- Test 2: User can SELECT own tool_config
SELECT is(
  (SELECT count(*)::integer FROM hub.user_tool_config WHERE tool_name = 'COACHBYTE_LOG_SET'),
  1,
  'User can read own tool_config'
);

-- Test 3: User can UPDATE own tool_config
UPDATE hub.user_tool_config SET enabled = false WHERE tool_name = 'COACHBYTE_LOG_SET';
SELECT is(
  (SELECT enabled FROM hub.user_tool_config WHERE tool_name = 'COACHBYTE_LOG_SET'),
  false,
  'User can update own tool_config'
);

-- Test 4: User B cannot SELECT User A tool_config
SELECT tests.authenticate_as('tool_intruder');
SELECT is(
  (SELECT count(*)::integer FROM hub.user_tool_config),
  0,
  'User B cannot see User A tool_config'
);

-- Test 5: User B cannot INSERT with User A user_id
SELECT throws_ok(
  $$ INSERT INTO hub.user_tool_config (user_id, tool_name, enabled)
     VALUES (tests.get_supabase_uid('tool_owner'), 'CHEFBYTE_SCAN_BARCODE', true) $$,
  '42501',
  NULL,
  'User B cannot insert tool_config for User A'
);

-- Test 6: User B cannot UPDATE User A tool_config
UPDATE hub.user_tool_config SET enabled = true
  WHERE user_id = tests.get_supabase_uid('tool_owner');
SELECT tests.authenticate_as('tool_owner');
SELECT is(
  (SELECT enabled FROM hub.user_tool_config WHERE tool_name = 'COACHBYTE_LOG_SET'),
  false,
  'User B cannot update User A tool_config'
);

-- Test 7: User B cannot DELETE User A tool_config
SELECT tests.authenticate_as('tool_intruder');
DELETE FROM hub.user_tool_config
  WHERE user_id = tests.get_supabase_uid('tool_owner');
SELECT tests.authenticate_as('tool_owner');
SELECT is(
  (SELECT count(*)::integer FROM hub.user_tool_config
    WHERE user_id = tests.get_supabase_uid('tool_owner') AND tool_name = 'COACHBYTE_LOG_SET'),
  1,
  'User B cannot delete User A tool_config'
);

-- Test 8: User can DELETE own tool_config
DELETE FROM hub.user_tool_config WHERE tool_name = 'COACHBYTE_LOG_SET';
SELECT is(
  (SELECT count(*)::integer FROM hub.user_tool_config
    WHERE user_id = tests.get_supabase_uid('tool_owner')),
  0,
  'User can delete own tool_config'
);

-- Test 9: Anon cannot access tool_config
SELECT tests.clear_authentication();
SELECT throws_ok(
  $$ SELECT * FROM hub.user_tool_config $$,
  '42501',
  NULL,
  'Anon cannot access tool_config'
);

-- Cleanup
SELECT tests.authenticate_as('tool_owner');
SELECT tests.delete_supabase_user('tool_owner');
SELECT tests.delete_supabase_user('tool_intruder');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
