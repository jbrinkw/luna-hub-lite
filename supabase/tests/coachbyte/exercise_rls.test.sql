BEGIN;
SELECT plan(12);

-- Setup: create two users
SELECT tests.create_supabase_user('ex_owner');
SELECT tests.create_supabase_user('ex_intruder');

------------------------------------------------------------
-- User A: global exercise access
------------------------------------------------------------
SELECT tests.authenticate_as('ex_owner');

-- Test 1: User A can SELECT global exercises
SELECT ok(
  (SELECT count(*)::integer FROM coachbyte.exercises WHERE user_id IS NULL) >= 20,
  'User A can read global exercises (at least 20 seeded)'
);

------------------------------------------------------------
-- User A: own custom exercises
------------------------------------------------------------

-- Test 2: User A can INSERT own exercise
SELECT lives_ok(
  $$ INSERT INTO coachbyte.exercises (user_id, name)
     VALUES (tests.get_supabase_uid('ex_owner'), 'Custom Press') $$,
  'User A can insert own exercise'
);

-- Test 3: Verify the insert actually created a row
SELECT is(
  (SELECT count(*)::integer FROM coachbyte.exercises
    WHERE user_id = tests.get_supabase_uid('ex_owner') AND name = 'Custom Press'),
  1,
  'Custom exercise row exists after insert'
);

-- Test 4: User A can UPDATE own exercise
UPDATE coachbyte.exercises SET name = 'Custom Press V2'
  WHERE user_id = tests.get_supabase_uid('ex_owner') AND name = 'Custom Press';
SELECT is(
  (SELECT name FROM coachbyte.exercises
    WHERE user_id = tests.get_supabase_uid('ex_owner')),
  'Custom Press V2',
  'User A can update own exercise'
);

------------------------------------------------------------
-- User B: cross-user isolation
------------------------------------------------------------
SELECT tests.authenticate_as('ex_intruder');

-- Test 5: User B can still read global exercises
SELECT ok(
  (SELECT count(*)::integer FROM coachbyte.exercises WHERE user_id IS NULL) >= 20,
  'User B can also read global exercises'
);

-- Test 6: User B cannot SELECT User A custom exercises
SELECT is(
  (SELECT count(*)::integer FROM coachbyte.exercises
    WHERE user_id = tests.get_supabase_uid('ex_owner')),
  0,
  'User B cannot see User A custom exercises'
);

------------------------------------------------------------
-- Globals: no writes by authenticated users
------------------------------------------------------------

-- Test 7: User cannot INSERT exercise with user_id = NULL
SELECT throws_ok(
  $$ INSERT INTO coachbyte.exercises (user_id, name) VALUES (NULL, 'Hack Squat') $$,
  '42501',
  NULL,
  'Authenticated user cannot insert global exercise (user_id = NULL)'
);

-- Test 8: User cannot UPDATE global exercises
SELECT tests.authenticate_as('ex_owner');
UPDATE coachbyte.exercises SET name = 'HACKED' WHERE user_id IS NULL AND name = 'Squat';
SELECT is(
  (SELECT name FROM coachbyte.exercises WHERE user_id IS NULL AND LOWER(name) = 'squat'),
  'Squat',
  'User cannot update global exercises'
);

-- Test 9: User cannot DELETE global exercises
DELETE FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Squat';
SELECT ok(
  (SELECT count(*)::integer FROM coachbyte.exercises WHERE user_id IS NULL AND LOWER(name) = 'squat') = 1,
  'User cannot delete global exercises'
);

------------------------------------------------------------
-- Uniqueness: case-insensitive duplicate rejected
------------------------------------------------------------

-- Test 10: Duplicate name (case-insensitive) for same user rejected
SELECT throws_ok(
  $$ INSERT INTO coachbyte.exercises (user_id, name)
     VALUES (tests.get_supabase_uid('ex_owner'), 'custom press v2') $$,
  '23505',
  NULL,
  'Case-insensitive duplicate name rejected for same user'
);

------------------------------------------------------------
-- User A: delete own exercise
------------------------------------------------------------

-- Test 11: User A can DELETE own exercise
DELETE FROM coachbyte.exercises
  WHERE user_id = tests.get_supabase_uid('ex_owner') AND name = 'Custom Press V2';
SELECT is(
  (SELECT count(*)::integer FROM coachbyte.exercises
    WHERE user_id = tests.get_supabase_uid('ex_owner')),
  0,
  'User A can delete own exercise'
);

------------------------------------------------------------
-- Anon: no access
------------------------------------------------------------
SELECT tests.clear_authentication();

-- Test 12: Anon cannot access exercises
SELECT throws_ok(
  $$ SELECT * FROM coachbyte.exercises $$,
  '42501',
  NULL,
  'Anon cannot access exercises'
);

------------------------------------------------------------
-- Cleanup
------------------------------------------------------------
SELECT tests.authenticate_as('ex_owner');
SELECT tests.delete_supabase_user('ex_owner');
SELECT tests.delete_supabase_user('ex_intruder');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
