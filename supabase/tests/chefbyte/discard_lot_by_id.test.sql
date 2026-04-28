-- pgTAP — private.apply_discard_with_lot_id
--
-- Validates supabase/migrations/20260428030000_discard_lot_by_id.sql.
-- Codex finding MEDIUM-6: catch-all empty-bottle short-circuit must
-- zero the visually-identified lot, not whatever a product-level FEFO
-- happens to pick.

BEGIN;
SELECT plan(10);

------------------------------------------------------------
-- Setup: two lots of the same product. The "matched" lot is the one
-- the Pi visually identified; the "older" lot is what FEFO would pick.
------------------------------------------------------------

SELECT tests.create_supabase_user('disc_alice');
SELECT tests.authenticate_as('disc_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('disc_alice'),
  'Discard Trail Mix',
  500.000, 5,
  200, 24, 4, 12
);

SELECT product_id AS alice_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('disc_alice')
   AND name = 'Discard Trail Mix' \gset

SELECT location_id AS alice_fridge_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('disc_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on,
  last_update_source, last_update_ts
) VALUES
  -- LOT_OLDER: would win product-level FEFO (earlier expires_on).
  (tests.get_supabase_uid('disc_alice'), :'alice_product_id',
   :'alice_fridge_id', 0.800, '2099-01-01',
   'manual', now() - interval '5 days'),
  -- LOT_MATCHED: the lot the Pi actually identified.
  (tests.get_supabase_uid('disc_alice'), :'alice_product_id',
   :'alice_fridge_id', 0.500, '2099-06-01',
   'catch_all', now() - interval '1 hour');

SELECT lot_id AS lot_older
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('disc_alice')
   AND expires_on = '2099-01-01' \gset

SELECT lot_id AS lot_matched
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('disc_alice')
   AND expires_on = '2099-06-01' \gset

-- Per-test device shim so the apply path has a non-null device_id.
INSERT INTO chefbyte.live_shelf_devices (user_id, device_id, device_name, import_key_hash)
VALUES (
  tests.get_supabase_uid('disc_alice'),
  '00000000-0000-0000-0000-000000000001'::uuid,
  'test-device',
  'fakehash-discard-lot-by-id'
)
ON CONFLICT DO NOTHING;

SET LOCAL role postgres;

------------------------------------------------------------
-- Case 1: lot-id-targeted discard zeros the matched lot, NOT the
-- FEFO-by-expiration lot.
------------------------------------------------------------

SELECT lives_ok(
  format($$SELECT private.apply_discard_with_lot_id(
    %L::uuid, %L::uuid, 'scale-02', 'catch_all',
    %L::uuid, %L::uuid, now(), 'cli-1', NULL
  )$$,
    tests.get_supabase_uid('disc_alice'),
    '00000000-0000-0000-0000-000000000001',
    :'lot_matched',
    :'alice_product_id'
  ),
  'case 1a: function runs without error'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'lot_matched'::uuid)::numeric(10,3),
  0.000::numeric(10,3),
  'case 1b: matched lot zeroed'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'lot_older'::uuid)::numeric(10,3),
  0.800::numeric(10,3),
  'case 1c: FEFO-by-expiration lot UNTOUCHED (preserved at 0.800)'
);

------------------------------------------------------------
-- Case 2: idempotent on retry. Same client_event_id replays without
-- mutating again.
------------------------------------------------------------

-- Re-stamp the matched lot to non-zero to detect a re-application.
UPDATE chefbyte.stock_lots
   SET qty_containers = 0.300, last_update_ts = now()
 WHERE lot_id = :'lot_matched'::uuid;

SELECT lives_ok(
  format($$SELECT private.apply_discard_with_lot_id(
    %L::uuid, %L::uuid, 'scale-02', 'catch_all',
    %L::uuid, %L::uuid, now(), 'cli-1', NULL
  )$$,
    tests.get_supabase_uid('disc_alice'),
    '00000000-0000-0000-0000-000000000001',
    :'lot_matched',
    :'alice_product_id'
  ),
  'case 2a: replay runs without error'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'lot_matched'::uuid)::numeric(10,3),
  0.300::numeric(10,3),
  'case 2b: replay does NOT re-zero the lot (idempotent on client_event_id)'
);

------------------------------------------------------------
-- Case 3: cross-user lot_id is rejected.
------------------------------------------------------------

SELECT tests.create_supabase_user('disc_bob');
SELECT tests.authenticate_as('disc_bob');
SELECT hub.activate_app('chefbyte');
INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('disc_bob'),
  'Bob Mix',
  500.000, 5,
  200, 24, 4, 12
);
SET LOCAL role postgres;

-- Bob attempts to discard Alice's lot.
SELECT is(
  (SELECT (private.apply_discard_with_lot_id(
    tests.get_supabase_uid('disc_bob'),
    '00000000-0000-0000-0000-000000000001'::uuid,
    'scale-02', 'catch_all',
    :'lot_matched'::uuid,
    NULL,
    now(),
    'cli-bob-cross', NULL
  )).reason),
  'lot_id not owned by user',
  'case 3: cross-user lot_id rejected'
);

------------------------------------------------------------
-- Case 4: product_id mismatch is rejected.
------------------------------------------------------------

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('disc_alice'),
  'Other Product',
  100.000, 1, 50, 10, 1, 2
);
SELECT product_id AS other_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('disc_alice')
   AND name = 'Other Product' \gset

SELECT is(
  (SELECT (private.apply_discard_with_lot_id(
    tests.get_supabase_uid('disc_alice'),
    '00000000-0000-0000-0000-000000000001'::uuid,
    'scale-02', 'catch_all',
    :'lot_matched'::uuid,
    :'other_product_id'::uuid,
    now(),
    'cli-mismatch', NULL
  )).reason),
  'lot_id product mismatch with payload product_id',
  'case 4: product_id mismatch rejected'
);

------------------------------------------------------------
-- Case 5: nonexistent lot_id is rejected with applied=false.
------------------------------------------------------------

SELECT is(
  (SELECT (private.apply_discard_with_lot_id(
    tests.get_supabase_uid('disc_alice'),
    '00000000-0000-0000-0000-000000000001'::uuid,
    'scale-02', 'catch_all',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
    NULL,
    now(),
    'cli-missing', NULL
  )).reason),
  'lot_id not found',
  'case 5: missing lot_id rejected'
);

------------------------------------------------------------
-- Case 6: in-flight markers (in_flight_kind='catch_all',
-- pickup_event_id, in_flight_since, pickup_weight_g) are cleared as
-- part of the discard.
------------------------------------------------------------

UPDATE chefbyte.stock_lots
   SET qty_containers   = 0.500,
       in_flight_kind   = 'catch_all',
       in_flight_since  = now(),
       pickup_event_id  = '99999999-9999-9999-9999-999999999999'::uuid,
       pickup_weight_g  = 250.000
 WHERE lot_id = :'lot_matched'::uuid;

SELECT lives_ok(
  format($$SELECT private.apply_discard_with_lot_id(
    %L::uuid, %L::uuid, 'scale-02', 'catch_all',
    %L::uuid, %L::uuid, now(), 'cli-clear', NULL
  )$$,
    tests.get_supabase_uid('disc_alice'),
    '00000000-0000-0000-0000-000000000001',
    :'lot_matched',
    :'alice_product_id'
  ),
  'case 6a: discard with markers runs without error'
);

SELECT is(
  (SELECT (qty_containers, in_flight_kind, in_flight_since,
           pickup_event_id, pickup_weight_g)::text
     FROM chefbyte.stock_lots WHERE lot_id = :'lot_matched'::uuid),
  ROW(0.000::numeric(10,3), NULL::text, NULL::timestamptz,
      NULL::uuid, NULL::numeric(10,3))::text,
  'case 6b: qty zeroed AND every in-flight marker cleared'
);

SELECT * FROM finish();
ROLLBACK;
