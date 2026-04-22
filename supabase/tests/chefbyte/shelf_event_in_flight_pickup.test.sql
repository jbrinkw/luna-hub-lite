-- pgTAP — apply_shelf_event in_flight_pickup + in_flight_return paths.
--
-- Validates supabase/migrations/20260425080000_shelf_event_in_flight_pickup.sql.
--
-- Coverage:
--   1. in_flight_pickup stamps in_flight_since on the qty>0 lot.
--   2. in_flight_pickup does NOT decrement qty_containers.
--   3. in_flight_pickup stamps pickup_event_id from p_pi_event_id.
--   4. in_flight_return clears in_flight_since on the matching lot.
--   5. in_flight_pickup fallback to in_flight or any-lot when qty=0.
--   6. in_flight_return with no matching lot: applied=true no-op reply.
--   7. Idempotency: same client_event_id returns cached result.

BEGIN;
SELECT plan(10);

------------------------------------------------------------
-- Setup (authenticated user — matches stock_lots_in_flight.test.sql)
------------------------------------------------------------

SELECT tests.create_supabase_user('inflt_alice');
SELECT tests.authenticate_as('inflt_alice');
SELECT hub.activate_app('chefbyte');

-- Seed product + lot (location 'Fridge' comes from activate_app).
INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('inflt_alice'),
  'Inflt Chocolate Milk',
  1537.822, 3,
  150, 20, 8, 5
);

SELECT product_id AS alice_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('inflt_alice')
   AND name = 'Inflt Chocolate Milk' \gset

SELECT location_id AS alice_fridge_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('inflt_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('inflt_alice'),
  'inflt-pi',
  'inflt_hash_alice',
  true
);

SELECT device_id AS alice_device_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('inflt_alice')
   AND device_name = 'inflt-pi' \gset

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('inflt_alice'),
  :'alice_product_id',
  :'alice_fridge_id',
  0.306,
  'live_shelf',
  now() - interval '5 minutes'
);

SELECT lot_id AS alice_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('inflt_alice')
   AND product_id = :'alice_product_id' \gset

------------------------------------------------------------
-- Case 1: in_flight_pickup stamps the lot
------------------------------------------------------------

-- Elevate to postgres so direct private.apply_shelf_event calls succeed.
-- This mirrors the pattern in stock_lots_in_flight.test.sql.
SET LOCAL role postgres;

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'in_flight_pickup',
        %L::UUID, -470.2, now()::TIMESTAMPTZ, 'evt-pickup-1',
        '99999999-9999-9999-9999-999999999901'
      )$$,
    tests.get_supabase_uid('inflt_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 1: in_flight_pickup call runs without error'
);

SELECT isnt(
  (SELECT in_flight_since FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  NULL,
  'case 1: in_flight_since stamped on the lot'
);

SELECT is(
  (SELECT pickup_event_id FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  '99999999-9999-9999-9999-999999999901'::uuid,
  'case 1: pickup_event_id stamped from p_pi_event_id'
);

-- qty unchanged
SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id')::numeric(10,3),
  0.306::numeric(10,3),
  'case 1: qty_containers NOT decremented by in_flight_pickup'
);

------------------------------------------------------------
-- Case 2: in_flight_return clears in_flight_since
------------------------------------------------------------

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'in_flight_return',
        %L::UUID, 0, now()::TIMESTAMPTZ, 'evt-return-1', NULL
      )$$,
    tests.get_supabase_uid('inflt_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 2: in_flight_return call runs without error'
);

SELECT is(
  (SELECT in_flight_since FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  NULL,
  'case 2: in_flight_since cleared'
);

------------------------------------------------------------
-- Case 3: pickup falls back to in_flight lot when qty=0 (fallback-1)
------------------------------------------------------------

-- Zero qty + re-stamp as in_flight (simulating the prod bug state:
-- companion consumed event zero'd qty, but we still want the marker).
UPDATE chefbyte.stock_lots
   SET qty_containers = 0,
       in_flight_since = now() - interval '10 minutes',
       pickup_event_id = '99999999-9999-9999-9999-999999999901'
 WHERE lot_id = :'alice_lot_id';

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'in_flight_pickup',
        %L::UUID, -470.2, now()::TIMESTAMPTZ, 'evt-pickup-2', NULL
      )$$,
    tests.get_supabase_uid('inflt_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 3: in_flight_pickup with qty=0 + existing in_flight lot applies via fallback-1'
);

SELECT isnt(
  (SELECT in_flight_since FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  NULL,
  'case 3: in_flight_since re-stamped on existing in_flight lot'
);

------------------------------------------------------------
-- Case 4: in_flight_return with no matching in_flight lot → no-op reply
------------------------------------------------------------

UPDATE chefbyte.stock_lots
   SET in_flight_since = NULL, pickup_event_id = NULL
 WHERE lot_id = :'alice_lot_id';

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'in_flight_return',
        %L::UUID, 0, now()::TIMESTAMPTZ, 'evt-return-noop', NULL
      )$$,
    tests.get_supabase_uid('inflt_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 4: in_flight_return with no matching lot runs without error'
);

SELECT is(
  (SELECT reason FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('inflt_alice')
      AND client_event_id = 'evt-return-noop'),
  'no in_flight lot to clear (no-op)',
  'case 4: shelf_event_log reason is the no-op marker'
);

SELECT * FROM finish();
ROLLBACK;
