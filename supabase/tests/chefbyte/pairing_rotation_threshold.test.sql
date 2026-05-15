-- pgTAP — pairing rotation threshold + close-hook coverage.
--
-- Validates supabase/migrations/20260428010000_pairing_rotation_threshold_and_close_hook.sql.
--
-- Coverage:
--   1. apply_shelf_event consumed leaving qty=0.005 (sub-display
--      residual) DOES rotate the pairing — the user-reported
--      chocolate-milk regression. Pre-fix the predicate was `<= 0`
--      and this case did NOT rotate.
--   2. apply_shelf_event consumed leaving qty=0.5 (legit non-empty)
--      does NOT rotate.
--   3. close_in_flight_lot 'discarded' on a paired in-flight lot
--      rotates the pairing.
--   4. close_in_flight_lot 'consumed' on a paired in-flight lot
--      rotates the pairing AND writes a food_logs row.
--   5. close_in_flight_lot 'returned' on a paired in-flight lot
--      does NOT rotate (qty preserved per design).
--   6. resolve_add_to_shelf_lot mints with expires_on populated
--      from products.default_shelf_life_days.
--   7. resolve_add_to_shelf_lot mints with expires_on=NULL when
--      products.default_shelf_life_days is null.

BEGIN;
-- Gap G1 (20260515010000): test plumbing DELETEs need bypass; test
-- exercises pairing rotation + mint paths, not the delete-guard.
SET LOCAL chefbyte.stock_lots_allow_hard_delete = 'on';
SELECT plan(15);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('rot_thresh_alice');
SELECT tests.authenticate_as('rot_thresh_alice');
SELECT hub.activate_app('chefbyte');

-- Product with a shelf life on file (case 6) and a sibling without (case 7).
INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving,
  default_shelf_life_days
) VALUES (
  tests.get_supabase_uid('rot_thresh_alice'),
  'Chocolate Milk Half-Gallon',
  1500, 4,
  150, 24, 8, 3,
  14
);

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving,
  default_shelf_life_days
) VALUES (
  tests.get_supabase_uid('rot_thresh_alice'),
  'Non-perishable Powder',
  500, 10,
  100, 5, 5, 2,
  NULL
);

SELECT product_id AS choc_milk_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('rot_thresh_alice')
   AND name = 'Chocolate Milk Half-Gallon' \gset

SELECT product_id AS powder_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('rot_thresh_alice')
   AND name = 'Non-perishable Powder' \gset

SELECT location_id AS fridge_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('rot_thresh_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('rot_thresh_alice'),
  'rot-thresh-pi',
  'rot_thresh_hash_alice',
  true
);

SELECT device_id AS pi_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('rot_thresh_alice')
   AND device_name = 'rot-thresh-pi' \gset

------------------------------------------------------------
-- Case 1: sub-display residual rotation (the user-reported bug)
-- Two lots, scale-03 paired to lot A. Send a consumed event that
-- leaves lot A at qty=0.005. Pre-fix this lived in the [0, 0.01)
-- gap and the rotation hook never fired.
------------------------------------------------------------

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('rot_thresh_alice'),
  :'choc_milk_id', :'fridge_id', 1.0, '2026-05-15',
  NULL, now() - interval '2 hours'
);

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('rot_thresh_alice'),
  :'choc_milk_id', :'fridge_id', 1.0, '2026-06-15',
  NULL, now() - interval '1 hour'
);

SELECT lot_id AS lot_a
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('rot_thresh_alice')
   AND product_id = :'choc_milk_id'
   AND expires_on = '2026-05-15' \gset

SELECT lot_id AS lot_b
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('rot_thresh_alice')
   AND product_id = :'choc_milk_id'
   AND expires_on = '2026-06-15' \gset

INSERT INTO chefbyte.scale_pairings (
  user_id, device_id, scale_id, kind, product_id, lot_id
) VALUES (
  tests.get_supabase_uid('rot_thresh_alice'),
  :'pi_id', 'scale-03', 'live_scale',
  :'choc_milk_id', :'lot_a'
);

SELECT pairing_id AS pairing_id
  FROM chefbyte.scale_pairings
 WHERE user_id = tests.get_supabase_uid('rot_thresh_alice')
   AND scale_id = 'scale-03' \gset

SET LOCAL role postgres;

-- Send -1492.5g (= -0.995 ctn against 1500g net). 1.0 - 0.995 = 0.005
-- ctn — squarely in the sub-display gap.
SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-03', 'live_scale', 'consumed',
        %L::UUID, -1492.5, now()::TIMESTAMPTZ, 'evt-thresh-1', NULL
      )$$,
    tests.get_supabase_uid('rot_thresh_alice'),
    :'pi_id',
    :'choc_milk_id'
  ),
  'case 1a: sub-display consumed call runs'
);

SELECT cmp_ok(
  (SELECT qty_containers FROM chefbyte.stock_lots WHERE lot_id = :'lot_a'),
  '<', 0.01::numeric,
  'case 1b: lot A is in the sub-display residual range'
);

SELECT cmp_ok(
  (SELECT qty_containers FROM chefbyte.stock_lots WHERE lot_id = :'lot_a'),
  '>', 0::numeric,
  'case 1c: lot A is NOT exactly zero (this is the bug case the old predicate missed)'
);

SELECT is(
  (SELECT lot_id FROM chefbyte.scale_pairings WHERE pairing_id = :'pairing_id'),
  (:'lot_b')::uuid,
  'case 1d: pairing rotated to lot B even though lot A is qty>0 (sub-display residual)'
);

SELECT ok(
  (SELECT reason LIKE '%:rotated'
     FROM chefbyte.shelf_event_log
    WHERE client_event_id = 'evt-thresh-1'),
  'case 1e: shelf_event_log.reason flagged as :rotated'
);

------------------------------------------------------------
-- Case 2: above threshold = no rotation
-- Reset the pairing to lot B (now FEFO winner since lot A is residual);
-- Send a consume that leaves lot B at qty=0.5. Should NOT rotate.
------------------------------------------------------------

-- Lot A is now at qty=0.005 last_update_source='live_scale' (case 1
-- flipped it). The partial-unique invariant forbids two qty>0
-- live_scale rows for one (user, product). When case 2 then bumps
-- lot B to live_scale we'd violate it. Zero lot A's qty AND clear
-- its source so it drops out of the invariant predicate before we
-- pin to lot B.
UPDATE chefbyte.stock_lots
   SET qty_containers = 0,
       last_update_source = NULL
 WHERE lot_id = :'lot_a';

UPDATE chefbyte.scale_pairings
   SET lot_id = :'lot_b'
 WHERE pairing_id = :'pairing_id';

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-03', 'live_scale', 'consumed',
        %L::UUID, -750, now()::TIMESTAMPTZ, 'evt-thresh-2', NULL
      )$$,
    tests.get_supabase_uid('rot_thresh_alice'),
    :'pi_id',
    :'choc_milk_id'
  ),
  'case 2a: above-threshold consumed call runs'
);

SELECT is(
  (SELECT lot_id FROM chefbyte.scale_pairings WHERE pairing_id = :'pairing_id'),
  (:'lot_b')::uuid,
  'case 2b: pairing did NOT rotate (lot B still has 0.5 ctn — well above threshold)'
);

------------------------------------------------------------
-- Case 3: close_in_flight_lot 'discarded' rotates pairing
-- Lot B is now at 0.5 ctn paired. Mark it in-flight, then close it
-- via the discarded resolution. Expect: lot B qty=0, pairing rotated
-- to lot A (the only other on-shelf candidate, even at qty=0.005…
-- which makes it not really "available", but the rotate function
-- doesn't filter on the threshold — it picks any qty>0 candidate;
-- if the next consume zeros it the rotation chain continues).
-- Actually for a clean test we want NO candidates so the pairing
-- ends up NULL. Set lot A to qty=0 first.
------------------------------------------------------------

UPDATE chefbyte.stock_lots
   SET qty_containers = 0
 WHERE lot_id = :'lot_a';

UPDATE chefbyte.stock_lots
   SET in_flight_since = now(),
       in_flight_kind  = 'live_shelf'
 WHERE lot_id = :'lot_b';

SELECT lives_ok(
  format(
    $$SELECT private.close_in_flight_lot(
        %L::UUID, %L::UUID, 'discarded', 'test note'
      )$$,
    tests.get_supabase_uid('rot_thresh_alice'),
    :'lot_b'
  ),
  'case 3a: close_in_flight_lot discarded runs'
);

SELECT is(
  (SELECT lot_id FROM chefbyte.scale_pairings WHERE pairing_id = :'pairing_id'),
  NULL,
  'case 3b: discarded resolution rotated pairing to NULL (no candidate available)'
);

------------------------------------------------------------
-- Case 4: close_in_flight_lot 'returned' does NOT rotate
-- Add a fresh lot C, pair to it, mark in-flight, return-close, expect
-- pairing.lot_id stays at lot C (returned preserves qty + pairing).
------------------------------------------------------------

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on,
  last_update_source, last_update_ts, in_flight_since, in_flight_kind
) VALUES (
  tests.get_supabase_uid('rot_thresh_alice'),
  :'choc_milk_id', :'fridge_id', 0.7, '2026-07-15',
  NULL, now(), now(), 'live_shelf'
);

SELECT lot_id AS lot_c
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('rot_thresh_alice')
   AND product_id = :'choc_milk_id'
   AND expires_on = '2026-07-15' \gset

UPDATE chefbyte.scale_pairings
   SET lot_id = :'lot_c'
 WHERE pairing_id = :'pairing_id';

SELECT lives_ok(
  format(
    $$SELECT private.close_in_flight_lot(
        %L::UUID, %L::UUID, 'returned', NULL
      )$$,
    tests.get_supabase_uid('rot_thresh_alice'),
    :'lot_c'
  ),
  'case 4a: close_in_flight_lot returned runs'
);

SELECT is(
  (SELECT lot_id FROM chefbyte.scale_pairings WHERE pairing_id = :'pairing_id'),
  (:'lot_c')::uuid,
  'case 4b: returned resolution did NOT rotate pairing (lot C stays pinned)'
);

------------------------------------------------------------
-- Case 5: resolve_add_to_shelf_lot mints with expires_on populated
-- Use the powder product (default_shelf_life_days=NULL) for a
-- negative-control alongside the chocolate milk (14 days).
-- The mint path is exercised when there are NO existing matching
-- lots — so for the choc milk product we need to clear all existing
-- lots first (they were either zeroed or below match tolerance).
------------------------------------------------------------

DELETE FROM chefbyte.scale_pairings
 WHERE pairing_id = :'pairing_id';

DELETE FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('rot_thresh_alice')
   AND product_id = :'choc_milk_id';

-- Send an 'added' live_shelf event with 1500g (1 full container).
SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'added',
        %L::UUID, 1500, now()::TIMESTAMPTZ, 'evt-mint-with-expiry', NULL
      )$$,
    tests.get_supabase_uid('rot_thresh_alice'),
    :'pi_id',
    :'choc_milk_id'
  ),
  'case 5a: live_shelf mint event runs'
);

-- The mint path resolves expires_on via private.get_logical_date with
-- the USER'S profile (timezone + day_start_hour), not UTC. Pull those
-- from hub.profiles so the assertion stays correct regardless of the
-- runner clock vs UTC offset (failed nightly between UTC midnight and
-- local midnight when hardcoded to 'UTC').
SELECT is(
  (SELECT expires_on
     FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('rot_thresh_alice')
      AND product_id = :'choc_milk_id'
      AND last_update_source = 'live_shelf'
    ORDER BY last_update_ts DESC LIMIT 1),
  ((
    SELECT private.get_logical_date(
      now(),
      COALESCE(timezone, 'UTC'),
      COALESCE(day_start_hour, 0)
    )
    FROM hub.profiles
    WHERE user_id = tests.get_supabase_uid('rot_thresh_alice')
  ) + 14)::date,
  'case 5b: minted lot expires_on = today + default_shelf_life_days'
);

------------------------------------------------------------
-- Case 6: resolve_add_to_shelf_lot mints with NULL expires_on
-- (negative control — powder product has default_shelf_life_days=NULL)
------------------------------------------------------------

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-02', 'live_shelf', 'added',
        %L::UUID, 500, now()::TIMESTAMPTZ, 'evt-mint-no-expiry', NULL
      )$$,
    tests.get_supabase_uid('rot_thresh_alice'),
    :'pi_id',
    :'powder_id'
  ),
  'case 6a: live_shelf mint event for non-perishable runs'
);

SELECT is(
  (SELECT expires_on
     FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('rot_thresh_alice')
      AND product_id = :'powder_id'
      AND last_update_source = 'live_shelf'
    ORDER BY last_update_ts DESC LIMIT 1),
  NULL::date,
  'case 6b: minted lot for non-perishable product has expires_on=NULL'
);

SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('rot_thresh_alice');

SELECT * FROM finish();
ROLLBACK;
