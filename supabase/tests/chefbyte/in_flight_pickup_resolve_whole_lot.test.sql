-- pgTAP — consumed-event whole-lot removal when pickup_event_id matches.
--
-- Validates supabase/migrations/20260427010000_in_flight_pickup_resolve_whole_lot.sql.
--
-- User directive 2026-04-27: a TTL-expired in-flight pickup must remove
-- the WHOLE lot, not a fractional weight-measured decrement. This fixes
-- the divergence where the reaper emitted consumed with pickup_weight_g
-- translating to e.g. -0.306 containers instead of the full 1.000,
-- leaving a phantom qty. The fix keys on p_pi_event_id == lot.pickup_event_id.
--
-- Coverage:
--   1. consumed event with pi_event_id matching pickup_event_id zeros qty.
--   2. consumed event with pi_event_id matching pickup_event_id clears
--      in_flight_since + pickup_event_id.
--   3. Fractional delta_g still produces qty=0 (drift tolerance).
--   4. consumed event WITHOUT pickup match keeps fractional decrement
--      (non-in-flight path unchanged).
--   5. After whole-lot removal, an `added` event revives the empty lot
--      (qty flips 0 → N) via resolve_add_to_shelf_lot's step-4.
--   6. Food_logs row still written for the Pi-reported consumption mass.

BEGIN;
SELECT plan(9);

------------------------------------------------------------
-- Setup (authenticated user — mirrors shelf_event_in_flight_pickup.test.sql)
------------------------------------------------------------

SELECT tests.create_supabase_user('whole_lot_alice');
SELECT tests.authenticate_as('whole_lot_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('whole_lot_alice'),
  'Whole Lot Chocolate Milk',
  1537.822, 3,
  150, 20, 8, 5
);

SELECT product_id AS alice_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('whole_lot_alice')
   AND name = 'Whole Lot Chocolate Milk' \gset

SELECT location_id AS alice_fridge_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('whole_lot_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('whole_lot_alice'),
  'whole-lot-pi',
  'whole_lot_hash_alice',
  true
);

SELECT device_id AS alice_device_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('whole_lot_alice')
   AND device_name = 'whole-lot-pi' \gset

-- Seed stock_lot already stamped as in-flight (mirrors the state after
-- an in_flight_pickup event landed). Pickup event id matches what we'll
-- send in the consumed event below.
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts,
  in_flight_since, pickup_event_id
) VALUES (
  tests.get_supabase_uid('whole_lot_alice'),
  :'alice_product_id',
  :'alice_fridge_id',
  1.000,                       -- full container in flight
  'live_shelf',
  now() - interval '4 hours',  -- TTL expired already
  now() - interval '4 hours',
  '11111111-1111-1111-1111-111111111111'
);

SELECT lot_id AS alice_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('whole_lot_alice')
   AND product_id = :'alice_product_id' \gset

SET LOCAL role postgres;

------------------------------------------------------------
-- Case 1 + 2 + 3: consumed event with matching pickup_event_id
--   zeros the WHOLE lot regardless of fractional delta_g
------------------------------------------------------------

-- Emit a consumed event with delta_g = -472g (~0.306 containers —
-- the fractional amount the Pi actually measured). This would normally
-- decrement qty from 1.000 → 0.694. Whole-lot semantics should take it
-- all the way to 0 because pickup_event_id matches.
SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'consumed',
        %L::UUID, -472.0, now()::TIMESTAMPTZ, 'evt-consumed-whole-1',
        '11111111-1111-1111-1111-111111111111'
      )$$,
    tests.get_supabase_uid('whole_lot_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 1: consumed event with matching pickup_event_id runs without error'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id')::numeric(10,3),
  0.000::numeric(10,3),
  'case 1: qty_containers zeroed completely (whole-lot removal)'
);

SELECT is(
  (SELECT in_flight_since FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  NULL,
  'case 2: in_flight_since cleared on pickup-close'
);

SELECT is(
  (SELECT pickup_event_id FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  NULL,
  'case 2: pickup_event_id cleared on pickup-close'
);

SELECT is(
  (SELECT reason FROM chefbyte.shelf_event_log
    WHERE client_event_id = 'evt-consumed-whole-1'),
  'pickup_close_whole_lot',
  'case 3: shelf_event_log reason marks the whole-lot branch'
);

------------------------------------------------------------
-- Case 4: food_logs row was still written for the fractional mass
------------------------------------------------------------

-- 472g / 1537.822g = ~0.3069 containers × 3 servings_per = ~0.92 servings
SELECT ok(
  (SELECT qty_consumed FROM chefbyte.food_logs
    WHERE source_client_event_id = 'evt-consumed-whole-1') > 0,
  'case 4: food_logs row written despite whole-lot removal'
);

------------------------------------------------------------
-- Case 5: place-back revival via empty-lot reuse
------------------------------------------------------------

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'added',
        %L::UUID, 1537.822, now()::TIMESTAMPTZ, 'evt-added-revive-1', NULL
      )$$,
    tests.get_supabase_uid('whole_lot_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 5: added event (place-back) runs without error after whole-lot removal'
);

-- Revival path should NOT mint a new lot (same row is reused).
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('whole_lot_alice')
      AND product_id = :'alice_product_id'),
  1,
  'case 5: still exactly one lot row (revival reused existing, no mint)'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id')::numeric(10,3),
  1.000::numeric(10,3),
  'case 5: qty revived to 1.000 from place-back (1537.822g / net_weight_g)'
);

SELECT * FROM finish();
ROLLBACK;
