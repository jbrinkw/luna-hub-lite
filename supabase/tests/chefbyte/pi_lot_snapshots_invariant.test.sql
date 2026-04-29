-- pgTAP — pi_lot_snapshots cloud mirror + pi_cloud_lot_id_match invariant.
--
-- Validates supabase/migrations/20260429170000_pi_lot_snapshots.sql and
-- the data-driven pi_cloud_lot_id_match check in
-- supabase/functions/invariant-monitor/index.ts.
--
-- Coverage:
--   1. Table + RPC existence.
--   2. RPC bulk-upserts a heartbeat-shaped payload (single round-trip).
--   3. Re-running the RPC for the same (user_id, device_id, pi_lot_id)
--      UPSERTs (no duplicate-row growth).
--   4. Invariant SIMULATION:
--      a) cloud lot with no Pi snapshot → "missing_pi_snapshot" class.
--      b) cloud lot with mismatched qty (drift > tolerance) →
--         "qty_drift" class.
--      c) cloud lot with matching Pi snapshot → no violation.
--   5. RLS isolates pi_lot_snapshots reads per-user.

BEGIN;
SELECT plan(11);

------------------------------------------------------------
-- Setup users + base ChefByte context
------------------------------------------------------------
SELECT tests.create_supabase_user('pls_alice', 'pls_alice@test.com');
SELECT tests.create_supabase_user('pls_bob',   'pls_bob@test.com');

SELECT tests.get_supabase_uid('pls_alice') AS alice_uid \gset
SELECT tests.get_supabase_uid('pls_bob')   AS bob_uid   \gset

SELECT tests.authenticate_as('pls_alice');
SELECT hub.activate_app('chefbyte');
INSERT INTO chefbyte.products (user_id, name) VALUES
  (:'alice_uid'::uuid, 'PLS Test Milk A'),
  (:'alice_uid'::uuid, 'PLS Test Milk B'),
  (:'alice_uid'::uuid, 'PLS Test Milk C');
SELECT product_id AS alice_product_a FROM chefbyte.products
 WHERE user_id = :'alice_uid'::uuid AND name = 'PLS Test Milk A' \gset
SELECT product_id AS alice_product_b FROM chefbyte.products
 WHERE user_id = :'alice_uid'::uuid AND name = 'PLS Test Milk B' \gset
SELECT product_id AS alice_product_c FROM chefbyte.products
 WHERE user_id = :'alice_uid'::uuid AND name = 'PLS Test Milk C' \gset

SELECT tests.authenticate_as('pls_bob');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();

------------------------------------------------------------
-- Existence
------------------------------------------------------------

SELECT has_table(
  'chefbyte'::name, 'pi_lot_snapshots'::name,
  'pi_lot_snapshots table exists'
);

SELECT has_function(
  'chefbyte'::name, 'upsert_pi_lot_snapshots_admin'::name,
  ARRAY['uuid','uuid','jsonb'],
  'upsert_pi_lot_snapshots_admin RPC exists'
);

------------------------------------------------------------
-- Seed a Pi device for alice (service_role bypasses RLS).
------------------------------------------------------------

SET ROLE service_role;

INSERT INTO chefbyte.live_shelf_devices (
  device_id, user_id, device_name, import_key_hash, is_active, last_heartbeat_ts
) VALUES (
  'dddd0001-0000-0000-0000-000000000001',
  :'alice_uid'::uuid,
  'pls-alice-pi',
  'pls_hash_alice_pi',
  true,
  now()
);

------------------------------------------------------------
-- Case 2: bulk-upsert a heartbeat-shaped payload
------------------------------------------------------------

SELECT chefbyte.upsert_pi_lot_snapshots_admin(
  'dddd0001-0000-0000-0000-000000000001'::uuid,
  :'alice_uid'::uuid,
  '[
    {"pi_lot_id":"cloud-lot-A","cloud_lot_id":"eeee0001-0000-0000-0000-000000000001",
     "qty_containers":2.0,"status":"on_shelf","last_update_source":"live_shelf"},
    {"pi_lot_id":"cloud-lot-B","cloud_lot_id":"eeee0002-0000-0000-0000-000000000002",
     "qty_containers":1.5,"status":"in_flight","in_flight_kind":"live_shelf"}
  ]'::jsonb
) AS upserted_count \gset

SELECT is(:upserted_count, 2, 'admin RPC inserts 2 snapshot rows on first call');

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.pi_lot_snapshots
    WHERE user_id = :'alice_uid'::uuid),
  2,
  '2 snapshot rows present after first upsert'
);

------------------------------------------------------------
-- Case 3: re-run upserts (same keys, mutated qty) → still 2 rows
------------------------------------------------------------

SELECT chefbyte.upsert_pi_lot_snapshots_admin(
  'dddd0001-0000-0000-0000-000000000001'::uuid,
  :'alice_uid'::uuid,
  '[
    {"pi_lot_id":"cloud-lot-A","cloud_lot_id":"eeee0001-0000-0000-0000-000000000001",
     "qty_containers":1.0,"status":"on_shelf","last_update_source":"live_shelf"}
  ]'::jsonb
);

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.pi_lot_snapshots
    WHERE user_id = :'alice_uid'::uuid),
  2,
  'second upsert with same key does not duplicate (still 2 rows)'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.pi_lot_snapshots
    WHERE user_id = :'alice_uid'::uuid AND pi_lot_id = 'cloud-lot-A'),
  1.0::numeric(10,3),
  'second upsert overwrites qty_containers (1.0)'
);

------------------------------------------------------------
-- Case 4: invariant simulation.
-- Seed cloud stock_lots rows with last_update_source='live_shelf' and
-- assert the invariant predicate logic against pi_lot_snapshots.
------------------------------------------------------------

SELECT location_id AS alice_fridge_id FROM chefbyte.locations
 WHERE user_id = :'alice_uid'::uuid AND name = 'Fridge' \gset

-- Distinct products per lot so neither the (user,product,location,
-- expires_on) merge key nor the (user,product,last_update_source)
-- partial-unique-on-tracked-shelf invariant trips.
-- Cloud lot A — has matching Pi snapshot, qty within tolerance → no
-- violation expected.
INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id, qty_containers,
  expires_on, last_update_source, last_update_ts
) VALUES (
  'eeee0001-0000-0000-0000-000000000001',
  :'alice_uid'::uuid, :'alice_product_a'::uuid, :'alice_fridge_id'::uuid,
  1.0, '2027-01-01', 'live_shelf', now()
);

-- Cloud lot B — has matching Pi snapshot, but Pi qty=1.5 vs cloud=5
-- → drift > 0.1 tolerance → qty_drift class expected.
INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id, qty_containers,
  expires_on, last_update_source, last_update_ts
) VALUES (
  'eeee0002-0000-0000-0000-000000000002',
  :'alice_uid'::uuid, :'alice_product_b'::uuid, :'alice_fridge_id'::uuid,
  5.0, '2027-02-01', 'live_shelf', now()
);

-- Cloud lot C — no Pi snapshot → missing_pi_snapshot class expected.
INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id, qty_containers,
  expires_on, last_update_source, last_update_ts
) VALUES (
  'eeee0003-0000-0000-0000-000000000003',
  :'alice_uid'::uuid, :'alice_product_c'::uuid, :'alice_fridge_id'::uuid,
  3.0, '2027-03-01', 'live_shelf', now()
);

-- Replicate the invariant's join contract here so we exercise the
-- exact SQL surface the cloud function relies on.
WITH cloud_lots AS (
  SELECT lot_id, qty_containers, last_update_source, in_flight_since
    FROM chefbyte.stock_lots
   WHERE user_id = :'alice_uid'::uuid
     AND last_update_source IN ('live_shelf','live_scale')
     AND deleted_at IS NULL
)
SELECT is(
  (SELECT COUNT(*)::int
     FROM cloud_lots cl
     LEFT JOIN chefbyte.pi_lot_snapshots p
       ON p.cloud_lot_id = cl.lot_id
    WHERE p.cloud_lot_id IS NULL),
  1,
  'invariant: exactly 1 cloud lot has missing_pi_snapshot (lot C)'
);

WITH cloud_lots AS (
  SELECT lot_id, qty_containers
    FROM chefbyte.stock_lots
   WHERE user_id = :'alice_uid'::uuid
     AND last_update_source IN ('live_shelf','live_scale')
     AND deleted_at IS NULL
)
SELECT is(
  (SELECT COUNT(*)::int
     FROM cloud_lots cl
     JOIN chefbyte.pi_lot_snapshots p
       ON p.cloud_lot_id = cl.lot_id
    WHERE abs(cl.qty_containers - p.qty_containers) > 0.1),
  1,
  'invariant: exactly 1 cloud lot has qty_drift (lot B: 5.0 vs 1.5)'
);

WITH cloud_lots AS (
  SELECT lot_id, qty_containers
    FROM chefbyte.stock_lots
   WHERE user_id = :'alice_uid'::uuid
     AND last_update_source IN ('live_shelf','live_scale')
     AND deleted_at IS NULL
)
SELECT is(
  (SELECT COUNT(*)::int
     FROM cloud_lots cl
     JOIN chefbyte.pi_lot_snapshots p
       ON p.cloud_lot_id = cl.lot_id
    WHERE abs(cl.qty_containers - p.qty_containers) <= 0.1),
  1,
  'invariant: exactly 1 cloud lot is within tolerance (lot A: 1.0 vs 1.0)'
);

------------------------------------------------------------
-- Case 5: RLS — alice cannot SELECT bob's snapshot rows.
------------------------------------------------------------

INSERT INTO chefbyte.live_shelf_devices (
  device_id, user_id, device_name, import_key_hash, is_active, last_heartbeat_ts
) VALUES (
  'dddd0002-0000-0000-0000-000000000002',
  :'bob_uid'::uuid,
  'pls-bob-pi',
  'pls_hash_bob_pi',
  true,
  now()
);

SELECT chefbyte.upsert_pi_lot_snapshots_admin(
  'dddd0002-0000-0000-0000-000000000002'::uuid,
  :'bob_uid'::uuid,
  '[
    {"pi_lot_id":"bob-only-lot","cloud_lot_id":null,
     "qty_containers":4.0,"status":"on_shelf"}
  ]'::jsonb
);

SET ROLE postgres;
SELECT tests.authenticate_as('pls_alice');

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.pi_lot_snapshots
    WHERE user_id = :'bob_uid'::uuid),
  0,
  'RLS: alice cannot SELECT bob''s snapshot rows'
);

SELECT cmp_ok(
  (SELECT COUNT(*)::int FROM chefbyte.pi_lot_snapshots
    WHERE user_id = :'alice_uid'::uuid),
  '>=',
  2,
  'RLS: alice CAN SELECT her own snapshot rows'
);

SELECT tests.clear_authentication();
SET ROLE postgres;

SELECT * FROM finish();
ROLLBACK;
