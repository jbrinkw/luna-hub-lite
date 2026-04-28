-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — catch_all TTL reaper is PASSIVE
-- ════════════════════════════════════════════════════════════════════════════
-- Pins decisions.md #56 (catch-all delta-capture):
--   "Catch-all TTL ≠ live_shelf TTL. Catch-all clears markers only;
--    qty stays at first-event measured weight; no food_logs."
--
-- Design rationale: a catch-all session that times out before the
-- second measurement isn't a consumption event — it's an abandoned
-- delta-capture. Zeroing qty would lose the user's first-event
-- reconciliation; writing food_logs would log a phantom consumption.
--
-- The contract: reap_catch_all_in_flight clears the four markers
-- (in_flight_since, in_flight_kind, pickup_event_id, pickup_weight_g)
-- and returns. qty_containers and food_logs MUST be untouched.
--
-- A regression that adds qty zero-out to this branch silently destroys
-- catch-all inventory on every TTL tick.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(5);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('invariant_ca_alice');
SELECT tests.authenticate_as('invariant_ca_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('invariant_ca_alice'),
  'CA Invariant Trail Mix',
  500.000, 5,
  200, 24, 4, 12
);

SELECT product_id AS p_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('invariant_ca_alice')
   AND name = 'CA Invariant Trail Mix' \gset

SELECT location_id AS loc_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('invariant_ca_alice')
   AND name = 'Fridge' \gset

-- Plant a catch-all in-flight lot at qty=0.500 (mid-session: first
-- measurement happened, marker was stamped, second measurement never
-- arrived, TTL expired). Use distinct expires_on dates so the
-- merge-key index doesn't conflict with future lots in this test.
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts,
  in_flight_since, in_flight_kind, pickup_event_id, pickup_weight_g,
  expires_on
) VALUES (
  tests.get_supabase_uid('invariant_ca_alice'),
  :'p_id', :'loc_id', 0.500,
  'live_shelf', now() - interval '7 hours',
  now() - interval '7 hours',     -- past 6h TTL
  'catch_all',
  '33333333-3333-3333-3333-333333333333',
  250.0,
  '2027-12-31'::date
);

SELECT lot_id AS ca_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('invariant_ca_alice')
   AND product_id = :'p_id'
   AND in_flight_kind = 'catch_all' \gset

-- Plant a control: a live_shelf in-flight lot the reaper MUST NOT
-- touch. Use a DIFFERENT product so the stock_lots_one_per_tracked_shelf
-- unique index doesn't conflict with the catch-all lot above.
INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('invariant_ca_alice'),
  'CA Invariant Control Product',
  500.000, 5,
  200, 24, 4, 12
);

SELECT product_id AS p2_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('invariant_ca_alice')
   AND name = 'CA Invariant Control Product' \gset

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts,
  in_flight_since, in_flight_kind, pickup_event_id, pickup_weight_g,
  expires_on
) VALUES (
  tests.get_supabase_uid('invariant_ca_alice'),
  :'p2_id', :'loc_id', 1.000,
  'live_shelf', now() - interval '7 hours',
  now() - interval '7 hours',
  'live_shelf',                   -- DIFFERENT kind
  '44444444-4444-4444-4444-444444444444',
  500.0,
  '2028-12-31'::date
);

SELECT lot_id AS ls_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('invariant_ca_alice')
   AND product_id = :'p2_id'
   AND in_flight_kind = 'live_shelf' \gset

SET LOCAL role postgres;

------------------------------------------------------------
-- Run the reaper at a 6h TTL — both rows are 7h old so the catch_all
-- one is reaped, the live_shelf one is NOT (different reaper owns it).
------------------------------------------------------------

SELECT private.reap_catch_all_in_flight(p_ttl_seconds => 21600, p_limit => 500);

------------------------------------------------------------
-- Assertion 1 — qty_containers UNCHANGED on the reaped catch-all lot.
-- This is THE design-intent assertion. A regression that adds
-- ``SET qty_containers = 0`` to the reaper trips this immediately.
------------------------------------------------------------
SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'ca_lot_id')::numeric(10,3),
  0.500::numeric(10,3),
  'invariant (decision #56): reap_catch_all_in_flight MUST NOT '
    'change qty_containers. Catch-all TTL is PASSIVE — clearing '
    'markers only. A non-zero failure here means the reaper added '
    'a destructive UPDATE that deletes user inventory on every '
    'tick.'
);

------------------------------------------------------------
-- Assertion 2 — markers ARE cleared on the reaped row.
------------------------------------------------------------
SELECT ok(
  (SELECT in_flight_since IS NULL
       AND in_flight_kind IS NULL
       AND pickup_event_id IS NULL
       AND pickup_weight_g IS NULL
     FROM chefbyte.stock_lots
    WHERE lot_id = :'ca_lot_id'),
  'invariant (decision #56): reap_catch_all_in_flight MUST clear '
    'all four markers (in_flight_since, in_flight_kind, '
    'pickup_event_id, pickup_weight_g). Without this, the row '
    'stays "in flight" forever and re-pickup is impossible.'
);

------------------------------------------------------------
-- Assertion 3 — NO food_logs row written.
------------------------------------------------------------
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('invariant_ca_alice')),
  0,
  'invariant (decision #56): catch_all TTL reaper MUST NOT write '
    'food_logs. The session was abandoned, not consumed. A row '
    'here means the reaper is treating timeouts as consumption '
    'events — phantom calories on every reaped lot.'
);

------------------------------------------------------------
-- Assertion 4 — live_shelf in-flight lot is UNTOUCHED.
-- Reaper must scope to in_flight_kind='catch_all' only.
------------------------------------------------------------
SELECT ok(
  (SELECT in_flight_since IS NOT NULL
       AND in_flight_kind = 'live_shelf'
       AND pickup_event_id = '44444444-4444-4444-4444-444444444444'
       AND pickup_weight_g = 500.0
     FROM chefbyte.stock_lots
    WHERE lot_id = :'ls_lot_id'),
  'invariant (decision #56): reap_catch_all_in_flight MUST NOT '
    'touch live_shelf in-flight rows (different reaper owns them; '
    'the live_shelf reaper writes food_logs and zeros qty, the '
    'catch_all reaper does neither). Cross-kind reaping = '
    'corrupted in-flight state across both shelves.'
);

------------------------------------------------------------
-- Assertion 5 — second reap call is idempotent (the row was
-- already cleared and falls outside the predicate).
------------------------------------------------------------
SELECT is(
  private.reap_catch_all_in_flight(p_ttl_seconds => 21600, p_limit => 500),
  0,
  'invariant: subsequent reap call returns 0 (idempotent — the '
    'row was already cleared in the first pass).'
);

SELECT * FROM finish();
ROLLBACK;
