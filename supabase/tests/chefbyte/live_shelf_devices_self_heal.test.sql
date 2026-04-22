-- pgTAP — live_shelf_devices heartbeat self-heal + guard triggers.
--
-- Validates supabase/migrations/20260425060000_live_shelf_devices_safer_invariant.sql.
--
-- Coverage:
--   1. Lone-inactive device receiving a heartbeat auto-reactivates.
--   2. Lone-inactive device receiving a non-heartbeat UPDATE does NOT
--      auto-reactivate (scope limited to heartbeat path).
--   3. An inactive device WITH another active device does NOT
--      auto-reactivate on heartbeat (genuinely retired).
--   4. Guard trigger: deactivating the last active device is ALLOWED
--      (advisory only) — we check the resulting state rather than
--      throwing.
--   5. Baseline: a fresh active device with a heartbeat update leaves
--      is_active alone (no spurious writes).

BEGIN;
SELECT plan(9);

------------------------------------------------------------
-- Setup
------------------------------------------------------------
SELECT tests.create_supabase_user('heal_alice', 'heal_alice@test.com');
SELECT tests.create_supabase_user('heal_bob',   'heal_bob@test.com');

SELECT tests.get_supabase_uid('heal_alice') AS alice_uid \gset
SELECT tests.get_supabase_uid('heal_bob')   AS bob_uid   \gset

SELECT tests.authenticate_as('heal_alice');
SELECT hub.activate_app('chefbyte');
SELECT tests.authenticate_as('heal_bob');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();

SET ROLE service_role;

------------------------------------------------------------
-- Trigger existence
------------------------------------------------------------
SELECT has_trigger(
  'chefbyte'::name, 'live_shelf_devices'::name,
  'live_shelf_devices_heartbeat_self_heal_trigger'::name,
  'self-heal trigger exists on live_shelf_devices'
);

SELECT has_trigger(
  'chefbyte'::name, 'live_shelf_devices'::name,
  'live_shelf_devices_guard_deactivation_trigger'::name,
  'guard trigger exists on live_shelf_devices'
);

------------------------------------------------------------
-- Case 1: Lone-inactive device receiving heartbeat → auto-reactivates
------------------------------------------------------------

-- Seed alice's one device as INACTIVE (mirrors the post-migration state
-- where the consolidation silently flipped it).
INSERT INTO chefbyte.live_shelf_devices (
  device_id, user_id, device_name, import_key_hash, is_active, last_heartbeat_ts
) VALUES (
  'aaaa0001-0000-0000-0000-000000000001',
  :'alice_uid'::uuid,
  'alice-pi-lone',
  'heal_hash_alice_lone',
  false,
  NULL
);

-- Heartbeat arrives. BEFORE UPDATE trigger should flip is_active → true.
UPDATE chefbyte.live_shelf_devices
   SET last_heartbeat_ts = now()
 WHERE device_id = 'aaaa0001-0000-0000-0000-000000000001';

SELECT is(
  (SELECT is_active FROM chefbyte.live_shelf_devices
    WHERE device_id = 'aaaa0001-0000-0000-0000-000000000001'),
  true,
  'case 1: lone-inactive device self-heals on heartbeat'
);

SELECT isnt(
  (SELECT last_heartbeat_ts FROM chefbyte.live_shelf_devices
    WHERE device_id = 'aaaa0001-0000-0000-0000-000000000001'),
  NULL,
  'case 1: heartbeat timestamp landed alongside the self-heal'
);

------------------------------------------------------------
-- Case 2: Lone-inactive device receiving a NON-heartbeat UPDATE does
-- not auto-reactivate. Only the heartbeat path self-heals.
------------------------------------------------------------

-- Manually flip alice's device back to inactive so we can test this
-- path independently. Use a direct UPDATE of is_active — the guard
-- trigger will NOTICE but allow it.
UPDATE chefbyte.live_shelf_devices
   SET is_active = false
 WHERE device_id = 'aaaa0001-0000-0000-0000-000000000001';

-- A non-heartbeat UPDATE (rename) must not self-heal.
UPDATE chefbyte.live_shelf_devices
   SET device_name = 'alice-pi-lone-renamed'
 WHERE device_id = 'aaaa0001-0000-0000-0000-000000000001';

SELECT is(
  (SELECT is_active FROM chefbyte.live_shelf_devices
    WHERE device_id = 'aaaa0001-0000-0000-0000-000000000001'),
  false,
  'case 2: non-heartbeat UPDATE does not self-heal'
);

------------------------------------------------------------
-- Case 3: Inactive device WITH another active device does NOT
-- auto-reactivate on heartbeat (genuinely retired).
------------------------------------------------------------

-- Seed alice's ACTIVE primary device (she now has two rows: the
-- inactive one above + a new active one).
INSERT INTO chefbyte.live_shelf_devices (
  device_id, user_id, device_name, import_key_hash, is_active, last_heartbeat_ts
) VALUES (
  'aaaa0002-0000-0000-0000-000000000002',
  :'alice_uid'::uuid,
  'alice-pi-primary',
  'heal_hash_alice_primary',
  true,
  now()
);

-- Heartbeat on the RETIRED (inactive) device. Should stay inactive
-- because another active row exists.
UPDATE chefbyte.live_shelf_devices
   SET last_heartbeat_ts = now()
 WHERE device_id = 'aaaa0001-0000-0000-0000-000000000001';

SELECT is(
  (SELECT is_active FROM chefbyte.live_shelf_devices
    WHERE device_id = 'aaaa0001-0000-0000-0000-000000000001'),
  false,
  'case 3: inactive device with sibling-active does NOT self-heal'
);

------------------------------------------------------------
-- Case 4: Guard trigger advisory only — deactivating the last
-- active device is still allowed.
------------------------------------------------------------

-- Delete the inactive sibling so alice's primary is the sole active row.
DELETE FROM chefbyte.live_shelf_devices
 WHERE device_id = 'aaaa0001-0000-0000-0000-000000000001';

-- Now explicitly revoke the primary. Guard trigger raises NOTICE but
-- allows the write. The pgTAP harness can't easily capture NOTICE
-- output, so we assert on the resulting state.
UPDATE chefbyte.live_shelf_devices
   SET is_active = false
 WHERE device_id = 'aaaa0002-0000-0000-0000-000000000002';

SELECT is(
  (SELECT is_active FROM chefbyte.live_shelf_devices
    WHERE device_id = 'aaaa0002-0000-0000-0000-000000000002'),
  false,
  'case 4: explicit revoke of last active device is ALLOWED (advisory only)'
);

------------------------------------------------------------
-- Case 5: Baseline — already-active device + heartbeat does not
-- touch is_active. Negative control for the trigger body.
------------------------------------------------------------

-- Bob has one active device.
INSERT INTO chefbyte.live_shelf_devices (
  device_id, user_id, device_name, import_key_hash, is_active, last_heartbeat_ts
) VALUES (
  'bbbb0001-0000-0000-0000-000000000001',
  :'bob_uid'::uuid,
  'bob-pi',
  'heal_hash_bob',
  true,
  now() - interval '30 seconds'
);

UPDATE chefbyte.live_shelf_devices
   SET last_heartbeat_ts = now()
 WHERE device_id = 'bbbb0001-0000-0000-0000-000000000001';

SELECT is(
  (SELECT is_active FROM chefbyte.live_shelf_devices
    WHERE device_id = 'bbbb0001-0000-0000-0000-000000000001'),
  true,
  'case 5: already-active device stays active after heartbeat (baseline)'
);

------------------------------------------------------------
-- Case 6: Zero-row edge — a user with NO devices whose first
-- device is inserted as is_active=false (rare, but well-defined).
-- Subsequent heartbeat should self-heal.
------------------------------------------------------------

INSERT INTO chefbyte.live_shelf_devices (
  device_id, user_id, device_name, import_key_hash, is_active, last_heartbeat_ts
) VALUES (
  'bbbb0002-0000-0000-0000-000000000002',
  :'bob_uid'::uuid,
  'bob-pi-archived',
  'heal_hash_bob_archived',
  false,
  NULL
);

-- Deactivate bob's primary so the archived one is the sole record.
UPDATE chefbyte.live_shelf_devices
   SET is_active = false
 WHERE device_id = 'bbbb0001-0000-0000-0000-000000000001';

-- Now heartbeat the archived device. No other active → self-heals.
UPDATE chefbyte.live_shelf_devices
   SET last_heartbeat_ts = now()
 WHERE device_id = 'bbbb0002-0000-0000-0000-000000000002';

SELECT is(
  (SELECT is_active FROM chefbyte.live_shelf_devices
    WHERE device_id = 'bbbb0002-0000-0000-0000-000000000002'),
  true,
  'case 6: lone device self-heals even after manual dual-revoke'
);

-- Cleanup
SET ROLE postgres;

SELECT * FROM finish();
ROLLBACK;
