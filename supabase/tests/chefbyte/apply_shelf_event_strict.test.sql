-- pgTAP — private.apply_shelf_event raises on phantom product_id and missing
-- net_weight_g BEFORE inserting a shelf_event_log row.
--
-- Implements FINAL_PLAN.md Change A pgTAP requirement.
--
-- NEGATIVE-TWIN PROOF:
--   Reverting the splice in 20260429340000_apply_shelf_event_strict.sql
--   (removing the pre-insert IF NOT EXISTS blocks) causes the RAISE to
--   never execute → throws_ok assertions turn into "function did not raise"
--   failures, and the is(0) assertions flip to 1.

BEGIN;
SELECT plan(6);

------------------------------------------------------------
-- Setup: real user with activated chefbyte (seeds locations), a device.
-- Use service_role to seed data that bypasses RLS.
------------------------------------------------------------

SELECT tests.create_supabase_user('ase_strict');
SELECT tests.authenticate_as('ase_strict');
SELECT hub.activate_app('chefbyte');

-- Capture user UUID + fridge location (RLS-scoped reads work while authenticated).
SELECT tests.get_supabase_uid('ase_strict') AS _uid \gset

SELECT location_id AS _loc_id
  FROM chefbyte.locations
 WHERE user_id = :'_uid'::uuid
   AND name = 'Fridge' \gset

-- Switch to service_role for device + product + lot inserts and RPC calls.
SELECT tests.clear_authentication();
SET ROLE service_role;

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  :'_uid'::uuid, 'ase-strict-pi',
  'ase_strict_hash_0000000000000000000000000000001', true
);

SELECT device_id AS _dev_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = :'_uid'::uuid
   AND device_name = 'ase-strict-pi' \gset

-- Product with no net_weight_g (triggers 22023 strict check).
INSERT INTO chefbyte.products (user_id, name, net_weight_g)
VALUES (:'_uid'::uuid, 'ASE No Weight Product', NULL);

SELECT product_id AS _no_wt_pid
  FROM chefbyte.products
 WHERE user_id = :'_uid'::uuid
   AND name = 'ASE No Weight Product' \gset

-- Product with valid net_weight_g (used for pass-through checks).
INSERT INTO chefbyte.products (user_id, name, net_weight_g)
VALUES (:'_uid'::uuid, 'ASE Real Product', 1000.0);

SELECT product_id AS _real_pid
  FROM chefbyte.products
 WHERE user_id = :'_uid'::uuid
   AND name = 'ASE Real Product' \gset

-- Stock lot so the consumed path has something to decrement.
INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers)
VALUES (:'_uid'::uuid, :'_real_pid'::uuid, :'_loc_id'::uuid, 5.0);

------------------------------------------------------------
-- A1: phantom product_id → RAISE '23503' before log insert.
------------------------------------------------------------

SELECT throws_ok(
  format(
    $q$ SELECT chefbyte.apply_shelf_event_admin(
      %L::uuid, %L::uuid,
      'scale-01', 'live_shelf', 'consumed',
      'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid,
      -100.0, now(), 'ase-phantom-001', NULL
    ) $q$,
    :'_uid', :'_dev_id'
  ),
  '23503',
  NULL,
  'A1: phantom product_id raises SQLSTATE 23503'
);

------------------------------------------------------------
-- A2: no shelf_event_log row written for phantom product_id branch.
------------------------------------------------------------

SELECT is(
  (SELECT count(*)::int FROM chefbyte.shelf_event_log
    WHERE client_event_id = 'ase-phantom-001'),
  0,
  'A2: phantom product_id branch writes NO shelf_event_log row'
);

------------------------------------------------------------
-- A3: missing net_weight_g → RAISE '22023' before log insert.
------------------------------------------------------------

SELECT throws_ok(
  format(
    $q$ SELECT chefbyte.apply_shelf_event_admin(
      %L::uuid, %L::uuid,
      'scale-01', 'live_shelf', 'consumed',
      %L::uuid,
      -50.0, now(), 'ase-noweight-001', NULL
    ) $q$,
    :'_uid', :'_dev_id', :'_no_wt_pid'
  ),
  '22023',
  NULL,
  'A3: missing net_weight_g raises SQLSTATE 22023'
);

------------------------------------------------------------
-- A4: no shelf_event_log row written for missing net_weight_g branch.
------------------------------------------------------------

SELECT is(
  (SELECT count(*)::int FROM chefbyte.shelf_event_log
    WHERE client_event_id = 'ase-noweight-001'),
  0,
  'A4: missing net_weight_g branch writes NO shelf_event_log row'
);

------------------------------------------------------------
-- A5: valid product → duplicate replay does NOT raise.
--     Seed a first call (lands in log), then replay same event_id.
------------------------------------------------------------

-- First call: seeds the log row.
SELECT chefbyte.apply_shelf_event_admin(
  :'_uid'::uuid, :'_dev_id'::uuid,
  'scale-01', 'live_shelf', 'consumed',
  :'_real_pid'::uuid,
  -100.0, now(), 'ase-valid-001', NULL
);

SELECT lives_ok(
  format(
    $q$ SELECT chefbyte.apply_shelf_event_admin(
      %L::uuid, %L::uuid,
      'scale-01', 'live_shelf', 'consumed',
      %L::uuid,
      -100.0, now(), 'ase-valid-001', NULL
    ) $q$,
    :'_uid', :'_dev_id', :'_real_pid'
  ),
  'A5: duplicate client_event_id replay returns without raising'
);

------------------------------------------------------------
-- A6: fresh valid event also does not raise (belt + suspenders).
------------------------------------------------------------

SELECT lives_ok(
  format(
    $q$ SELECT chefbyte.apply_shelf_event_admin(
      %L::uuid, %L::uuid,
      'scale-01', 'live_shelf', 'consumed',
      %L::uuid,
      -100.0, now(), 'ase-valid-002', NULL
    ) $q$,
    :'_uid', :'_dev_id', :'_real_pid'
  ),
  'A6: valid product + net_weight_g with fresh event_id does not raise'
);

SET ROLE postgres;

SELECT * FROM finish();
ROLLBACK;
