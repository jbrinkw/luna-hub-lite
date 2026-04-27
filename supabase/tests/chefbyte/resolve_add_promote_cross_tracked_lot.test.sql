-- pgTAP coverage for migration
-- 20260427060000_resolve_add_promote_cross_tracked_lot.sql
--
-- Cross-tracked-source promotion (live_scale ↔ live_shelf transfer).
-- Real-world scenario: user has a tracked lot on a paired live_scale
-- (countertop scale), then physically moves the same container to the
-- live_shelf (fridge). Pi visually identifies the product, fires an
-- `added` event with kind=live_shelf. Without step 2.6 the resolver
-- falls through to mint and hits stock_lots_merge_key (23505).
--
-- Coverage:
--   1. live_scale-tracked lot → live_shelf place: step 2.6 promotes
--      it (last_update_source=live_shelf, qty bumped). Regression
--      proves no 23505 (mint-into-existing-merge-key) AND only one
--      stock_lots row remains for the (user, product) — promotion in
--      place, not mint-and-collide.
--   2. Inverse direction (live_shelf → live_scale) also works.
--   3. Cross-user isolation: user B's resolver run never sees user A's
--      cross-tracked lot.
--   4. Same-source-tracked lot already exists (step 2 hits first) →
--      step 2.6 never fires; cross-source sibling lot is left alone.
--   5. shelf_event_log.reason='promoted_cross_tracked_lot' is stamped
--      when an event_id is provided.
--
-- Not directly tested: count>1 guard. The
-- ``stock_lots_one_per_tracked_shelf`` invariant guarantees at most
-- one qty>0 lot per (user, product, last_update_source), so a state
-- with TWO live_scale-tracked qty>0 lots for the same product is
-- unreachable. The count guard is defense-in-depth.

BEGIN;
SELECT plan(11);

------------------------------------------------------------
-- Setup
------------------------------------------------------------
SELECT tests.create_supabase_user('cross_alice');
SELECT tests.create_supabase_user('cross_bob');

SELECT tests.authenticate_as('cross_alice');
SELECT hub.activate_app('chefbyte');
SELECT tests.authenticate_as('cross_bob');
SELECT hub.activate_app('chefbyte');

SELECT tests.authenticate_as('cross_alice');

-- Pulled chicken: 425g full container, 4 servings, 200 cal/serving.
INSERT INTO chefbyte.products (
  product_id, user_id, name, net_weight_g, servings_per_container,
  calories_per_serving
) VALUES (
  'eeee0001-eeee-eeee-eeee-eeeeeeeeeeee',
  tests.get_supabase_uid('cross_alice'),
  'Pulled Chicken', 425, 4, 200
);

SELECT location_id AS alice_fridge
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('cross_alice') AND name = 'Fridge' \gset

SELECT location_id AS alice_pantry
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('cross_alice') AND name = 'Pantry' \gset

-- A live_shelf device is required to insert into shelf_event_log (FK).
-- Test 5 stubs an event row to verify the audit reason stamp.
INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('cross_alice'),
  'cross-alice-pi',
  'cross_hash_alice',
  true
);

SELECT device_id AS alice_device_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('cross_alice')
   AND device_name = 'cross-alice-pi' \gset

SELECT tests.authenticate_as('cross_bob');
INSERT INTO chefbyte.products (
  product_id, user_id, name, net_weight_g, servings_per_container,
  calories_per_serving
) VALUES (
  'ffff0001-ffff-ffff-ffff-ffffffffffff',
  tests.get_supabase_uid('cross_bob'),
  'Pulled Chicken', 425, 4, 200
);

SELECT location_id AS bob_fridge
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('cross_bob') AND name = 'Fridge' \gset

------------------------------------------------------------
-- 1. live_scale → live_shelf transfer. The bug case.
------------------------------------------------------------
SELECT tests.authenticate_as('cross_alice');

-- Seed: existing live_scale-tracked lot at qty=1.0.
INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts
) VALUES (
  '11111111-1111-1111-1111-111111111101',
  tests.get_supabase_uid('cross_alice'),
  'eeee0001-eeee-eeee-eeee-eeeeeeeeeeee',
  :'alice_fridge', 1.0, 'live_scale', now() - interval '5 days'
);

-- Sanity: invariant holds before resolver run.
SELECT is(
  (SELECT COUNT(*) FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('cross_alice')
      AND product_id = 'eeee0001-eeee-eeee-eeee-eeeeeeeeeeee'),
  1::bigint,
  'pre-condition: 1 live_scale-tracked lot exists'
);

SET LOCAL role postgres;
-- Place 244g (≈0.574 ctn) of the chicken on the live_shelf.
SELECT private.resolve_add_to_shelf_lot(
  tests.get_supabase_uid('cross_alice'),
  'eeee0001-eeee-eeee-eeee-eeeeeeeeeeee',
  'live_shelf',
  :'alice_fridge',
  244.1237,
  NULL,
  now()
) AS promoted_cross \gset
RESET role;

SELECT tests.authenticate_as('cross_alice');

SELECT is(
  :'promoted_cross'::uuid,
  '11111111-1111-1111-1111-111111111101'::uuid,
  'step 2.6 returns the existing live_scale lot id (not a new mint)'
);

SELECT is(
  (SELECT last_update_source FROM chefbyte.stock_lots
    WHERE lot_id = '11111111-1111-1111-1111-111111111101'),
  'live_shelf',
  'last_update_source flipped from live_scale to live_shelf'
);

SELECT cmp_ok(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '11111111-1111-1111-1111-111111111101')::numeric,
  '>',
  1.0::numeric,
  'qty_containers bumped (1.0 + 244.1237/425 ≈ 1.574)'
);

SELECT is(
  (SELECT COUNT(*) FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('cross_alice')
      AND product_id = 'eeee0001-eeee-eeee-eeee-eeeeeeeeeeee'),
  1::bigint,
  'no new lot minted — promotion in place (regression: would be 2 + 23505 before fix)'
);

------------------------------------------------------------
-- 2. Inverse direction: live_shelf → live_scale.
--    Cleanup, then re-seed the opposite shape.
------------------------------------------------------------
DELETE FROM chefbyte.stock_lots
 WHERE lot_id = '11111111-1111-1111-1111-111111111101';

INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts
) VALUES (
  '22222222-2222-2222-2222-222222222202',
  tests.get_supabase_uid('cross_alice'),
  'eeee0001-eeee-eeee-eeee-eeeeeeeeeeee',
  :'alice_fridge', 0.5, 'live_shelf', now() - interval '1 hour'
);

SET LOCAL role postgres;
SELECT private.resolve_add_to_shelf_lot(
  tests.get_supabase_uid('cross_alice'),
  'eeee0001-eeee-eeee-eeee-eeeeeeeeeeee',
  'live_scale',
  :'alice_fridge',
  100.0,
  NULL,
  now()
) AS promoted_inverse \gset
RESET role;

SELECT tests.authenticate_as('cross_alice');

SELECT is(
  :'promoted_inverse'::uuid,
  '22222222-2222-2222-2222-222222222202'::uuid,
  'inverse direction: live_shelf-tracked lot promoted to live_scale'
);

SELECT is(
  (SELECT last_update_source FROM chefbyte.stock_lots
    WHERE lot_id = '22222222-2222-2222-2222-222222222202'),
  'live_scale',
  'last_update_source flipped live_shelf → live_scale on inverse direction'
);

------------------------------------------------------------
-- 3. Cross-user isolation. Alice's live_scale lot must be invisible
--    to Bob's resolver run.
--    Cleanup Alice's state, seed lot under Alice, run resolver as Bob.
------------------------------------------------------------
DELETE FROM chefbyte.stock_lots
 WHERE lot_id = '22222222-2222-2222-2222-222222222202';

INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts
) VALUES (
  '55555555-5555-5555-5555-555555555505',
  tests.get_supabase_uid('cross_alice'),
  'eeee0001-eeee-eeee-eeee-eeeeeeeeeeee',
  :'alice_fridge', 1.0, 'live_scale', now() - interval '1 hour'
);

SET LOCAL role postgres;
SELECT private.resolve_add_to_shelf_lot(
  tests.get_supabase_uid('cross_bob'),
  'ffff0001-ffff-ffff-ffff-ffffffffffff',
  'live_shelf',
  :'bob_fridge',
  500.0,
  NULL,
  now()
) AS bob_run \gset
RESET role;

SELECT tests.authenticate_as('cross_alice');

SELECT is(
  (SELECT last_update_source FROM chefbyte.stock_lots
    WHERE lot_id = '55555555-5555-5555-5555-555555555505'),
  'live_scale',
  'cross-user: Bob''s resolver run did NOT touch Alice''s live_scale lot'
);

------------------------------------------------------------
-- 4. Same-source-tracked lot already exists → step 2 fires first;
--    step 2.6 never sees the cross-tracked sibling.
--    Cleanup, then seed both shapes.
------------------------------------------------------------
DELETE FROM chefbyte.stock_lots
 WHERE lot_id = '55555555-5555-5555-5555-555555555505';

-- Same-source: live_shelf qty=0.5
INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts
) VALUES (
  '66666666-6666-6666-6666-666666666606',
  tests.get_supabase_uid('cross_alice'),
  'eeee0001-eeee-eeee-eeee-eeeeeeeeeeee',
  :'alice_fridge', 0.5, 'live_shelf', now() - interval '30 min'
);
-- Cross-source: live_scale qty=1.0 with different expires_on so the
-- merge-key doesn't collide.
INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts, expires_on
) VALUES (
  '77777777-7777-7777-7777-777777777707',
  tests.get_supabase_uid('cross_alice'),
  'eeee0001-eeee-eeee-eeee-eeeeeeeeeeee',
  :'alice_pantry', 1.0, 'live_scale', now() - interval '1 hour',
  '2026-08-15'
);

SET LOCAL role postgres;
SELECT private.resolve_add_to_shelf_lot(
  tests.get_supabase_uid('cross_alice'),
  'eeee0001-eeee-eeee-eeee-eeeeeeeeeeee',
  'live_shelf',
  :'alice_fridge',
  200.0,
  NULL,
  now()
) AS same_src_winner \gset
RESET role;

SELECT tests.authenticate_as('cross_alice');

SELECT is(
  :'same_src_winner'::uuid,
  '66666666-6666-6666-6666-666666666606'::uuid,
  'same-source live_shelf lot wins via step 2 (step 2.6 never fires)'
);

SELECT is(
  (SELECT last_update_source FROM chefbyte.stock_lots
    WHERE lot_id = '77777777-7777-7777-7777-777777777707'),
  'live_scale',
  'cross-source sibling lot stays live_scale when same-source lot exists'
);

------------------------------------------------------------
-- 5. shelf_event_log.reason='promoted_cross_tracked_lot' is stamped.
--    Cleanup, seed, insert a stub shelf_event_log row, run resolver
--    with event_id, assert reason text.
------------------------------------------------------------
DELETE FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('cross_alice')
   AND product_id = 'eeee0001-eeee-eeee-eeee-eeeeeeeeeeee';

INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts
) VALUES (
  '88888888-8888-8888-8888-888888888808',
  tests.get_supabase_uid('cross_alice'),
  'eeee0001-eeee-eeee-eeee-eeeeeeeeeeee',
  :'alice_fridge', 1.0, 'live_scale', now() - interval '1 hour'
);

-- Stub a shelf_event_log row to receive the reason stamp.
SET LOCAL role postgres;
INSERT INTO chefbyte.shelf_event_log (
  event_id, user_id, device_id, client_event_id, payload, applied, reason
) VALUES (
  '99999999-9999-9999-9999-999999999909',
  tests.get_supabase_uid('cross_alice'),
  :'alice_device_id',
  'cross_tracked_evt_1',
  '{}'::jsonb,
  false,
  'pending'
);

SELECT private.resolve_add_to_shelf_lot(
  tests.get_supabase_uid('cross_alice'),
  'eeee0001-eeee-eeee-eeee-eeeeeeeeeeee',
  'live_shelf',
  :'alice_fridge',
  244.0,
  '99999999-9999-9999-9999-999999999909',
  now()
);
RESET role;

SELECT tests.authenticate_as('cross_alice');

SELECT is(
  (SELECT reason FROM chefbyte.shelf_event_log
    WHERE event_id = '99999999-9999-9999-9999-999999999909'),
  'promoted_cross_tracked_lot',
  'shelf_event_log.reason stamped to promoted_cross_tracked_lot'
);

SELECT * FROM finish();
ROLLBACK;
