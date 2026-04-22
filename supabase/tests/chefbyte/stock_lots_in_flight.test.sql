-- In-flight column behaviour on chefbyte.stock_lots:
--   * column defaults to NULL on new rows
--   * users can update their OWN lots (set + clear) via RLS
--   * users CANNOT update another user's in_flight_since (cross-user isolation)
--   * apply_shelf_event CLEARS in_flight_since on 'added' / 'refilled'
--
-- Uses the same test-helpers / auth-as pattern as the existing
-- chefbyte pgTAP suite (see supabase/tests/chefbyte/stock_lots.test.sql).

BEGIN;
SELECT plan(9);

-- Two users, both with chefbyte activated.
SELECT tests.create_supabase_user('inflight_owner');
SELECT tests.create_supabase_user('inflight_intruder');

SELECT tests.authenticate_as('inflight_owner');
SELECT hub.activate_app('chefbyte');
SELECT tests.authenticate_as('inflight_intruder');
SELECT hub.activate_app('chefbyte');

-- Owner creates a product + a lot.
SELECT tests.authenticate_as('inflight_owner');
INSERT INTO chefbyte.products (user_id, name, net_weight_g, servings_per_container)
VALUES (tests.get_supabase_uid('inflight_owner'), 'Test Yogurt', 500, 4);

SELECT product_id AS owner_product_id FROM chefbyte.products
  WHERE user_id = tests.get_supabase_uid('inflight_owner') AND name = 'Test Yogurt' \gset

SELECT location_id AS owner_fridge_id FROM chefbyte.locations
  WHERE user_id = tests.get_supabase_uid('inflight_owner') AND name = 'Fridge' \gset

INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers)
VALUES (tests.get_supabase_uid('inflight_owner'), :'owner_product_id', :'owner_fridge_id', 2);

SELECT lot_id AS owner_lot_id FROM chefbyte.stock_lots
  WHERE user_id = tests.get_supabase_uid('inflight_owner')
    AND product_id = :'owner_product_id' \gset

------------------------------------------------------------
-- 1. New lot defaults in_flight_since to NULL
------------------------------------------------------------
SELECT is(
  (SELECT in_flight_since FROM chefbyte.stock_lots WHERE lot_id = :'owner_lot_id'),
  NULL,
  'new stock_lots row has NULL in_flight_since by default'
);

------------------------------------------------------------
-- 2. pickup_event_id also defaults to NULL
------------------------------------------------------------
SELECT is(
  (SELECT pickup_event_id FROM chefbyte.stock_lots WHERE lot_id = :'owner_lot_id'),
  NULL,
  'new stock_lots row has NULL pickup_event_id by default'
);

------------------------------------------------------------
-- 3. Owner can set in_flight_since on own lot
------------------------------------------------------------
SELECT lives_ok(
  format(
    'UPDATE chefbyte.stock_lots SET in_flight_since = ''2026-04-21T14:30:00Z'' WHERE lot_id = %L',
    :'owner_lot_id'
  ),
  'owner can set in_flight_since on own lot'
);

SELECT isnt(
  (SELECT in_flight_since FROM chefbyte.stock_lots WHERE lot_id = :'owner_lot_id'),
  NULL,
  'in_flight_since is now non-null after owner update'
);

------------------------------------------------------------
-- 4. Intruder cannot update owner's lot (RLS blocks silently — 0 rows affected)
------------------------------------------------------------
SELECT tests.authenticate_as('inflight_intruder');

UPDATE chefbyte.stock_lots
   SET in_flight_since = NULL
 WHERE lot_id = :'owner_lot_id';

-- Back to owner to verify nothing changed.
SELECT tests.authenticate_as('inflight_owner');

SELECT isnt(
  (SELECT in_flight_since FROM chefbyte.stock_lots WHERE lot_id = :'owner_lot_id'),
  NULL,
  'cross-user UPDATE on in_flight_since is blocked by RLS (column still set)'
);

------------------------------------------------------------
-- 5. Owner can clear in_flight_since (round-trip)
------------------------------------------------------------
SELECT lives_ok(
  format(
    'UPDATE chefbyte.stock_lots SET in_flight_since = NULL WHERE lot_id = %L',
    :'owner_lot_id'
  ),
  'owner can clear in_flight_since on own lot'
);

SELECT is(
  (SELECT in_flight_since FROM chefbyte.stock_lots WHERE lot_id = :'owner_lot_id'),
  NULL,
  'in_flight_since cleared successfully'
);

------------------------------------------------------------
-- 6. apply_shelf_event on `added` clears in_flight_since automatically
------------------------------------------------------------
-- Set in_flight_since again, then invoke apply_shelf_event with 'added'.
-- The function runs SECURITY DEFINER under service_role — we call the
-- admin wrapper that exists for exactly this purpose.

UPDATE chefbyte.stock_lots
   SET in_flight_since = '2026-04-21T15:00:00Z',
       pickup_event_id = gen_random_uuid()
 WHERE lot_id = :'owner_lot_id';

-- Need a live_shelf_devices row so apply_shelf_event can insert into
-- shelf_event_log with a valid device_id FK.
INSERT INTO chefbyte.live_shelf_devices (user_id, device_name, import_key_hash)
VALUES (tests.get_supabase_uid('inflight_owner'), 'test-device',
        encode(digest('test-key-' || tests.get_supabase_uid('inflight_owner')::text, 'sha256'), 'hex'));

SELECT device_id AS owner_device_id FROM chefbyte.live_shelf_devices
  WHERE user_id = tests.get_supabase_uid('inflight_owner') LIMIT 1 \gset

-- Elevate to service_role-equivalent via direct call to private.*.
SET LOCAL role postgres;

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-1', 'live_scale', 'added',
        %L::UUID, 250.0, '2026-04-21T15:05:00Z'::TIMESTAMPTZ, 'ev-cleanup-1', NULL
      )$$,
    tests.get_supabase_uid('inflight_owner'),
    :'owner_device_id',
    :'owner_product_id'
  ),
  'apply_shelf_event(added) on an in-flight lot runs cleanly'
);

SELECT is(
  (SELECT in_flight_since FROM chefbyte.stock_lots WHERE lot_id = :'owner_lot_id'),
  NULL,
  'apply_shelf_event(added) clears in_flight_since automatically'
);

SELECT * FROM finish();
ROLLBACK;
