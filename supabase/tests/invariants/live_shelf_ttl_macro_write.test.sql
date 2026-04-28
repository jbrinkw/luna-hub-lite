-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — live_shelf TTL pickup-resolve WRITES food_logs
-- ════════════════════════════════════════════════════════════════════════════
-- Pins decisions.md #43 + #56 Q6:
--   "live_shelf TTL: zeros qty + writes food_logs for the pre-pickup
--    mass" (in contrast to catch_all TTL which is passive).
--
-- Mechanism: the Pi reaper emits a ``consumed`` event with
-- ``pi_event_id`` matching the lot's ``pickup_event_id`` and
-- ``delta_g = -pickup_weight_g``. The cloud's apply_shelf_event
-- pickup-resolve branch (migration 20260427020000) zeros qty AND
-- inserts a food_logs row for the consumed mass.
--
-- A regression that drops the food_logs INSERT in the pickup_close
-- branch silently loses macro tracking on every TTL-expired pickup —
-- the user's daily macro total under-counts every time they leave an
-- item off the shelf > TTL.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(4);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('invariant_ls_alice');
SELECT tests.authenticate_as('invariant_ls_alice');
SELECT hub.activate_app('chefbyte');

-- Product with non-trivial macros so the food_logs row has clearly
-- distinguishable values. Net=1500g, 3 servings, 150 cal/serving.
-- A whole-lot pickup of 1500g consumes 3 servings = 450 cal.
INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('invariant_ls_alice'),
  'LS TTL Invariant Milk',
  1500.000, 3,
  150, 20, 8, 5
);

SELECT product_id AS p_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('invariant_ls_alice')
   AND name = 'LS TTL Invariant Milk' \gset

SELECT location_id AS loc_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('invariant_ls_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('invariant_ls_alice'),
  'ls-ttl-pi',
  'ls_ttl_invariant_hash',
  true
);

SELECT device_id AS d_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('invariant_ls_alice')
   AND device_name = 'ls-ttl-pi' \gset

-- Plant the lot in mid-pickup state (TTL will have expired). Pi
-- emitted ``in_flight_pickup`` 7h ago, lot was stamped, now the
-- TTL reaper emits a ``consumed`` event with the matching
-- pi_event_id to "close out" the pickup.
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts,
  in_flight_since, in_flight_kind, pickup_event_id
) VALUES (
  tests.get_supabase_uid('invariant_ls_alice'),
  :'p_id', :'loc_id', 1.000,
  'live_shelf', now() - interval '7 hours',
  now() - interval '7 hours',
  'live_shelf',
  '55555555-5555-5555-5555-555555555555'
);

SELECT lot_id AS ls_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('invariant_ls_alice')
   AND product_id = :'p_id' \gset

SET LOCAL role postgres;

------------------------------------------------------------
-- Simulate the Pi reaper emit: consumed event with delta_g =
-- -1500 (the original pickup weight, full container) and
-- pi_event_id matching pickup_event_id.
------------------------------------------------------------

SELECT * FROM private.apply_shelf_event(
  tests.get_supabase_uid('invariant_ls_alice'),
  :'d_id'::UUID, 'scale-01', 'live_shelf', 'consumed',
  :'p_id'::UUID, -1500.0, now()::TIMESTAMPTZ, 'invariant-ls-ttl-evt-1',
  '55555555-5555-5555-5555-555555555555'
);

------------------------------------------------------------
-- Assertion 1 — qty zeroed (whole-lot removal — decision #43).
------------------------------------------------------------
SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'ls_lot_id')::numeric(10,3),
  0.000::numeric(10,3),
  'invariant (decision #43): live_shelf TTL pickup-close zeros qty.'
);

------------------------------------------------------------
-- Assertion 2 — exactly ONE food_logs row was written.
-- THIS IS THE DESIGN-INTENT ASSERTION.
-- A regression that drops the INSERT trips this with "0 != 1".
------------------------------------------------------------
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('invariant_ls_alice')),
  1,
  'invariant (decision #43, #56 Q6): live_shelf TTL pickup-close '
    'MUST write a food_logs row for the consumed mass. Without '
    'this, TTL-expired pickups silently lose macro tracking — '
    'user daily totals under-count every leftover-on-counter '
    'event. Failure here means the food_logs INSERT inside the '
    'pickup_close_whole_lot branch was dropped or guarded out.'
);

------------------------------------------------------------
-- Assertion 3 — food_logs row reflects the FULL pickup mass
-- (3 servings × 150cal = 450cal, NOT the fractional decrement).
------------------------------------------------------------
SELECT is(
  (SELECT calories::numeric(10,3) FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('invariant_ls_alice')
    LIMIT 1),
  450.000::numeric(10,3),
  'invariant: food_logs row carries the FULL pickup mass macros '
    '(3 ctn × 150 cal/srv = 450 cal). Decision #43 explicitly '
    'requires whole-mass macros on TTL-expired pickup, not a '
    'fractional decrement.'
);

------------------------------------------------------------
-- Assertion 4 — in-flight markers cleared on resolve.
------------------------------------------------------------
SELECT ok(
  (SELECT in_flight_since IS NULL
       AND pickup_event_id IS NULL
     FROM chefbyte.stock_lots
    WHERE lot_id = :'ls_lot_id'),
  'invariant: live_shelf TTL pickup-close clears in_flight_since '
    'and pickup_event_id markers.'
);

SELECT * FROM finish();
ROLLBACK;
