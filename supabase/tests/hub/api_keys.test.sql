BEGIN;
SELECT plan(11);

-- Setup: create two test users
SELECT tests.create_supabase_user('key_owner', 'keyowner@test.com');
SELECT tests.create_supabase_user('key_other', 'keyother@test.com');

-- Test 1: Insert API key for user -> row created
SELECT tests.authenticate_as('key_owner');

INSERT INTO hub.api_keys (user_id, api_key_hash, label)
VALUES (tests.get_supabase_uid('key_owner'), 'hash_abc123', 'My Key 1');

SELECT is(
  (SELECT count(*)::integer FROM hub.api_keys WHERE user_id = tests.get_supabase_uid('key_owner')),
  1,
  'Insert API key -> row created'
);

-- Test 2: Query active keys (WHERE revoked_at IS NULL) -> returns the key
SELECT is(
  (SELECT count(*)::integer FROM hub.api_keys
   WHERE user_id = tests.get_supabase_uid('key_owner') AND revoked_at IS NULL),
  1,
  'Active keys query returns the key'
);

-- Test 3: Revoke key -> excluded from active query
UPDATE hub.api_keys SET revoked_at = now()
WHERE user_id = tests.get_supabase_uid('key_owner') AND api_key_hash = 'hash_abc123';

SELECT is(
  (SELECT count(*)::integer FROM hub.api_keys
   WHERE user_id = tests.get_supabase_uid('key_owner') AND revoked_at IS NULL),
  0,
  'Revoked key excluded from active query'
);

-- Test 4: Insert multiple keys -> all returned in active query
INSERT INTO hub.api_keys (user_id, api_key_hash, label)
VALUES
  (tests.get_supabase_uid('key_owner'), 'hash_def456', 'Key 2'),
  (tests.get_supabase_uid('key_owner'), 'hash_ghi789', 'Key 3');

SELECT is(
  (SELECT count(*)::integer FROM hub.api_keys
   WHERE user_id = tests.get_supabase_uid('key_owner') AND revoked_at IS NULL),
  2,
  'Multiple active keys returned'
);

-- Test 5: Revoke one of multiple -> only revoked one excluded
UPDATE hub.api_keys SET revoked_at = now()
WHERE user_id = tests.get_supabase_uid('key_owner') AND api_key_hash = 'hash_def456';

SELECT is(
  (SELECT count(*)::integer FROM hub.api_keys
   WHERE user_id = tests.get_supabase_uid('key_owner') AND revoked_at IS NULL),
  1,
  'After revoking one, only one active key remains'
);

-- Test 6: RLS - User B cannot see User A's keys
SELECT tests.authenticate_as('key_other');

SELECT is(
  (SELECT count(*)::integer FROM hub.api_keys),
  0,
  'User B cannot see User A''s keys'
);

-- Test 7: User A can INSERT with own user_id
SELECT tests.authenticate_as('key_owner');

INSERT INTO hub.api_keys (user_id, api_key_hash, label)
VALUES (tests.get_supabase_uid('key_owner'), 'hash_jkl012', 'Key 4');

SELECT is(
  (SELECT count(*)::integer FROM hub.api_keys
   WHERE user_id = tests.get_supabase_uid('key_owner') AND api_key_hash = 'hash_jkl012'),
  1,
  'User A can INSERT api_key with own user_id'
);

-- Test 8: User B cannot INSERT with User A's user_id
SELECT tests.authenticate_as('key_other');

SELECT throws_ok(
  format(
    'INSERT INTO hub.api_keys (user_id, api_key_hash, label) VALUES (%L, ''hash_fake'', ''Fake'')',
    tests.get_supabase_uid('key_owner')
  ),
  '42501',
  NULL,
  'User B cannot INSERT api_key with User A''s user_id'
);

-- Test 9: User B cannot UPDATE (revoke) User A's keys
SELECT tests.authenticate_as('key_other');
UPDATE hub.api_keys SET revoked_at = now()
WHERE user_id = tests.get_supabase_uid('key_owner');

SELECT tests.authenticate_as('key_owner');
SELECT is(
  (SELECT count(*)::integer FROM hub.api_keys
   WHERE user_id = tests.get_supabase_uid('key_owner') AND revoked_at IS NULL),
  2,
  'User B cannot revoke User A''s api_keys'
);

-- Test 10: User A can DELETE own key
SELECT tests.authenticate_as('key_owner');

DELETE FROM hub.api_keys WHERE api_key_hash = 'hash_jkl012';

SELECT is(
  (SELECT count(*)::integer FROM hub.api_keys WHERE api_key_hash = 'hash_jkl012'),
  0,
  'User A can DELETE own api_key'
);

-- Test 11: User B cannot DELETE User A's keys
SELECT tests.authenticate_as('key_other');

DELETE FROM hub.api_keys WHERE user_id = tests.get_supabase_uid('key_owner');

-- Verify User A's keys still exist
SELECT tests.authenticate_as('key_owner');

SELECT is(
  (SELECT count(*)::integer FROM hub.api_keys WHERE user_id = tests.get_supabase_uid('key_owner')),
  3,
  'User B cannot delete User A keys (3 remain)'
);

-- Cleanup
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('key_owner');
SELECT tests.delete_supabase_user('key_other');

SELECT * FROM finish();
ROLLBACK;
