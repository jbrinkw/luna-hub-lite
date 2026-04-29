-- pgTAP — live_shelf partial-place macro consumption.
--
-- Coverage of the 2026-04-29 design rule: when a partial bottle is
-- placed on a live_shelf scale and the oldest stock_lots row for the
-- product is < 6 hours old, the consumed amount
-- (gross_weight_g - placement_g) lands as a food_logs row with
-- ``usage_kind='partial_place_consume'``. Stale-lot products skip the
-- write and stamp ``reason='partial_place_skipped_stale_lot'`` on
-- shelf_event_log.
--
-- Companion to ``supabase/migrations/20260429180000_live_shelf_partial_place_macros.sql``.

BEGIN;
SELECT plan(8);

------------------------------------------------------------
-- Setup: authenticated user + product (with gross + macros)
------------------------------------------------------------

SELECT tests.create_supabase_user('pp_alice');
SELECT tests.authenticate_as('pp_alice');
SELECT hub.activate_app('chefbyte');

-- Product carries net + gross weight + macros so the partial-place
-- branch has everything it needs to compute consumption.
INSERT INTO chefbyte.products (
  user_id, name,
  net_weight_g, gross_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving,
  protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('pp_alice'),
  'PP Test Milk',
  -- net 1500g (the actual liquid), gross 1538g (incl. container).
  -- Use gross as the "full container weight" reference for partial-fill.
  1500, 1538, 6,
  -- 6 servings * 60 cal/serving = 360 cal full bottle.
  -- 6 servings * 6 carb/serving = 36 g carbs full.
  60, 6, 4, 2
);

SELECT product_id AS pp_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('pp_alice')
   AND name = 'PP Test Milk' \gset

SELECT location_id AS pp_loc_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('pp_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('pp_alice'),
  'pp-pi',
  'pp_hash_alice',
  true
);

SELECT device_id AS pp_device_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('pp_alice')
   AND device_name = 'pp-pi' \gset

------------------------------------------------------------
-- Scenario 1: fresh lot (< 6h old) — partial-place writes food_logs.
--
-- Setup: stock_lots row with created_at = now() - 1 hour.
-- Event: live_shelf added with delta_g = 472.3g (placement weight).
-- Expected:
--   * consumed_g = 1538 - 472.3 = 1065.7g
--   * servings   = (1065.7 / 1538) * 6 ≈ 4.157
--   * food_logs row with calories ≈ 4.157 * 60 ≈ 249.4
--   * usage_kind = 'partial_place_consume'
------------------------------------------------------------

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts, created_at
) VALUES (
  tests.get_supabase_uid('pp_alice'),
  :'pp_product_id',
  :'pp_loc_id',
  1.0,
  'manual',
  now() - interval '1 hour',
  now() - interval '1 hour'
);

SET LOCAL role postgres;

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-pp', 'live_shelf', 'added',
        %L::UUID, 472.3, now()::TIMESTAMPTZ, 'evt-pp-fresh',
        NULL, NULL
      )$$,
    tests.get_supabase_uid('pp_alice'),
    :'pp_device_id',
    :'pp_product_id'
  ),
  'live_shelf added on fresh-lot product applies'
);

SELECT is(
  (SELECT usage_kind
     FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('pp_alice')
      AND source_client_event_id = 'evt-pp-fresh'),
  'partial_place_consume',
  'fresh-lot partial-place writes food_logs.usage_kind=partial_place_consume'
);

-- Macro arithmetic: 1538 - 472.3 = 1065.7, ratio 0.6929, * 6 servings = 4.157
-- calories = 4.157 * 60 = 249.45
SELECT cmp_ok(
  (SELECT calories
     FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('pp_alice')
      AND source_client_event_id = 'evt-pp-fresh')::NUMERIC,
  '>',
  249::NUMERIC,
  'fresh-lot food_logs.calories matches scaled consumption (>249)'
);

SELECT cmp_ok(
  (SELECT calories
     FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('pp_alice')
      AND source_client_event_id = 'evt-pp-fresh')::NUMERIC,
  '<',
  250::NUMERIC,
  'fresh-lot food_logs.calories matches scaled consumption (<250)'
);

-- Stock arithmetic preserved: the resolver should have updated some
-- stock_lots row for this product to reflect the placement.
SELECT cmp_ok(
  (SELECT count(*)::int
     FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('pp_alice')
      AND product_id = :'pp_product_id'
      AND last_update_source = 'live_shelf'),
  '>=',
  1,
  'fresh-lot scenario: stock_lots row tracked by live_shelf exists'
);

------------------------------------------------------------
-- Scenario 2: stale lot (> 6h old) — NO food_logs, reason stamped.
------------------------------------------------------------

-- Reset for second scenario: new user so the freshness check on the
-- oldest stock_lots row reads the stale row only.
SELECT tests.create_supabase_user('pp_bob');
SELECT tests.authenticate_as('pp_bob');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name,
  net_weight_g, gross_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving,
  protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('pp_bob'),
  'PP Test Milk Bob',
  1500, 1538, 6,
  60, 6, 4, 2
);

SELECT product_id AS pp_bob_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('pp_bob')
   AND name = 'PP Test Milk Bob' \gset

SELECT location_id AS pp_bob_loc_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('pp_bob')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('pp_bob'),
  'pp-pi-bob',
  'pp_hash_bob',
  true
);

SELECT device_id AS pp_bob_device_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('pp_bob')
   AND device_name = 'pp-pi-bob' \gset

-- 7-hour-old lot.
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts, created_at
) VALUES (
  tests.get_supabase_uid('pp_bob'),
  :'pp_bob_product_id',
  :'pp_bob_loc_id',
  1.0,
  'manual',
  now() - interval '7 hours',
  now() - interval '7 hours'
);

SET LOCAL role postgres;

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-pp', 'live_shelf', 'added',
        %L::UUID, 472.3, now()::TIMESTAMPTZ, 'evt-pp-stale',
        NULL, NULL
      )$$,
    tests.get_supabase_uid('pp_bob'),
    :'pp_bob_device_id',
    :'pp_bob_product_id'
  ),
  'live_shelf added on stale-lot product applies (no error)'
);

-- Stale: NO food_logs row for this event.
SELECT is(
  (SELECT count(*)::int
     FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('pp_bob')
      AND source_client_event_id = 'evt-pp-stale'),
  0,
  'stale-lot partial-place writes NO food_logs row'
);

-- Reason stamped: partial_place_skipped_stale_lot.
SELECT is(
  (SELECT reason
     FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('pp_bob')
      AND client_event_id = 'evt-pp-stale'),
  'partial_place_skipped_stale_lot',
  'stale-lot partial-place stamps reason=partial_place_skipped_stale_lot'
);

SELECT * FROM finish();
ROLLBACK;
