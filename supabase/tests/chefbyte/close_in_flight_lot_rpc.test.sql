-- pgTAP — chefbyte.close_in_flight_lot manual-resolution RPC.
--
-- Validates supabase/migrations/20260427110000_close_in_flight_lot_rpc.sql.
--
-- Coverage matrix (per resolution):
--   * discarded:
--       - qty zeroed
--       - in_flight_since cleared, pickup_event_id cleared
--       - last_update_source = 'manual_discard'
--       - NO food_logs row written
--       - shelf_event_log audit row exists with reason='discarded' + note
--   * consumed:
--       - qty zeroed
--       - in_flight markers cleared
--       - last_update_source = 'manual_consume'
--       - food_logs row WRITTEN with macros = qty_pre × per-serving × svg_per
--       - audit row exists with reason='consumed'
--   * returned:
--       - qty PRESERVED (still on shelf)
--       - in_flight markers cleared
--       - last_update_source = 'manual_return'
--       - NO food_logs row
--       - audit row exists with reason='returned'
--
-- Validation:
--   * Invalid resolution literal raises (22023).
--   * Lot without in_flight_since IS NOT NULL raises ('lot is not in-flight').
--   * Cross-user attempt raises ('lot not found') under bob's auth context.

BEGIN;
SELECT plan(29);

------------------------------------------------------------
-- Setup user 'alice' with a product, location, and lot
------------------------------------------------------------

SELECT tests.create_supabase_user('close_alice');
SELECT tests.authenticate_as('close_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name,
  net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('close_alice'),
  'Close Chocolate Milk',
  1537.822, 4,
  100, 12, 8, 2
);

SELECT product_id AS alice_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('close_alice')
   AND name = 'Close Chocolate Milk' \gset

SELECT location_id AS alice_loc_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('close_alice')
   AND name = 'Fridge' \gset

------------------------------------------------------------
-- Helper: re-create an in-flight lot in known state
------------------------------------------------------------
-- Using a simple INSERT/UPDATE between cases — avoids cumulative state
-- assertions across cases.

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  in_flight_since, pickup_event_id,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('close_alice'),
  :'alice_product_id',
  :'alice_loc_id',
  2.000,
  now() - interval '20 minutes',
  '11111111-1111-1111-1111-111111111111'::uuid,
  'live_shelf',
  now() - interval '15 minutes'
);

SELECT lot_id AS alice_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('close_alice')
   AND product_id = :'alice_product_id' \gset

------------------------------------------------------------
-- Case 1: discarded
------------------------------------------------------------

SELECT lives_ok(
  format(
    $$SELECT chefbyte.close_in_flight_lot(%L::UUID, 'discarded', 'spilled in fridge')$$,
    :'alice_lot_id'
  ),
  'case 1: discarded RPC runs without error'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id')::numeric(10,3),
  0::numeric(10,3),
  'case 1: qty_containers zeroed'
);

SELECT is(
  (SELECT (in_flight_since IS NULL AND pickup_event_id IS NULL)
     FROM chefbyte.stock_lots WHERE lot_id = :'alice_lot_id'),
  true,
  'case 1: in_flight_since AND pickup_event_id cleared'
);

SELECT is(
  (SELECT last_update_source FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  'manual_discard',
  'case 1: last_update_source = manual_discard'
);

SELECT is(
  (SELECT count(*) FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('close_alice')
      AND product_id = :'alice_product_id'),
  0::bigint,
  'case 1: NO food_logs row written for discard'
);

SELECT is(
  (SELECT count(*) FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('close_alice')
      AND reason = 'discarded'
      AND payload->>'event_kind' = 'discarded'
      AND payload->>'note' = 'spilled in fridge'
      AND (payload->>'lot_id')::uuid = :'alice_lot_id'::uuid),
  1::bigint,
  'case 1: audit row recorded with note + lot_id in payload'
);

------------------------------------------------------------
-- Case 2: consumed (writes food_logs)
------------------------------------------------------------

-- Reset the lot to in-flight state with qty=2 — qty_pre will be 2.
UPDATE chefbyte.stock_lots
   SET qty_containers   = 2.000,
       in_flight_since  = now() - interval '10 minutes',
       pickup_event_id  = '22222222-2222-2222-2222-222222222222'::uuid,
       last_update_source = 'live_shelf',
       last_update_ts   = now() - interval '5 minutes'
 WHERE lot_id = :'alice_lot_id';

SELECT lives_ok(
  format(
    $$SELECT chefbyte.close_in_flight_lot(%L::UUID, 'consumed', 'ate it on the run')$$,
    :'alice_lot_id'
  ),
  'case 2: consumed RPC runs without error'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id')::numeric(10,3),
  0::numeric(10,3),
  'case 2: qty zeroed after consumed'
);

SELECT is(
  (SELECT (in_flight_since IS NULL AND pickup_event_id IS NULL)
     FROM chefbyte.stock_lots WHERE lot_id = :'alice_lot_id'),
  true,
  'case 2: in_flight markers cleared after consumed'
);

SELECT is(
  (SELECT last_update_source FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  'manual_consume',
  'case 2: last_update_source = manual_consume'
);

-- 2 containers × 4 svg/ctn = 8 servings consumed. macros = 8 × per-serving.
-- (cal=100, carbs=12, protein=8, fat=2)
SELECT is(
  (SELECT qty_consumed FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('close_alice')
      AND product_id = :'alice_product_id'
    ORDER BY created_at DESC LIMIT 1)::numeric(10,3),
  8.000::numeric(10,3),
  'case 2: food_logs.qty_consumed = 8 servings (2 ctn × 4 svg/ctn)'
);

SELECT is(
  (SELECT calories FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('close_alice')
      AND product_id = :'alice_product_id'
    ORDER BY created_at DESC LIMIT 1)::numeric(10,3),
  800.000::numeric(10,3),
  'case 2: food_logs.calories = 8 × 100 = 800'
);

SELECT is(
  (SELECT (carbs, protein, fat) FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('close_alice')
      AND product_id = :'alice_product_id'
    ORDER BY created_at DESC LIMIT 1)::text,
  ROW(96.000::numeric(10,3), 64.000::numeric(10,3), 16.000::numeric(10,3))::text,
  'case 2: food_logs macros = 8 × per-serving rates'
);

SELECT is(
  (SELECT count(*) FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('close_alice')
      AND reason = 'consumed'
      AND payload->>'event_kind' = 'consumed'
      AND payload->>'note' = 'ate it on the run'),
  1::bigint,
  'case 2: audit row recorded for consumed branch'
);

------------------------------------------------------------
-- Case 3: returned (preserves qty)
------------------------------------------------------------

-- Reset: set qty back to 2 + in-flight
UPDATE chefbyte.stock_lots
   SET qty_containers   = 2.000,
       in_flight_since  = now() - interval '5 minutes',
       pickup_event_id  = '33333333-3333-3333-3333-333333333333'::uuid,
       last_update_source = 'live_shelf',
       last_update_ts   = now() - interval '3 minutes'
 WHERE lot_id = :'alice_lot_id';

-- Snapshot food_logs count BEFORE the call so we can prove no row was added.
SELECT count(*) AS food_log_count_pre
  FROM chefbyte.food_logs
 WHERE user_id = tests.get_supabase_uid('close_alice')
   AND product_id = :'alice_product_id' \gset

SELECT lives_ok(
  format(
    $$SELECT chefbyte.close_in_flight_lot(%L::UUID, 'returned', 'false alarm — still on shelf')$$,
    :'alice_lot_id'
  ),
  'case 3: returned RPC runs without error'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id')::numeric(10,3),
  2.000::numeric(10,3),
  'case 3: qty_containers PRESERVED (returned does not zero)'
);

SELECT is(
  (SELECT (in_flight_since IS NULL AND pickup_event_id IS NULL)
     FROM chefbyte.stock_lots WHERE lot_id = :'alice_lot_id'),
  true,
  'case 3: in_flight markers cleared after returned'
);

SELECT is(
  (SELECT last_update_source FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  'manual_return',
  'case 3: last_update_source = manual_return'
);

SELECT is(
  (SELECT count(*) FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('close_alice')
      AND product_id = :'alice_product_id'),
  :'food_log_count_pre'::bigint,
  'case 3: NO new food_logs row written for returned'
);

SELECT is(
  (SELECT count(*) FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('close_alice')
      AND reason = 'returned'
      AND payload->>'event_kind' = 'returned'
      AND payload->>'note' = 'false alarm — still on shelf'),
  1::bigint,
  'case 3: audit row recorded for returned branch'
);

------------------------------------------------------------
-- Case 4: validation — invalid resolution literal
------------------------------------------------------------

-- Re-stamp lot in-flight so the validation guard isn't masked by the
-- "lot is not in-flight" guard (which fires earlier in the function).
UPDATE chefbyte.stock_lots
   SET qty_containers   = 1.000,
       in_flight_since  = now() - interval '1 minute',
       pickup_event_id  = '44444444-4444-4444-4444-444444444444'::uuid,
       last_update_source = 'live_shelf',
       last_update_ts   = now() - interval '30 seconds'
 WHERE lot_id = :'alice_lot_id';

SELECT throws_ok(
  format(
    $$SELECT chefbyte.close_in_flight_lot(%L::UUID, 'totally_invalid', NULL)$$,
    :'alice_lot_id'
  ),
  '22023',
  NULL,
  'case 4: invalid resolution literal raises 22023'
);

------------------------------------------------------------
-- Case 5: validation — lot is NOT in-flight
------------------------------------------------------------

-- Clear the in-flight markers so the next call hits the not-in-flight guard.
UPDATE chefbyte.stock_lots
   SET in_flight_since  = NULL,
       pickup_event_id  = NULL,
       qty_containers   = 1.000
 WHERE lot_id = :'alice_lot_id';

SELECT throws_ok(
  format(
    $$SELECT chefbyte.close_in_flight_lot(%L::UUID, 'discarded', NULL)$$,
    :'alice_lot_id'
  ),
  '22023',
  NULL,
  'case 5: lot is not in-flight raises 22023'
);

------------------------------------------------------------
-- Case 6: cross-user RLS — bob can't close alice's lot
------------------------------------------------------------

-- Re-stamp alice's lot back to in-flight.
UPDATE chefbyte.stock_lots
   SET qty_containers   = 1.000,
       in_flight_since  = now() - interval '2 minutes',
       pickup_event_id  = '55555555-5555-5555-5555-555555555555'::uuid,
       last_update_source = 'live_shelf',
       last_update_ts   = now() - interval '1 minute'
 WHERE lot_id = :'alice_lot_id';

SELECT tests.create_supabase_user('close_bob');
SELECT tests.authenticate_as('close_bob');
SELECT hub.activate_app('chefbyte');

SELECT throws_ok(
  format(
    $$SELECT chefbyte.close_in_flight_lot(%L::UUID, 'discarded', 'should fail')$$,
    :'alice_lot_id'
  ),
  '22023',
  NULL,
  'case 6: cross-user attempt raises lot-not-found (RLS-equivalent guard)'
);

------------------------------------------------------------
-- Case 7: re-auth as alice + confirm her lot was NOT mutated by bob's
--          failed attempt. The select must run under alice's auth so RLS
--          allows the row to be visible.
------------------------------------------------------------

SELECT tests.authenticate_as('close_alice');

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id')::numeric(10,3),
  1.000::numeric(10,3),
  'case 7a: alice lot qty unchanged after bob attempt'
);

SELECT is(
  (SELECT in_flight_since IS NOT NULL FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  true,
  'case 7a: alice lot in_flight_since unchanged after bob attempt'
);

------------------------------------------------------------
-- Case 7b: NULL note still works (note is optional)
------------------------------------------------------------

SELECT lives_ok(
  format(
    $$SELECT chefbyte.close_in_flight_lot(%L::UUID, 'discarded', NULL)$$,
    :'alice_lot_id'
  ),
  'case 7: NULL note accepted'
);

SELECT is(
  (SELECT count(*) FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('close_alice')
      AND payload->>'note' IS NULL
      AND reason = 'discarded'),
  1::bigint,
  'case 7: audit row written with NULL note'
);

------------------------------------------------------------
-- Case 8: returned does NOT write food_logs even with qty>0
------------------------------------------------------------
-- Negative-control: the spec is explicit that returned never logs macros.
-- Set up an in-flight lot with qty>0 and verify food_logs count delta = 0.

UPDATE chefbyte.stock_lots
   SET qty_containers   = 3.000,
       in_flight_since  = now() - interval '2 minutes',
       pickup_event_id  = '66666666-6666-6666-6666-666666666666'::uuid,
       last_update_source = 'live_shelf',
       last_update_ts   = now() - interval '1 minute'
 WHERE lot_id = :'alice_lot_id';

SELECT count(*) AS pre_returned_count
  FROM chefbyte.food_logs
 WHERE user_id = tests.get_supabase_uid('close_alice') \gset

SELECT chefbyte.close_in_flight_lot(:'alice_lot_id'::uuid, 'returned', 'shelf glitch')
  AS _ignore_returned_event_id \gset

SELECT is(
  (SELECT count(*) FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('close_alice')),
  :'pre_returned_count'::bigint,
  'case 8: returned with qty>0 still does NOT write food_logs'
);

------------------------------------------------------------
-- Case 9: discarded does NOT write food_logs even with qty>0
------------------------------------------------------------

UPDATE chefbyte.stock_lots
   SET qty_containers   = 5.000,
       in_flight_since  = now() - interval '2 minutes',
       pickup_event_id  = '77777777-7777-7777-7777-777777777777'::uuid,
       last_update_source = 'live_shelf',
       last_update_ts   = now() - interval '1 minute'
 WHERE lot_id = :'alice_lot_id';

SELECT count(*) AS pre_discard_count
  FROM chefbyte.food_logs
 WHERE user_id = tests.get_supabase_uid('close_alice') \gset

SELECT chefbyte.close_in_flight_lot(:'alice_lot_id'::uuid, 'discarded', 'spilled')
  AS _ignore_discard_event_id \gset

SELECT is(
  (SELECT count(*) FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('close_alice')),
  :'pre_discard_count'::bigint,
  'case 9: discarded with qty>0 still does NOT write food_logs'
);

SELECT * FROM finish();
ROLLBACK;
