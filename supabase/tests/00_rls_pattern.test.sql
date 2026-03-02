-- RLS Pattern Test: Verify standard RLS isolation on hub.profiles
--
-- Tests the pattern: (select auth.uid()) = user_id TO authenticated
-- This pattern should work across all user-data tables in the system.

BEGIN;

SELECT plan(6);

-- Create test users via Supabase Auth
-- These will auto-create profiles via the handle_new_user trigger
SELECT tests.create_supabase_user('user_a', 'usera@test.com', '555-0001');
SELECT tests.create_supabase_user('user_b', 'userb@test.com', '555-0002');

-- Get user IDs
SELECT tests.get_supabase_uid('user_a') AS user_a_id \gset
SELECT tests.get_supabase_uid('user_b') AS user_b_id \gset

-- Test 1: User A can SELECT their own profile
SELECT tests.authenticate_as('user_a');
SELECT ok(
  EXISTS (SELECT 1 FROM hub.profiles WHERE user_id = :'user_a_id'),
  'User A can SELECT their own profile'
);

-- Test 2: User B cannot SELECT User A's profile
SELECT tests.authenticate_as('user_b');
SELECT is(
  (SELECT count(*) FROM hub.profiles WHERE user_id = :'user_a_id')::int,
  0,
  'User B cannot SELECT User A''s profile'
);

-- Test 3: User A can UPDATE their own profile
-- Use Asia/Tokyo (not the default America/New_York) to prove UPDATE actually took effect
SELECT tests.authenticate_as('user_a');
UPDATE hub.profiles SET timezone = 'Asia/Tokyo' WHERE user_id = :'user_a_id';
SELECT is(
  (SELECT timezone FROM hub.profiles WHERE user_id = :'user_a_id'),
  'Asia/Tokyo',
  'User A can UPDATE their own profile'
);

-- Test 4: User B cannot UPDATE User A's profile
-- Attempt as User B, then verify as User A that value is unchanged
SELECT tests.authenticate_as('user_b');
UPDATE hub.profiles SET timezone = 'Europe/London' WHERE user_id = :'user_a_id';
SELECT tests.authenticate_as('user_a');
SELECT is(
  (SELECT timezone FROM hub.profiles WHERE user_id = :'user_a_id'),
  'Asia/Tokyo',
  'User B cannot UPDATE User A''s profile (value unchanged)'
);

-- Test 5: Anon role cannot SELECT profiles (permission denied)
SELECT tests.clear_authentication();
SELECT throws_ok(
  'SELECT count(*) FROM hub.profiles',
  '42501',
  NULL,
  'Anon role cannot SELECT profiles (permission denied)'
);

-- Test 6: Anon role cannot UPDATE profiles (permission denied)
SELECT throws_ok(
  'UPDATE hub.profiles SET timezone = ''UTC'' WHERE user_id = ''' || :'user_a_id' || '''',
  '42501',
  NULL,
  'Anon role cannot UPDATE profiles (permission denied)'
);

-- Cleanup
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('user_a');
SELECT tests.delete_supabase_user('user_b');

SELECT * FROM finish();
ROLLBACK;
