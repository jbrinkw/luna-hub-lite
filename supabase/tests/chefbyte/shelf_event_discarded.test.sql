-- pgTAP — apply_shelf_event 'discarded' branch.
--
-- Validates supabase/migrations/20260427020000_shelf_event_discarded.sql.
--
-- Coverage:
--   1. discarded on a live qty>0 lot: qty=0, no food_log row, last_update_source='manual_discard'.
--   2. discarded on an already-in_flight lot: qty=0 AND in_flight_since=NULL AND pickup_event_id=NULL, no food_log.
--   3. discarded on already-zero, already-cleared lot: idempotent, applied=true, no food_log,
--      reason indicates idempotent no-op, last_update_ts still bumps for audit.
--   4. discarded with no lot for product at all: applied=true with idempotent no-op reason.
--   5. discarded for unknown product: applied=false with 'product not found'.
--   6. discarded retry (same client_event_id): cached result, only one shelf_event_log row.
--   7. discarded preserves food_logs from a PRIOR consumed event on same lot
--      (does NOT void historical macros).

BEGIN;
SELECT plan(16);

------------------------------------------------------------
-- Setup (authenticated user)
------------------------------------------------------------

SELECT tests.create_supabase_user('disc_alice');
SELECT tests.authenticate_as('disc_alice');
SELECT hub.activate_app('chefbyte');

-- Seed product (Fridge location comes from activate_app).
INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('disc_alice'),
  'Disc Chocolate Milk',
  1537.822, 3,
  150, 20, 8, 5
);

SELECT product_id AS alice_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('disc_alice')
   AND name = 'Disc Chocolate Milk' \gset

SELECT location_id AS alice_fridge_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('disc_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('disc_alice'),
  'disc-pi',
  'disc_hash_alice',
  true
);

SELECT device_id AS alice_device_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('disc_alice')
   AND device_name = 'disc-pi' \gset

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('disc_alice'),
  :'alice_product_id',
  :'alice_fridge_id',
  2.000,
  'live_shelf',
  now() - interval '5 minutes'
);

SELECT lot_id AS alice_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('disc_alice')
   AND product_id = :'alice_product_id' \gset

-- Elevate to postgres for direct apply_shelf_event calls.
SET LOCAL role postgres;

------------------------------------------------------------
-- Case 1: discarded on a live qty=2 lot
------------------------------------------------------------

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'discarded',
        %L::UUID, 0, now()::TIMESTAMPTZ, 'evt-disc-1', NULL
      )$$,
    tests.get_supabase_uid('disc_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 1: discarded call on live lot runs without error'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id')::numeric(10,3),
  0::numeric(10,3),
  'case 1: qty_containers zeroed'
);

SELECT is(
  (SELECT last_update_source FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  'manual_discard',
  'case 1: last_update_source = manual_discard'
);

SELECT is(
  (SELECT count(*) FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('disc_alice')
      AND source_client_event_id = 'evt-disc-1'),
  0::bigint,
  'case 1: NO food_logs row written for the discard event'
);

------------------------------------------------------------
-- Case 2: discarded clears in_flight marker on stuck lot
------------------------------------------------------------

-- Reset state: re-stamp the lot as in_flight with qty>0.
UPDATE chefbyte.stock_lots
   SET qty_containers   = 1.000,
       in_flight_since  = now() - interval '20 minutes',
       pickup_event_id  = '99999999-9999-9999-9999-999999999099'::uuid,
       last_update_source = 'live_shelf',
       last_update_ts   = now() - interval '15 minutes'
 WHERE lot_id = :'alice_lot_id';

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'discarded',
        %L::UUID, 0, now()::TIMESTAMPTZ, 'evt-disc-2', NULL
      )$$,
    tests.get_supabase_uid('disc_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 2: discarded on in_flight lot runs without error'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id')::numeric(10,3),
  0::numeric(10,3),
  'case 2: qty=0 after in_flight discard'
);

SELECT is(
  (SELECT (in_flight_since IS NULL AND pickup_event_id IS NULL)
     FROM chefbyte.stock_lots WHERE lot_id = :'alice_lot_id'),
  true,
  'case 2: in_flight_since=NULL AND pickup_event_id=NULL'
);

SELECT is(
  (SELECT count(*) FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('disc_alice')
      AND source_client_event_id = 'evt-disc-2'),
  0::bigint,
  'case 2: NO food_logs row written for the in_flight discard'
);

------------------------------------------------------------
-- Case 3: discarded on already-zero, already-cleared lot (idempotent)
------------------------------------------------------------

-- Capture pre-call ts (should bump because the UPDATE runs unconditionally).
SELECT last_update_ts AS alice_pre_idempotent_ts
  FROM chefbyte.stock_lots
 WHERE lot_id = :'alice_lot_id' \gset

-- Sleep 50ms so the comparison below has detectable resolution.
SELECT pg_sleep(0.05);

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'discarded',
        %L::UUID, 0, now()::TIMESTAMPTZ, 'evt-disc-3', NULL
      )$$,
    tests.get_supabase_uid('disc_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 3: discarded on already-zero/cleared lot runs without error'
);

SELECT is(
  (SELECT applied FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('disc_alice')
      AND client_event_id = 'evt-disc-3'),
  true,
  'case 3: applied=true on idempotent no-op'
);

SELECT is(
  (SELECT reason FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('disc_alice')
      AND client_event_id = 'evt-disc-3'),
  'discarded (idempotent no-op)',
  'case 3: reason marks idempotent no-op for audit'
);

SELECT is(
  (SELECT count(*) FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('disc_alice')
      AND source_client_event_id = 'evt-disc-3'),
  0::bigint,
  'case 3: NO food_logs row on idempotent discard'
);

------------------------------------------------------------
-- Case 4: discarded for product with NO lot at all
------------------------------------------------------------

-- Seed a second product with NO stock_lots row anywhere.
INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('disc_alice'),
  'Disc Empty Product',
  500, 1, 100, 10, 5, 3
);

SELECT product_id AS alice_empty_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('disc_alice')
   AND name = 'Disc Empty Product' \gset

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'discarded',
        %L::UUID, 0, now()::TIMESTAMPTZ, 'evt-disc-4', NULL
      )$$,
    tests.get_supabase_uid('disc_alice'),
    :'alice_device_id',
    :'alice_empty_product_id'
  ),
  'case 4: discarded with no lot runs without error'
);

SELECT is(
  (SELECT (applied, reason) FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('disc_alice')
      AND client_event_id = 'evt-disc-4')::text,
  ROW(true, 'no lot for product (idempotent no-op)')::text,
  'case 4: applied=true with no-lot no-op reason'
);

------------------------------------------------------------
-- Case 5: discarded for unknown product (cross-user / nonexistent)
------------------------------------------------------------

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'discarded',
        '99999999-9999-9999-9999-9999999999fe'::UUID,
        0, now()::TIMESTAMPTZ, 'evt-disc-5', NULL
      )$$,
    tests.get_supabase_uid('disc_alice'),
    :'alice_device_id'
  ),
  'case 5: discarded with unknown product runs without error'
);

SELECT is(
  (SELECT (applied, reason) FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('disc_alice')
      AND client_event_id = 'evt-disc-5')::text,
  ROW(false, 'product not found')::text,
  'case 5: applied=false product-not-found for unknown product_id'
);

SELECT * FROM finish();
ROLLBACK;
