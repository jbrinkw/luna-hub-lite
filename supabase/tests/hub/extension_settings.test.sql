BEGIN;
SELECT plan(8);

-- Setup
SELECT tests.create_supabase_user('ext_owner');
SELECT tests.create_supabase_user('ext_intruder');

SELECT tests.authenticate_as('ext_owner');

-- Test 1: User can INSERT own extension_settings
SELECT lives_ok(
  $$ INSERT INTO hub.extension_settings (user_id, extension_name, enabled, credentials_encrypted)
     VALUES (tests.get_supabase_uid('ext_owner'), 'obsidian', true, '{"vault_path":"/notes"}') $$,
  'User can insert own extension_settings'
);

-- Test 2: User can SELECT own extension_settings
SELECT is(
  (SELECT count(*)::integer FROM hub.extension_settings WHERE extension_name = 'obsidian'),
  1,
  'User can read own extension_settings'
);

-- Test 3: User can UPDATE own extension_settings
UPDATE hub.extension_settings SET enabled = false WHERE extension_name = 'obsidian';
SELECT is(
  (SELECT enabled FROM hub.extension_settings WHERE extension_name = 'obsidian'),
  false,
  'User can update own extension_settings'
);

-- Test 4: User B cannot SELECT User A extension_settings
SELECT tests.authenticate_as('ext_intruder');
SELECT is(
  (SELECT count(*)::integer FROM hub.extension_settings),
  0,
  'User B cannot see User A extension_settings'
);

-- Test 5: User B cannot INSERT with User A user_id
SELECT throws_ok(
  $$ INSERT INTO hub.extension_settings (user_id, extension_name, enabled)
     VALUES (tests.get_supabase_uid('ext_owner'), 'todoist', true) $$,
  '42501',
  NULL,
  'User B cannot insert extension_settings for User A'
);

-- Test 6: User B cannot UPDATE User A extension_settings
UPDATE hub.extension_settings SET enabled = true
  WHERE user_id = tests.get_supabase_uid('ext_owner');
SELECT tests.authenticate_as('ext_owner');
SELECT is(
  (SELECT enabled FROM hub.extension_settings WHERE extension_name = 'obsidian'),
  false,
  'User B cannot update User A extension_settings'
);

-- Test 7: User can DELETE own extension_settings
DELETE FROM hub.extension_settings WHERE extension_name = 'obsidian';
SELECT is(
  (SELECT count(*)::integer FROM hub.extension_settings
    WHERE user_id = tests.get_supabase_uid('ext_owner')),
  0,
  'User can delete own extension_settings'
);

-- Test 8: Anon cannot access extension_settings
SELECT tests.clear_authentication();
SELECT throws_ok(
  $$ SELECT * FROM hub.extension_settings $$,
  '42501',
  NULL,
  'Anon cannot access extension_settings'
);

-- Cleanup
SELECT tests.authenticate_as('ext_owner');
SELECT tests.delete_supabase_user('ext_owner');
SELECT tests.delete_supabase_user('ext_intruder');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
