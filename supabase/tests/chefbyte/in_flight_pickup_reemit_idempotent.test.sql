-- pgTAP — re-emitting an in_flight_pickup event must succeed (no-op-ish),
-- not raise.
--
-- Regression for the 2026-04-29 production outage. The Pi-side
-- ``backfill_missing_outbox_events`` (server/cloud/integration.py) on
-- restart re-emits orphan resolutions from the last 168h with a FRESH
-- client_event_id. This means the cloud's ``(user_id, client_event_id)``
-- dedupe DOES NOT catch the duplicate; the re-emit hits the live code
-- path. Two scenarios must both be safe:
--
--   1. The lot is still in_flight (pickup re-emit while the original
--      is unresolved): the function should re-stamp the same
--      in_flight_since (idempotent UPDATE) and return applied=true.
--
--   2. The lot has already returned (qty restored, in_flight cleared):
--      the function should re-pick the same lot (FEFO over qty>0) and
--      stamp it as in_flight again — applied=true. This is acceptable
--      because:
--        a) A subsequent in_flight_return event will clear it.
--        b) qty_containers is NEVER decremented by in_flight_pickup
--           (food_logs are only written by `consumed`).
--        c) The Pi's actual physical state was a pickup; the cloud
--           reflecting "in_flight" briefly is correct.
--
-- The test simulates Pi-restart-then-backfill by emitting two
-- in_flight_pickup events for the SAME pi_event_id with DIFFERENT
-- client_event_ids. Both must apply cleanly.

BEGIN;
SELECT plan(6);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('reemit_alice');
SELECT tests.authenticate_as('reemit_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('reemit_alice'),
  'Reemit Pulled Chicken',
  300, 3,
  220, 0, 30, 11
);

SELECT product_id AS alice_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('reemit_alice')
   AND name = 'Reemit Pulled Chicken' \gset

SELECT location_id AS alice_fridge_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('reemit_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('reemit_alice'),
  'reemit-pi',
  'reemit_hash_alice',
  true
);

SELECT device_id AS alice_device_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('reemit_alice')
   AND device_name = 'reemit-pi' \gset

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('reemit_alice'),
  :'alice_product_id',
  :'alice_fridge_id',
  1.0,
  'live_shelf',
  now() - interval '5 minutes'
);

SELECT lot_id AS alice_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('reemit_alice')
   AND product_id = :'alice_product_id' \gset

SET LOCAL role postgres;

------------------------------------------------------------
-- Case 1: same client_event_id replay → cached result (existing
--         shelf_event_log dedupe).
------------------------------------------------------------

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'in_flight_pickup',
        %L::UUID, -242.5932, '2026-04-28T22:23:57.275Z'::TIMESTAMPTZ,
        'reemit-cid-A',
        '11111111-2222-3333-4444-555555555555'
      )$$,
    tests.get_supabase_uid('reemit_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 1: first in_flight_pickup runs without error'
);

-- Replay with the SAME client_event_id — the existing shelf_event_log
-- (user_id, client_event_id) UNIQUE catches it; result is cached.
SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'in_flight_pickup',
        %L::UUID, -242.5932, '2026-04-28T22:23:57.275Z'::TIMESTAMPTZ,
        'reemit-cid-A',
        '11111111-2222-3333-4444-555555555555'
      )$$,
    tests.get_supabase_uid('reemit_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 1: same-cid replay does not raise (cached-result branch)'
);

------------------------------------------------------------
-- Case 2: re-emit with a FRESH client_event_id but same pi_event_id
--         (Pi backfill behaviour). Must NOT raise; must apply.
------------------------------------------------------------

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'in_flight_pickup',
        %L::UUID, -242.5932, '2026-04-28T22:23:57.275Z'::TIMESTAMPTZ,
        'reemit-cid-B-fresh',
        '11111111-2222-3333-4444-555555555555'
      )$$,
    tests.get_supabase_uid('reemit_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 2: backfill-style re-emit (new cid, same pi_event_id) does not raise'
);

SELECT is(
  (SELECT applied FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('reemit_alice')
      AND client_event_id = 'reemit-cid-B-fresh'),
  true,
  'case 2: backfill-style re-emit recorded as applied=true'
);

------------------------------------------------------------
-- Case 3: lot already returned (in_flight cleared) → re-emit picks the
-- same lot via the qty>0 fallback, stamps it in_flight again. Safe.
------------------------------------------------------------

UPDATE chefbyte.stock_lots
   SET in_flight_since = NULL,
       in_flight_kind  = NULL,
       pickup_event_id = NULL,
       pickup_weight_g = NULL
 WHERE lot_id = :'alice_lot_id';

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-01', 'live_shelf', 'in_flight_pickup',
        %L::UUID, -242.5932, '2026-04-28T22:23:57.275Z'::TIMESTAMPTZ,
        'reemit-cid-C-postreturn',
        '11111111-2222-3333-4444-555555555555'
      )$$,
    tests.get_supabase_uid('reemit_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 3: re-emit after return (in_flight cleared) does not raise'
);

SELECT is(
  (SELECT applied FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('reemit_alice')
      AND client_event_id = 'reemit-cid-C-postreturn'),
  true,
  'case 3: re-emit after return recorded as applied=true'
);

SELECT * FROM finish();
ROLLBACK;
