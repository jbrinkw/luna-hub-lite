BEGIN;
SELECT plan(12);

------------------------------------------------------------
-- Setup: two users, each with a shelf device.
------------------------------------------------------------

SELECT tests.create_supabase_user('lt_owner', 'ltowner@test.com');
SELECT tests.create_supabase_user('lt_intruder', 'ltintruder@test.com');

SELECT tests.authenticate_as('lt_owner');
SELECT hub.activate_app('chefbyte');

SELECT tests.authenticate_as('lt_intruder');
SELECT hub.activate_app('chefbyte');

-- Capture UIDs before switching to service_role (which lacks `tests` schema).
SELECT tests.get_supabase_uid('lt_owner') AS _owner_uid \gset
SELECT tests.get_supabase_uid('lt_intruder') AS _intruder_uid \gset

-- Seed one device per user via service_role (bypasses RLS).
SELECT tests.clear_authentication();
SET ROLE service_role;

INSERT INTO chefbyte.live_shelf_devices (user_id, device_name, import_key_hash)
VALUES
  (:'_owner_uid'::uuid,    'owner-pi',    'hash_owner_' || gen_random_uuid()),
  (:'_intruder_uid'::uuid, 'intruder-pi', 'hash_intruder_' || gen_random_uuid());

SELECT device_id AS owner_device
  FROM chefbyte.live_shelf_devices
  WHERE user_id = :'_owner_uid'::uuid LIMIT 1 \gset
SELECT device_id AS intruder_device
  FROM chefbyte.live_shelf_devices
  WHERE user_id = :'_intruder_uid'::uuid LIMIT 1 \gset

SET ROLE postgres;

------------------------------------------------------------
-- 1. Table exists with the expected columns
------------------------------------------------------------

SELECT has_table(
  'chefbyte', 'livetrack_import_sessions',
  'chefbyte.livetrack_import_sessions table exists'
);

SELECT columns_are(
  'chefbyte', 'livetrack_import_sessions',
  ARRAY[
    'session_id','user_id','device_id','state',
    'current_barcode','current_product_id',
    'scale_reading_g','scale_reading_ts',
    'ai_tare_product_form','ai_tare_g',
    'ai_tare_confidence','ai_tare_reasoning','last_error',
    'created_at','updated_at','expires_at'
  ],
  'livetrack_import_sessions has expected columns'
);

------------------------------------------------------------
-- 2. state CHECK rejects invalid values
------------------------------------------------------------

SELECT tests.authenticate_as('lt_owner');
SELECT throws_ok(
  format(
    'INSERT INTO chefbyte.livetrack_import_sessions (user_id, device_id, state)
     VALUES (%L, %L, ''bogus_state'')',
    :'_owner_uid', :'owner_device'
  ),
  '23514',
  NULL,
  'state CHECK rejects bogus_state'
);

------------------------------------------------------------
-- 3. ai_tare_confidence CHECK rejects invalid values
------------------------------------------------------------

SELECT throws_ok(
  format(
    'INSERT INTO chefbyte.livetrack_import_sessions
       (user_id, device_id, state, ai_tare_confidence)
     VALUES (%L, %L, ''waiting_barcode'', ''very-high'')',
    :'_owner_uid', :'owner_device'
  ),
  '23514',
  NULL,
  'ai_tare_confidence CHECK rejects invalid value'
);

------------------------------------------------------------
-- 4. Default expires_at ≈ now() + 10 minutes
------------------------------------------------------------

INSERT INTO chefbyte.livetrack_import_sessions (user_id, device_id, state)
VALUES (:'_owner_uid'::uuid, :'owner_device'::uuid, 'waiting_barcode');

SELECT ok(
  (SELECT expires_at > now() + interval '9 minutes'
          AND expires_at < now() + interval '11 minutes'
     FROM chefbyte.livetrack_import_sessions
     WHERE user_id = :'_owner_uid'::uuid
     ORDER BY created_at DESC LIMIT 1),
  'expires_at default is ~10 minutes in the future'
);

SELECT session_id AS owner_session
  FROM chefbyte.livetrack_import_sessions
  WHERE user_id = :'_owner_uid'::uuid
  ORDER BY created_at DESC LIMIT 1 \gset

------------------------------------------------------------
-- 5. RLS isolation: intruder cannot SELECT owner's row
------------------------------------------------------------

SELECT tests.authenticate_as('lt_intruder');
SELECT is(
  (SELECT count(*)::int FROM chefbyte.livetrack_import_sessions
     WHERE user_id = :'_owner_uid'::uuid),
  0,
  'intruder cannot SELECT owner''s session rows (RLS)'
);

------------------------------------------------------------
-- 6. RLS isolation: intruder cannot UPDATE owner's row
------------------------------------------------------------

UPDATE chefbyte.livetrack_import_sessions
  SET last_error = 'hacked'
  WHERE session_id = :'owner_session'::uuid;

SELECT tests.authenticate_as('lt_owner');
SELECT is(
  (SELECT last_error FROM chefbyte.livetrack_import_sessions
     WHERE session_id = :'owner_session'::uuid),
  NULL,
  'intruder UPDATE did not mutate owner''s last_error (RLS)'
);

------------------------------------------------------------
-- 7. RLS isolation: intruder cannot INSERT as owner
------------------------------------------------------------

SELECT tests.authenticate_as('lt_intruder');
SELECT throws_ok(
  format(
    'INSERT INTO chefbyte.livetrack_import_sessions (user_id, device_id, state)
     VALUES (%L, %L, ''waiting_barcode'')',
    :'_owner_uid', :'owner_device'
  ),
  '42501',
  NULL,
  'intruder INSERT with owner''s user_id is blocked (RLS)'
);

------------------------------------------------------------
-- 8. service_role can SELECT every row (bypasses RLS)
------------------------------------------------------------

SELECT tests.clear_authentication();
SET ROLE service_role;

SELECT ok(
  (SELECT count(*) >= 1
     FROM chefbyte.livetrack_import_sessions
     WHERE session_id = :'owner_session'::uuid),
  'service_role SELECT sees owner session row (bypasses RLS)'
);

------------------------------------------------------------
-- 9. Cascade delete when live_shelf_devices row is removed
------------------------------------------------------------

DELETE FROM chefbyte.live_shelf_devices WHERE device_id = :'owner_device'::uuid;

SELECT is(
  (SELECT count(*)::int FROM chefbyte.livetrack_import_sessions
     WHERE session_id = :'owner_session'::uuid),
  0,
  'deleting the device cascade-deletes its livetrack sessions'
);

------------------------------------------------------------
-- 10. Cascade delete when auth.users row is removed
------------------------------------------------------------

-- Invariant 3 (20260424090000_invariant_batch.sql): at most one active Pi
-- per user. The intruder already owns 'intruder-pi' (active), so the
-- replacement is inserted as inactive — this cascade test doesn't care
-- about the is_active flag, only that the row + its child sessions get
-- nuked when auth.users is deleted.
INSERT INTO chefbyte.live_shelf_devices (user_id, device_name, import_key_hash, is_active)
VALUES (:'_intruder_uid'::uuid, 'intruder-pi-2',
        'hash_intruder2_' || gen_random_uuid(), false);

SELECT device_id AS intruder_device2
  FROM chefbyte.live_shelf_devices
  WHERE user_id = :'_intruder_uid'::uuid
    AND device_name = 'intruder-pi-2' LIMIT 1 \gset

INSERT INTO chefbyte.livetrack_import_sessions (user_id, device_id, state)
VALUES (:'_intruder_uid'::uuid, :'intruder_device2'::uuid, 'waiting_barcode');

SET ROLE postgres;
SELECT tests.delete_supabase_user('lt_intruder');

SET ROLE service_role;
SELECT is(
  (SELECT count(*)::int FROM chefbyte.livetrack_import_sessions
     WHERE user_id = :'_intruder_uid'::uuid),
  0,
  'deleting auth.users cascade-deletes their livetrack sessions'
);

SET ROLE postgres;

------------------------------------------------------------
-- 11. lti_active_idx partial index exists
------------------------------------------------------------

SELECT has_index(
  'chefbyte', 'livetrack_import_sessions', 'lti_active_idx',
  'lti_active_idx partial index exists'
);

SELECT * FROM finish();
ROLLBACK;
