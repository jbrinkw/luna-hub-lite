-- pgTAP — ``stock_lots.pickup_weight_g`` MUST be populated when an
-- in_flight_pickup shelf event resolves to a live_shelf lot.
--
-- BUG (2026-04-28):
--   Layer 3 of the catch-all delta-capture redesign added the
--   pickup_weight_g column (migration 20260427120000) so the cloud can
--   compute consumption against the lot's pickup baseline. The
--   catch-all branches of ``apply_shelf_event`` populate it correctly,
--   but the existing live_shelf in_flight_pickup branch was overlooked
--   and stamped in_flight_since + pickup_event_id WITHOUT writing the
--   pickup_weight_g. Migration 20260428050000 patches the function;
--   this probe locks the invariant in place.
--
-- WHY THIS PROBE EXISTS:
--   The companion Pi-side TTL macro reconciler (planned) computes
--   consumption_g = pickup_weight_g - return_g for any live_shelf
--   in-flight session that times out without a clean
--   in_flight_return. With pickup_weight_g NULL, that subtraction
--   yields NULL → no macros logged → silent macro drop. The bug is
--   invisible without an explicit DB-level invariant.
--
-- WHAT WE ASSERT:
--   1. After private.apply_shelf_event(...,'in_flight_pickup',...) on
--      a live_shelf lot, the resolved lot's pickup_weight_g IS NOT
--      NULL.
--   2. The value equals abs(p_delta_g) (== the magnitude of the
--      measured weight removed from the shelf).
--   3. The clear-on-return semantics: a follow-up in_flight_return
--      MUST set pickup_weight_g back to NULL so the lot doesn't
--      carry a stale baseline into its next in-flight cycle.
--
-- MUTATION DISCIPLINE:
--   Reverting the live_shelf in_flight_pickup UPDATE in
--   private.apply_shelf_event back to its pre-fix shape (drop the
--   pickup_weight_g column from SET) flips assertion #1 to FAIL with
--   the message 'live_shelf in_flight_pickup populates
--   pickup_weight_g (NOT NULL)' — directly fingering the bug.

BEGIN;
SELECT plan(6);

-- ------------------------------------------------------------------
-- Setup — authenticated user, product with full nutrition columns.
-- Mirrors shelf_event_in_flight_pickup.test.sql conventions.
-- ------------------------------------------------------------------

SELECT tests.create_supabase_user('pwg_alice');
SELECT tests.authenticate_as('pwg_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('pwg_alice'),
  'PWG Almond Milk',
  946.000, 4,
  60, 8, 1, 2.5
);

SELECT product_id AS alice_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('pwg_alice')
   AND name = 'PWG Almond Milk' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('pwg_alice'),
  'pwg-pi',
  'pwg_hash_alice',
  true
);

SELECT device_id AS alice_device_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('pwg_alice')
   AND device_name = 'pwg-pi' \gset

SELECT location_id AS alice_fridge_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('pwg_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('pwg_alice'),
  :'alice_product_id',
  :'alice_fridge_id',
  1.000,
  'live_shelf',
  now() - interval '5 minutes'
);

SELECT lot_id AS alice_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('pwg_alice')
   AND product_id = :'alice_product_id' \gset

-- ------------------------------------------------------------------
-- Drive an in_flight_pickup as the Pi sends it: p_delta_g is the
-- (negative) measured weight removed from the shelf. We pick a
-- distinctive value (-987.654) so a mutation that hard-codes a
-- different magnitude can't accidentally pass.
-- ------------------------------------------------------------------

SET LOCAL role postgres;

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'in_flight_pickup',
        %L::UUID, -987.654, now()::TIMESTAMPTZ, 'evt-pwg-pickup-1',
        '99999999-9999-9999-9999-999999999991'
      )$$,
    tests.get_supabase_uid('pwg_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'pickup: in_flight_pickup call succeeds for live_shelf lot'
);

-- Assertion 1: pickup_weight_g IS NOT NULL on the resolved lot.
SELECT isnt(
  (SELECT pickup_weight_g FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  NULL,
  'live_shelf in_flight_pickup populates pickup_weight_g (NOT NULL)'
);

-- Assertion 2: pickup_weight_g equals abs(p_delta_g).
SELECT is(
  (SELECT pickup_weight_g FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id')::numeric(10,3),
  987.654::numeric(10,3),
  'live_shelf in_flight_pickup pickup_weight_g equals abs(p_delta_g)'
);

-- Sanity: in_flight_kind is stamped to live_shelf (not catch_all).
-- Belt-and-suspenders against a mutation that mis-routes the branch.
SELECT is(
  (SELECT in_flight_kind FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  'live_shelf'::text,
  'live_shelf in_flight_pickup stamps in_flight_kind=''live_shelf'''
);

-- ------------------------------------------------------------------
-- Drive the matching in_flight_return — pickup_weight_g MUST clear.
-- Without the clear, a second pickup cycle would inherit the prior
-- baseline and the TTL reconciler would compute the wrong
-- consumption.
-- ------------------------------------------------------------------

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'in_flight_return',
        %L::UUID, 0, now()::TIMESTAMPTZ, 'evt-pwg-return-1', NULL
      )$$,
    tests.get_supabase_uid('pwg_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'return: in_flight_return call succeeds for the in-flight live_shelf lot'
);

SELECT is(
  (SELECT pickup_weight_g FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_id'),
  NULL,
  'live_shelf in_flight_return clears pickup_weight_g back to NULL'
);

SELECT * FROM finish();
ROLLBACK;
