-- pgTAP — live_shelf_devices is_active ledger.
--
-- Validates supabase/migrations/20260429150000_live_shelf_devices_state_ledger.sql.
--
-- Coverage:
--   1. Trigger + table existence.
--   2. Backfill seeded one row per pre-existing device after the
--      INSERT-path ledger trigger is in place.
--   3. An is_active flip (true → false) writes a real ledger row.
--   4. A no-op write (heartbeat ts only, is_active untouched) does
--      NOT write a ledger row.
--   5. Self-heal flip via heartbeat trigger (false → true) is recorded
--      with the FINAL values (NEW.is_active after the self-heal).
--   6. The view live_shelf_device_history returns oldest-first via
--      history_seq.
--   7. RLS isolates ledger rows per-user.

BEGIN;
SELECT plan(11);

------------------------------------------------------------
-- Setup users
------------------------------------------------------------
SELECT tests.create_supabase_user('led_alice', 'led_alice@test.com');
SELECT tests.create_supabase_user('led_bob',   'led_bob@test.com');

SELECT tests.get_supabase_uid('led_alice') AS alice_uid \gset
SELECT tests.get_supabase_uid('led_bob')   AS bob_uid   \gset

SELECT tests.authenticate_as('led_alice');
SELECT hub.activate_app('chefbyte');
SELECT tests.authenticate_as('led_bob');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();

------------------------------------------------------------
-- Trigger + table existence
------------------------------------------------------------

SELECT has_table(
  'chefbyte'::name, 'live_shelf_device_state_changes'::name,
  'ledger table exists'
);

SELECT has_trigger(
  'chefbyte'::name, 'live_shelf_devices'::name,
  'live_shelf_devices_state_ledger_trigger'::name,
  'BEFORE-UPDATE ledger trigger exists on live_shelf_devices'
);

------------------------------------------------------------
-- Seed devices (service_role bypasses RLS for ingest-style writes)
------------------------------------------------------------

SET ROLE service_role;

INSERT INTO chefbyte.live_shelf_devices (
  device_id, user_id, device_name, import_key_hash, is_active, last_heartbeat_ts
) VALUES
  ('cccc0001-0000-0000-0000-000000000001', :'alice_uid'::uuid,
   'alice-pi', 'led_hash_alice_active', true, now()),
  ('cccc0002-0000-0000-0000-000000000002', :'bob_uid'::uuid,
   'bob-pi-archived', 'led_hash_bob_archived', false, NULL);

-- The AFTER-INSERT seed trigger should have written one ledger row
-- per device just inserted.
SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.live_shelf_device_state_changes
    WHERE device_id IN ('cccc0001-0000-0000-0000-000000000001'::uuid,
                        'cccc0002-0000-0000-0000-000000000002'::uuid)),
  2,
  'INSERT trigger seeds one initial-state ledger row per device'
);

SELECT is(
  (SELECT change_reason FROM chefbyte.live_shelf_device_state_changes
    WHERE device_id = 'cccc0001-0000-0000-0000-000000000001'::uuid
    ORDER BY changed_at, change_id LIMIT 1),
  'backfill',
  'initial ledger row tagged with reason=backfill'
);

------------------------------------------------------------
-- Case: an is_active flip writes a ledger row
------------------------------------------------------------

-- Alice's active device → revoke. Guard trigger logs NOTICE; ledger
-- trigger should record the flip.
UPDATE chefbyte.live_shelf_devices
   SET is_active = false
 WHERE device_id = 'cccc0001-0000-0000-0000-000000000001'::uuid;

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.live_shelf_device_state_changes
    WHERE device_id = 'cccc0001-0000-0000-0000-000000000001'::uuid
      AND was_active = true AND became_active = false),
  1,
  'is_active true→false flip writes a ledger row with was=true became=false'
);

------------------------------------------------------------
-- Case: a no-op write does NOT write a ledger row
------------------------------------------------------------

-- Rename only; is_active untouched. Should NOT add a ledger row.
UPDATE chefbyte.live_shelf_devices
   SET device_name = 'alice-pi-renamed'
 WHERE device_id = 'cccc0001-0000-0000-0000-000000000001'::uuid;

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.live_shelf_device_state_changes
    WHERE device_id = 'cccc0001-0000-0000-0000-000000000001'::uuid),
  2,  -- the initial INSERT row + the true→false flip; rename is a no-op
  'pure rename does not pollute the ledger'
);

------------------------------------------------------------
-- Case: self-heal heartbeat (false → true via existing trigger)
-- records FINAL state (became_active = true).
------------------------------------------------------------

-- Alice now has only one device, currently inactive. A heartbeat
-- triggers self-heal which mutates NEW.is_active = true. The ledger
-- trigger fires AFTER self-heal (alphabetical trigger ordering) so we
-- record the post-self-heal value.
--
-- Use clock_timestamp() (not now() — now() is the txn start and
-- equals the seed timestamp in the same transaction, which would
-- short-circuit the self-heal trigger's IS DISTINCT FROM guard).
UPDATE chefbyte.live_shelf_devices
   SET last_heartbeat_ts = clock_timestamp()
 WHERE device_id = 'cccc0001-0000-0000-0000-000000000001'::uuid;

SELECT is(
  (SELECT became_active FROM chefbyte.live_shelf_device_state_changes
    WHERE device_id = 'cccc0001-0000-0000-0000-000000000001'::uuid
    ORDER BY changed_at DESC, change_id DESC
    LIMIT 1),
  true,
  'self-heal heartbeat writes a ledger row with became_active=true (final state)'
);

SELECT is(
  (SELECT is_active FROM chefbyte.live_shelf_devices
    WHERE device_id = 'cccc0001-0000-0000-0000-000000000001'::uuid),
  true,
  'self-heal actually flipped the row to active'
);

------------------------------------------------------------
-- Case: view returns oldest-first via history_seq=1
------------------------------------------------------------

SELECT is(
  (SELECT change_reason FROM chefbyte.live_shelf_device_history
    WHERE device_id = 'cccc0001-0000-0000-0000-000000000001'::uuid
      AND history_seq = 1),
  'backfill',
  'history view: history_seq=1 is the initial backfill row (oldest)'
);

------------------------------------------------------------
-- Case: RLS isolates ledger rows per-user.
-- Alice authenticated should NOT see Bob's ledger row.
------------------------------------------------------------

SET ROLE postgres;
SELECT tests.authenticate_as('led_alice');

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.live_shelf_device_state_changes
    WHERE device_id = 'cccc0002-0000-0000-0000-000000000002'::uuid),
  0,
  'RLS: alice cannot SELECT bob''s ledger rows'
);

-- Sanity: alice CAN see her own.
SELECT cmp_ok(
  (SELECT COUNT(*)::int FROM chefbyte.live_shelf_device_state_changes
    WHERE device_id = 'cccc0001-0000-0000-0000-000000000001'::uuid),
  '>=',
  1,
  'RLS: alice CAN SELECT her own ledger rows'
);

SELECT tests.clear_authentication();
SET ROLE postgres;

SELECT * FROM finish();
ROLLBACK;
