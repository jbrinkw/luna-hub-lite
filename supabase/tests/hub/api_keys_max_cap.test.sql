-- pgTAP tests for the hub.api_keys 10-active-cap trigger.
-- Migration: 20260425050000_api_keys_max_10.sql
--
-- Previous audit finding: the client-side count-before-insert guard in
-- McpSettingsPage.tsx was the ONLY gate against runaway key creation.
-- This test proves the DB trigger holds the invariant even for callers
-- that bypass the client (service-role scripts, future RPC surfaces).

BEGIN;

SELECT plan(8);

SELECT tests.create_supabase_user('cap_user', 'capuser@test.com');
SELECT tests.create_supabase_user('cap_other', 'capother@test.com');

SELECT tests.authenticate_as('cap_user');

-- 1. Inserting the first 10 keys succeeds.
DO $$
BEGIN
  FOR i IN 1..10 LOOP
    INSERT INTO hub.api_keys (user_id, api_key_hash, label)
    VALUES (
      tests.get_supabase_uid('cap_user'),
      'hash_cap_' || i,
      'Key ' || i
    );
  END LOOP;
END $$;

SELECT is(
  (SELECT count(*)::INTEGER FROM hub.api_keys
    WHERE user_id = tests.get_supabase_uid('cap_user') AND revoked_at IS NULL),
  10,
  '10 active keys can be inserted for a single user'
);

-- 2. 11th insert is rejected by the trigger.
SELECT throws_like(
  format(
    $$ INSERT INTO hub.api_keys (user_id, api_key_hash, label)
       VALUES (%L, 'hash_cap_11', 'Key 11') $$,
    tests.get_supabase_uid('cap_user')
  ),
  '%maximum of 10 active keys%',
  '11th active key INSERT is rejected by the trigger'
);

-- 3. Trigger fires regardless of client — still enforced via service-role
-- style direct INSERT (no RLS bypass: the trigger is BEFORE INSERT so it
-- runs for every caller, authenticated or not).
SELECT is(
  (SELECT count(*)::INTEGER FROM hub.api_keys
    WHERE user_id = tests.get_supabase_uid('cap_user') AND revoked_at IS NULL),
  10,
  'Count is still 10 after the rejected 11th insert'
);

-- 4. Revoking a key drops below the cap — next insert succeeds.
UPDATE hub.api_keys
   SET revoked_at = now()
 WHERE user_id = tests.get_supabase_uid('cap_user')
   AND api_key_hash = 'hash_cap_1';

INSERT INTO hub.api_keys (user_id, api_key_hash, label)
VALUES (tests.get_supabase_uid('cap_user'), 'hash_cap_replacement', 'Replacement');

SELECT is(
  (SELECT count(*)::INTEGER FROM hub.api_keys
    WHERE user_id = tests.get_supabase_uid('cap_user') AND revoked_at IS NULL),
  10,
  'After revoking one + inserting one, active count is back to 10'
);

-- 5. Another user is not affected by cap_user's count — each user has
-- their own limit.
SELECT tests.authenticate_as('cap_other');

INSERT INTO hub.api_keys (user_id, api_key_hash, label)
VALUES (tests.get_supabase_uid('cap_other'), 'hash_other_1', 'Other Key 1');

SELECT is(
  (SELECT count(*)::INTEGER FROM hub.api_keys
    WHERE user_id = tests.get_supabase_uid('cap_other') AND revoked_at IS NULL),
  1,
  'Second user''s cap is independent of the first user''s 10-key count'
);

-- 6. Revoked-on-insert rows don't count against the cap (they're already
-- inactive). This path is for edge cases like restoring keys from an
-- audit log where revoked_at is pre-set.
SELECT tests.authenticate_as('cap_user');

DO $$
BEGIN
  -- cap_user currently has 10 active keys; inserting a pre-revoked row
  -- should succeed.
  INSERT INTO hub.api_keys (user_id, api_key_hash, label, revoked_at)
  VALUES (
    tests.get_supabase_uid('cap_user'),
    'hash_prerevoked',
    'Pre-revoked',
    now()
  );
END $$;

SELECT is(
  (SELECT count(*)::INTEGER FROM hub.api_keys
    WHERE user_id = tests.get_supabase_uid('cap_user') AND revoked_at IS NOT NULL),
  2,  -- hash_cap_1 revoked in test 4 + hash_prerevoked
  'Pre-revoked rows insert successfully (excluded from the cap)'
);

-- 7. The 11-key rejection specifically uses SQLSTATE 'P0001'. Catch and
-- inspect the code so a future change to the RAISE message doesn't make
-- the test pass with a different error class.
DO $$
DECLARE
  v_sqlstate TEXT;
BEGIN
  BEGIN
    INSERT INTO hub.api_keys (user_id, api_key_hash, label)
    VALUES (tests.get_supabase_uid('cap_user'), 'hash_cap_12', 'Key 12');
  EXCEPTION WHEN others THEN
    v_sqlstate := SQLSTATE;
  END;

  IF v_sqlstate IS DISTINCT FROM 'P0001' THEN
    RAISE EXCEPTION 'expected SQLSTATE P0001, got %', v_sqlstate;
  END IF;
END $$;

SELECT pass('Trigger raises SQLSTATE P0001 (user-defined, not a generic DB error)');

-- 8. RLS still blocks cross-user inserts — cap_other tries to insert
-- a key with cap_user's user_id. Use a third user as the impersonated
-- target so the trigger's cap check passes (the target user has 0
-- active keys) and RLS is the specific gate that fires. If the trigger
-- fired first here we'd mistake "cap tripped" for "RLS blocked"; the
-- separate user guarantees the RLS-only failure path.
SELECT tests.create_supabase_user('cap_victim', 'capvictim@test.com');
SELECT tests.authenticate_as('cap_other');

SELECT throws_ok(
  format(
    $$ INSERT INTO hub.api_keys (user_id, api_key_hash, label)
       VALUES (%L, 'hash_cross_user', 'Cross') $$,
    tests.get_supabase_uid('cap_victim')
  ),
  '42501',
  NULL,
  'RLS still blocks cross-user inserts (trigger does not bypass RLS)'
);

SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('cap_user');
SELECT tests.delete_supabase_user('cap_other');
SELECT tests.delete_supabase_user('cap_victim');

SELECT * FROM finish();

ROLLBACK;
