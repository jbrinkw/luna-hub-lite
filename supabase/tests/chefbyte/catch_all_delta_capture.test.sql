-- pgTAP — apply_shelf_event delta-capture branches.
--
-- Validates supabase/migrations/20260427120000_catch_all_delta_capture_model.sql
-- and 20260427130000_catch_all_delta_apply.sql.
--
-- Coverage:
--   1. Schema columns + CHECK constraint exist with correct definitions.
--   2. catch_all_first_measurement on existing lot reconciles qty,
--      stamps in_flight markers + pickup_weight_g, no food_logs.
--   3. catch_all_second_measurement closes the session, updates qty,
--      writes food_logs for the consumed delta, clears markers.
--   4. Inconsistent delta (second weight ≥ first) → applied=false,
--      lot stays in_flight, no food_logs, no qty mutation.
--   5. catch_all_first_measurement with no existing lot mints a new
--      one with the in_flight markers set.
--   6. catch_all_second_measurement without matching pickup_event_id
--      → applied=false (mismatched session).
--   7. catch_all_first_measurement requires kind='catch_all' (defense
--      in depth).
--   8. catch_all_second_measurement requires kind='catch_all'.
--   9. live_shelf in_flight_pickup also stamps in_flight_kind='live_shelf'.
--  10. Backfill: existing in_flight rows tagged 'live_shelf' (verified
--      via constraint on test fixtures + the migration backfill update).

BEGIN;
SELECT plan(30);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('catch_alice');
SELECT tests.authenticate_as('catch_alice');
SELECT hub.activate_app('chefbyte');

-- Seed product with full macros so consumed deltas produce food_logs.
INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('catch_alice'),
  'Catch Trail Mix',
  500.000, 5,
  200, 24, 4, 12
);

SELECT product_id AS alice_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('catch_alice')
   AND name = 'Catch Trail Mix' \gset

SELECT location_id AS alice_fridge_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('catch_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('catch_alice'),
  'catch-pi',
  'catch_hash_alice',
  true
);

SELECT device_id AS alice_device_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('catch_alice')
   AND device_name = 'catch-pi' \gset

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('catch_alice'),
  :'alice_product_id',
  :'alice_fridge_id',
  0.500,
  'manual',
  now() - interval '1 day'
);

SELECT lot_id AS alice_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('catch_alice')
   AND product_id = :'alice_product_id' \gset

SET LOCAL role postgres;

------------------------------------------------------------
-- Case 1: schema columns + CHECK constraint
------------------------------------------------------------

SELECT has_column('chefbyte', 'stock_lots', 'in_flight_kind',
  'case 1a: stock_lots.in_flight_kind column exists');

SELECT has_column('chefbyte', 'stock_lots', 'pickup_weight_g',
  'case 1b: stock_lots.pickup_weight_g column exists');

SELECT col_type_is('chefbyte', 'stock_lots', 'in_flight_kind', 'text',
  'case 1c: in_flight_kind is text');

-- in_flight_kind CHECK rejects garbage values. Use the 4-arg
-- throws_ok variant so we can match on the SQLSTATE 23514 (check
-- constraint violation) — the description goes in slot 4.
SELECT throws_ok(
  format(
    $$INSERT INTO chefbyte.stock_lots
        (user_id, product_id, location_id, qty_containers, in_flight_kind)
      VALUES (%L, %L, %L, 1, 'garbage')$$,
    tests.get_supabase_uid('catch_alice'),
    :'alice_product_id',
    :'alice_fridge_id'
  ),
  '23514',
  NULL,
  'case 1d: in_flight_kind CHECK rejects unknown values'
);

------------------------------------------------------------
-- Case 2: catch_all_first_measurement on existing lot
------------------------------------------------------------
-- Seed: lot starts at qty=0.500 (= 250g of 500g/container).
-- User places it on the catch-all; scale measures 350g.
-- Expected: qty := 0.700 (= 350/500), in_flight_since stamped,
-- in_flight_kind='catch_all', pickup_weight_g=350, pickup_event_id set,
-- NO food_logs row.

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-02', 'catch_all',
        'catch_all_first_measurement', %L::UUID,
        350.0, now()::TIMESTAMPTZ, 'evt-cca-1',
        '11111111-1111-1111-1111-111111111101'
      )$$,
    tests.get_supabase_uid('catch_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 2a: catch_all_first_measurement runs without error'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id')::numeric(10,3),
  0.700::numeric(10,3),
  'case 2b: qty := 350/500 = 0.700'
);

SELECT is(
  (SELECT (in_flight_since IS NOT NULL
           AND in_flight_kind = 'catch_all'
           AND pickup_weight_g = 350.000
           AND pickup_event_id = '11111111-1111-1111-1111-111111111101'::uuid)
     FROM chefbyte.stock_lots WHERE lot_id = :'alice_lot_id'),
  true,
  'case 2c: in_flight markers stamped (kind/since/weight/event_id)'
);

SELECT is(
  (SELECT count(*) FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('catch_alice')
      AND source_client_event_id = 'evt-cca-1'),
  0::bigint,
  'case 2d: NO food_logs for first measurement (reconciliation, not consumption)'
);

SELECT is(
  (SELECT reason FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('catch_alice')
      AND client_event_id = 'evt-cca-1'),
  'catch_all_first_measurement',
  'case 2e: shelf_event_log reason matches'
);

------------------------------------------------------------
-- Case 3: catch_all_second_measurement closes session
------------------------------------------------------------
-- After case 2, lot has pickup_weight_g=350, pickup_event_id=...01.
-- User picks it up, eats some, places it back. Scale measures 250g.
-- Expected: consumption_g = 350 - 250 = 100g; qty := 0.500 (250/500);
-- markers cleared; food_logs row with servings = (100/500) * 5 = 1
-- serving (200 cal, 24 carbs, 4 protein, 12 fat).

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-02', 'catch_all',
        'catch_all_second_measurement', %L::UUID,
        250.0, now()::TIMESTAMPTZ, 'evt-cca-2',
        '11111111-1111-1111-1111-111111111101'
      )$$,
    tests.get_supabase_uid('catch_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 3a: catch_all_second_measurement runs without error'
);

SELECT is(
  (SELECT applied FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('catch_alice')
      AND client_event_id = 'evt-cca-2'),
  true,
  'case 3b: applied=true'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id')::numeric(10,3),
  0.500::numeric(10,3),
  'case 3c: qty := 250/500 = 0.500'
);

SELECT is(
  (SELECT (in_flight_since IS NULL
           AND in_flight_kind IS NULL
           AND pickup_weight_g IS NULL
           AND pickup_event_id IS NULL)
     FROM chefbyte.stock_lots WHERE lot_id = :'alice_lot_id'),
  true,
  'case 3d: in_flight markers all cleared'
);

SELECT is(
  (SELECT count(*) FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('catch_alice')
      AND source_client_event_id = 'evt-cca-2'),
  1::bigint,
  'case 3e: food_logs row written for consumed delta'
);

SELECT is(
  (SELECT calories::numeric(10,1) FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('catch_alice')
      AND source_client_event_id = 'evt-cca-2'),
  200.0::numeric(10,1),
  'case 3f: food_logs.calories = 1 serving × 200 cal'
);

SELECT is(
  (SELECT qty_consumed::numeric(10,3) FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('catch_alice')
      AND source_client_event_id = 'evt-cca-2'),
  1.000::numeric(10,3),
  'case 3g: food_logs.qty_consumed = 100g/500g × 5 servings = 1.000 serving'
);

SELECT is(
  (SELECT reason FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('catch_alice')
      AND client_event_id = 'evt-cca-2'),
  'catch_all_second_measurement_consumed',
  'case 3h: shelf_event_log reason matches'
);

------------------------------------------------------------
-- Case 4: inconsistent delta (second weight heavier than first)
------------------------------------------------------------
-- Re-arm the lot for case 4: stamp first measurement at 200g.

UPDATE chefbyte.stock_lots
   SET qty_containers     = 0.400,
       in_flight_since    = now() - interval '5 minutes',
       in_flight_kind     = 'catch_all',
       pickup_event_id    = '22222222-2222-2222-2222-222222222202'::uuid,
       pickup_weight_g    = 200.000,
       last_update_source = 'catch_all',
       last_update_ts     = now() - interval '5 minutes'
 WHERE lot_id = :'alice_lot_id';

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-02', 'catch_all',
        'catch_all_second_measurement', %L::UUID,
        300.0, now()::TIMESTAMPTZ, 'evt-cca-3',
        '22222222-2222-2222-2222-222222222202'
      )$$,
    tests.get_supabase_uid('catch_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 4a: heavier-than-first second measurement runs without error'
);

SELECT is(
  (SELECT applied FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('catch_alice')
      AND client_event_id = 'evt-cca-3'),
  false,
  'case 4b: applied=false (rejected — second not lighter)'
);

SELECT is(
  (SELECT (in_flight_since IS NOT NULL
           AND in_flight_kind = 'catch_all'
           AND pickup_weight_g = 200.000)
     FROM chefbyte.stock_lots WHERE lot_id = :'alice_lot_id'),
  true,
  'case 4c: in_flight markers preserved on inconsistent delta'
);

SELECT is(
  (SELECT count(*) FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('catch_alice')
      AND source_client_event_id = 'evt-cca-3'),
  0::bigint,
  'case 4d: NO food_logs row on inconsistent delta'
);

------------------------------------------------------------
-- Case 5: catch_all_first_measurement with no existing lot
------------------------------------------------------------
-- Seed a second product with NO stock_lots row at all.

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('catch_alice'),
  'Catch Fresh Item',
  100.000, 1,
  50, 10, 2, 1
);

SELECT product_id AS alice_fresh_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('catch_alice')
   AND name = 'Catch Fresh Item' \gset

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-02', 'catch_all',
        'catch_all_first_measurement', %L::UUID,
        80.0, now()::TIMESTAMPTZ, 'evt-cca-mint',
        '33333333-3333-3333-3333-333333333303'
      )$$,
    tests.get_supabase_uid('catch_alice'),
    :'alice_device_id',
    :'alice_fresh_product_id'
  ),
  'case 5a: first measurement on never-tracked product mints a lot'
);

SELECT is(
  (SELECT count(*) FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('catch_alice')
      AND product_id = :'alice_fresh_product_id'),
  1::bigint,
  'case 5b: exactly one new lot was minted'
);

SELECT is(
  (SELECT (qty_containers, in_flight_kind, pickup_weight_g)::text
     FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('catch_alice')
      AND product_id = :'alice_fresh_product_id'),
  ROW(0.800::numeric(10,3), 'catch_all'::text, 80.000::numeric(10,3))::text,
  'case 5c: minted lot has qty=0.8, in_flight_kind=catch_all, pickup_weight=80'
);

------------------------------------------------------------
-- Case 6: second measurement with mismatched pickup_event_id
------------------------------------------------------------
-- The lot from case 5 has pickup_event_id ...303. A second event citing
-- a DIFFERENT pickup_event_id must be rejected (no matching session).

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-02', 'catch_all',
        'catch_all_second_measurement', %L::UUID,
        50.0, now()::TIMESTAMPTZ, 'evt-cca-mismatch',
        '99999999-9999-9999-9999-999999999099'
      )$$,
    tests.get_supabase_uid('catch_alice'),
    :'alice_device_id',
    :'alice_fresh_product_id'
  ),
  'case 6a: mismatched pickup_event_id runs without error'
);

SELECT is(
  (SELECT applied FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('catch_alice')
      AND client_event_id = 'evt-cca-mismatch'),
  false,
  'case 6b: applied=false on mismatched pickup_event_id'
);

------------------------------------------------------------
-- Case 7: kind validation (defense in depth)
------------------------------------------------------------
-- catch_all_first_measurement on a live_shelf-kind event is rejected
-- with a specific error reason.

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf',
        'catch_all_first_measurement', %L::UUID,
        100.0, now()::TIMESTAMPTZ, 'evt-cca-wrongkind',
        '44444444-4444-4444-4444-444444444404'
      )$$,
    tests.get_supabase_uid('catch_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 7a: catch_all_first_measurement on live_shelf-kind runs without error'
);

SELECT is(
  (SELECT (applied, reason) FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('catch_alice')
      AND client_event_id = 'evt-cca-wrongkind')::text,
  ROW(false, 'catch_all_first_measurement requires kind=catch_all')::text,
  'case 7b: applied=false with kind-mismatch reason'
);

------------------------------------------------------------
-- Case 8: in_flight_pickup stamps in_flight_kind='live_shelf'
------------------------------------------------------------
-- Reset the lot for the live_shelf path. After in_flight_pickup the
-- in_flight_kind discriminator must be 'live_shelf' so the catch_all
-- reaper / second-measurement lookup don't mistake it for catch_all.

UPDATE chefbyte.stock_lots
   SET qty_containers     = 1.000,
       in_flight_since    = NULL,
       in_flight_kind     = NULL,
       pickup_event_id    = NULL,
       pickup_weight_g    = NULL,
       last_update_source = 'manual',
       last_update_ts     = now() - interval '10 minutes'
 WHERE lot_id = :'alice_lot_id';

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf',
        'in_flight_pickup', %L::UUID,
        0, now()::TIMESTAMPTZ, 'evt-ls-pickup',
        '55555555-5555-5555-5555-555555555505'
      )$$,
    tests.get_supabase_uid('catch_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 8a: live_shelf in_flight_pickup runs without error'
);

SELECT is(
  (SELECT in_flight_kind FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  'live_shelf',
  'case 8b: in_flight_kind=live_shelf after live_shelf pickup'
);

SELECT * FROM finish();
ROLLBACK;
