-- pgTAP — private.reap_catch_all_in_flight
--
-- Validates supabase/migrations/20260428000000_catch_all_in_flight_ttl_reaper.sql.
--
-- Coverage:
--   1. TTL-expired catch_all in-flight rows have markers cleared.
--   2. qty_containers is NOT changed by the reaper.
--   3. NO food_logs row is written (delta-capture sessions that don't
--      complete are not consumption events).
--   4. live_shelf in-flight rows are NOT touched (different reaper).
--   5. catch_all in-flight rows YOUNGER than the TTL are NOT touched.
--   6. Function returns the reap count.
--   7. p_limit caps the per-tick reap.
--   8. Function is idempotent — second call after first reap is a no-op.

BEGIN;
SELECT plan(13);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('reap_alice');
SELECT tests.authenticate_as('reap_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('reap_alice'),
  'Reap Trail Mix',
  500.000, 5,
  200, 24, 4, 12
);

SELECT product_id AS alice_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('reap_alice')
   AND name = 'Reap Trail Mix' \gset

SELECT location_id AS alice_fridge_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('reap_alice')
   AND name = 'Fridge' \gset

-- Three lots: one expired catch_all, one fresh catch_all, one expired live_shelf.
-- Use distinct expires_on values to satisfy the stock_lots_merge_key unique
-- index on (user_id, product_id, location_id, COALESCE(expires_on,
-- '9999-12-31')).
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on,
  in_flight_since, in_flight_kind, pickup_event_id, pickup_weight_g,
  last_update_source, last_update_ts
) VALUES
  (tests.get_supabase_uid('reap_alice'), :'alice_product_id',
   :'alice_fridge_id', 0.700, '2099-01-01',
   now() - interval '8 hours', 'catch_all',
   '11111111-1111-1111-1111-111111111111'::uuid, 350.000,
   'catch_all', now() - interval '8 hours'),
  (tests.get_supabase_uid('reap_alice'), :'alice_product_id',
   :'alice_fridge_id', 0.500, '2099-02-02',
   now() - interval '15 minutes', 'catch_all',
   '22222222-2222-2222-2222-222222222222'::uuid, 250.000,
   'catch_all', now() - interval '15 minutes'),
  (tests.get_supabase_uid('reap_alice'), :'alice_product_id',
   :'alice_fridge_id', 1.000, '2099-03-03',
   now() - interval '8 hours', 'live_shelf',
   '33333333-3333-3333-3333-333333333333'::uuid, 500.000,
   'live_shelf', now() - interval '8 hours');

SET LOCAL role postgres;

------------------------------------------------------------
-- Case 1-3: reaper clears the expired catch_all row's markers,
-- doesn't change qty, doesn't write food_logs.
------------------------------------------------------------

SELECT lives_ok(
  $$SELECT private.reap_catch_all_in_flight(21600, 100)$$,
  'case 1a: reaper runs without error'
);

-- Re-run to inspect the cleared row state.
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('reap_alice')
      AND in_flight_kind = 'catch_all'
      AND in_flight_since < (now() - interval '6 hours')),
  0,
  'case 1b: no expired catch_all in-flight rows remain'
);

SELECT is(
  (SELECT (qty_containers, in_flight_since, in_flight_kind,
           pickup_event_id, pickup_weight_g)::text
     FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('reap_alice')
      AND pickup_event_id IS NULL
      AND qty_containers = 0.700),
  ROW(0.700::numeric(10,3), NULL::timestamptz, NULL::text,
      NULL::uuid, NULL::numeric(10,3))::text,
  'case 2a: expired catch_all row qty preserved + markers cleared'
);

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('reap_alice')),
  0,
  'case 3: no food_logs written by reaper'
);

------------------------------------------------------------
-- Case 4: live_shelf in-flight row was NOT touched.
------------------------------------------------------------

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('reap_alice')
      AND in_flight_kind = 'live_shelf'
      AND in_flight_since IS NOT NULL),
  1,
  'case 4a: live_shelf in-flight row untouched (count=1)'
);

SELECT is(
  (SELECT pickup_weight_g FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('reap_alice')
      AND in_flight_kind = 'live_shelf')::numeric(10,3),
  500.000::numeric(10,3),
  'case 4b: live_shelf pickup_weight_g preserved'
);

------------------------------------------------------------
-- Case 5: fresh catch_all (15min old) was NOT reaped.
------------------------------------------------------------

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('reap_alice')
      AND in_flight_kind = 'catch_all'
      AND in_flight_since IS NOT NULL),
  1,
  'case 5a: one fresh catch_all in-flight row remains (TTL not expired)'
);

SELECT is(
  (SELECT pickup_weight_g FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('reap_alice')
      AND in_flight_kind = 'catch_all')::numeric(10,3),
  250.000::numeric(10,3),
  'case 5b: fresh catch_all pickup_weight_g preserved'
);

------------------------------------------------------------
-- Case 6: function returns count
------------------------------------------------------------

-- Re-arm an expired row to test return-count.
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on,
  in_flight_since, in_flight_kind, pickup_event_id, pickup_weight_g,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('reap_alice'), :'alice_product_id',
  :'alice_fridge_id', 0.300, '2099-04-04',
  now() - interval '7 hours', 'catch_all',
  '44444444-4444-4444-4444-444444444444'::uuid, 150.000,
  'catch_all', now() - interval '7 hours'
);

SELECT is(
  private.reap_catch_all_in_flight(21600, 100),
  1,
  'case 6: returns count of reaped rows (=1)'
);

------------------------------------------------------------
-- Case 7: p_limit caps per-tick reap
------------------------------------------------------------

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on,
  in_flight_since, in_flight_kind, pickup_event_id, pickup_weight_g,
  last_update_source, last_update_ts
)
SELECT
  tests.get_supabase_uid('reap_alice'),
  :'alice_product_id',
  :'alice_fridge_id',
  0.100,
  -- Distinct expires_on per row to dodge stock_lots_merge_key.
  ('2099-05-01'::date + (g * interval '1 day'))::date,
  now() - interval '7 hours' - (g * interval '1 minute'),
  'catch_all',
  gen_random_uuid(),
  50.000,
  'catch_all',
  now() - interval '7 hours'
FROM generate_series(1, 5) g;

SELECT is(
  private.reap_catch_all_in_flight(21600, 2),
  2,
  'case 7a: p_limit caps reap per tick'
);

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('reap_alice')
      AND in_flight_kind = 'catch_all'
      AND in_flight_since < (now() - interval '6 hours')),
  3,
  'case 7b: 3 expired catch_all rows remain (5 - 2 = 3)'
);

------------------------------------------------------------
-- Case 8: idempotent — running again drains the rest, then no-ops.
------------------------------------------------------------

SELECT is(
  private.reap_catch_all_in_flight(21600, 100),
  3,
  'case 8a: subsequent call drains remaining 3'
);

SELECT is(
  private.reap_catch_all_in_flight(21600, 100),
  0,
  'case 8b: no expired rows → returns 0 (idempotent)'
);

SELECT * FROM finish();
ROLLBACK;
