-- pgTAP coverage for migration 20260427050000_resolve_add_promote_untracked_lot.sql
--
-- Decision #45 / 2026-04-27: live_shelf place events on a product whose
-- only existing inventory is an untracked qty>0 lot must promote that
-- lot to last_update_source='live_shelf' regardless of weight tolerance.
-- The pre-migration code rejected weight-mismatched placements via the
-- unique-index collision in step 5 (mint), causing the user's "Gatorade
-- placed but never gets live-scale tracked badge" symptom.
--
-- Coverage:
--   1. Single untracked qty>0 lot → promoted to live_shelf, qty bumped,
--      shelf_event_log.reason='promoted_untracked_lot'.
--   2. Weight mismatch is NOT a gate — the user's chicken case (placed
--      weight WAY less than tracked qty*net_weight) still promotes.
--   3. Multiple untracked qty>0 lots → step 2.5 declines (count>1),
--      falls through to weight-match step 3 to preserve the
--      multi-lot arbiter behaviour.
--   4. Cross-user isolation: user A's untracked lot is invisible to
--      user B's resolver run.
--   5. live_shelf-tracked lots take precedence (step 2 fires first;
--      step 2.5 never sees them).

BEGIN;
-- Gap G1 (20260515010000): test plumbing DELETEs need bypass; test
-- exercises apply_shelf_event / resolve_add_to_shelf_lot, not the guard.
SET LOCAL chefbyte.stock_lots_allow_hard_delete = 'on';
SELECT plan(12);

------------------------------------------------------------
-- Setup
------------------------------------------------------------
SELECT tests.create_supabase_user('promo_alice');
SELECT tests.create_supabase_user('promo_bob');

SELECT tests.authenticate_as('promo_alice');
SELECT hub.activate_app('chefbyte');
SELECT tests.authenticate_as('promo_bob');
SELECT hub.activate_app('chefbyte');

SELECT tests.authenticate_as('promo_alice');

-- Gatorade Frost: 900g full container, 1 serving, 200 cal.
INSERT INTO chefbyte.products (
  product_id, user_id, name, net_weight_g, servings_per_container,
  calories_per_serving
) VALUES (
  'cccc0001-cccc-cccc-cccc-cccccccccccc',
  tests.get_supabase_uid('promo_alice'),
  'Gatorade Frost', 900, 1, 200
);

SELECT location_id AS alice_fridge
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('promo_alice') AND name = 'Fridge' \gset

SELECT location_id AS alice_pantry
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('promo_alice') AND name = 'Pantry' \gset

SELECT tests.authenticate_as('promo_bob');
INSERT INTO chefbyte.products (
  product_id, user_id, name, net_weight_g, servings_per_container,
  calories_per_serving
) VALUES (
  'dddd0001-dddd-dddd-dddd-dddddddddddd',
  tests.get_supabase_uid('promo_bob'),
  'Gatorade Frost', 900, 1, 200
);

SELECT location_id AS bob_fridge
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('promo_bob') AND name = 'Fridge' \gset

------------------------------------------------------------
-- 1. Single untracked qty>0 lot → step 2.5 promotes it.
------------------------------------------------------------
SELECT tests.authenticate_as('promo_alice');

-- Seed: untracked qty=1.0 lot (mimics manual intake via inventory
-- page or scanner — no last_update_source).
INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  tests.get_supabase_uid('promo_alice'),
  'cccc0001-cccc-cccc-cccc-cccccccccccc',
  :'alice_fridge', 1.0, NULL, now() - interval '1 hour'
);

SET LOCAL role postgres;
-- Place the bottle on live-shelf at 663g (much less than 900g full
-- container — the chicken/Gatorade weight-mismatch case).
SELECT private.resolve_add_to_shelf_lot(
  tests.get_supabase_uid('promo_alice'),
  'cccc0001-cccc-cccc-cccc-cccccccccccc',
  'live_shelf',
  :'alice_fridge',
  663.452,
  NULL,
  now()
) AS promoted_lot \gset
RESET role;

SELECT tests.authenticate_as('promo_alice');

SELECT is(
  :'promoted_lot'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  'step 2.5 returns the existing untracked lot id (not a freshly minted UUID)'
);

SELECT is(
  (SELECT last_update_source FROM chefbyte.stock_lots
    WHERE lot_id = '11111111-1111-1111-1111-111111111111'),
  'live_shelf',
  'last_update_source flipped from NULL to live_shelf'
);

-- Updated 2026-04-29 (migration 20260429210000): step 2.5 must NOT bump
-- qty past 1.0. The lot represents one physical container; partial-fill
-- state lives in last_observed_weight_g. Pre-fix this read 1.737 and
-- caused the user-visible "Gatorade qty=2.4 ctn" bug.
SELECT cmp_ok(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '11111111-1111-1111-1111-111111111111')::numeric,
  '<=',
  1.05::numeric,
  'qty_containers preserved at 1.0 (one-container rule, ±0.05 epsilon)'
);

-- And the placement weight is recorded as last_observed_weight_g.
SELECT is(
  (SELECT last_observed_weight_g FROM chefbyte.stock_lots
    WHERE lot_id = '11111111-1111-1111-1111-111111111111')::numeric,
  663.452::numeric,
  'placement weight stored in last_observed_weight_g (fill-state truth)'
);

SELECT is(
  (SELECT COUNT(*) FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('promo_alice')
      AND product_id = 'cccc0001-cccc-cccc-cccc-cccccccccccc'),
  1::bigint,
  'no new lot was minted — the existing untracked lot was promoted in place'
);

------------------------------------------------------------
-- 2. Weight mismatch is NOT a gate. Even an extreme delta should
--    still flip the source. Tests: place 100g on a qty=1 / 900g lot.
--    Cleanup: delete the just-promoted lot, re-seed the same shape.
------------------------------------------------------------
DELETE FROM chefbyte.stock_lots
 WHERE lot_id = '11111111-1111-1111-1111-111111111111';

INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts
) VALUES (
  '22222222-2222-2222-2222-222222222222',
  tests.get_supabase_uid('promo_alice'),
  'cccc0001-cccc-cccc-cccc-cccccccccccc',
  :'alice_fridge', 1.0, NULL, now() - interval '1 hour'
);

SET LOCAL role postgres;
SELECT private.resolve_add_to_shelf_lot(
  tests.get_supabase_uid('promo_alice'),
  'cccc0001-cccc-cccc-cccc-cccccccccccc',
  'live_shelf',
  :'alice_fridge',
  100.0,  -- way below the 900g full container weight
  NULL,
  now()
) AS promoted_extreme \gset
RESET role;

SELECT tests.authenticate_as('promo_alice');

SELECT is(
  :'promoted_extreme'::uuid,
  '22222222-2222-2222-2222-222222222222'::uuid,
  'extreme weight mismatch (100g vs 900g full) STILL promotes (decision #45)'
);

------------------------------------------------------------
-- 3. Two untracked qty>0 lots → step 2.5 declines (count>1).
--    Falls through to step 3 (weight-match arbiter). With one of
--    the lots matching weight tolerance, step 3 picks it.
--    Cleanup, then re-seed two lots.
------------------------------------------------------------
DELETE FROM chefbyte.stock_lots
 WHERE lot_id = '22222222-2222-2222-2222-222222222222';

-- Lot A: weight-matches 663g exactly (qty=0.737, mass=663.3g).
INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts, expires_on
) VALUES (
  '33333333-3333-3333-3333-333333333333',
  tests.get_supabase_uid('promo_alice'),
  'cccc0001-cccc-cccc-cccc-cccccccccccc',
  :'alice_pantry', 0.737, NULL, now() - interval '2 hour',
  '2026-08-01'
);
-- Lot B: full container (mass=900g, doesn't match).
INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts, expires_on
) VALUES (
  '44444444-4444-4444-4444-444444444444',
  tests.get_supabase_uid('promo_alice'),
  'cccc0001-cccc-cccc-cccc-cccccccccccc',
  :'alice_fridge', 1.0, NULL, now() - interval '1 hour',
  '2026-09-01'
);

SET LOCAL role postgres;
SELECT private.resolve_add_to_shelf_lot(
  tests.get_supabase_uid('promo_alice'),
  'cccc0001-cccc-cccc-cccc-cccccccccccc',
  'live_shelf',
  :'alice_fridge',
  663.0,  -- matches lot A within 50g tolerance
  NULL,
  now()
) AS multi_lot_pick \gset
RESET role;

SELECT tests.authenticate_as('promo_alice');

SELECT is(
  :'multi_lot_pick'::uuid,
  '33333333-3333-3333-3333-333333333333'::uuid,
  'multiple untracked lots → step 2.5 declines, step 3 picks weight-match'
);

SELECT is(
  (SELECT COUNT(*) FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('promo_alice')
      AND product_id = 'cccc0001-cccc-cccc-cccc-cccccccccccc'),
  2::bigint,
  'multi-lot path still has 2 lots (step 3 moves, doesn''t mint)'
);

------------------------------------------------------------
-- 4. Cross-user isolation. Alice's untracked lot must be
--    invisible to Bob's resolver run.
------------------------------------------------------------
-- Cleanup Alice's state.
DELETE FROM chefbyte.stock_lots
 WHERE lot_id IN (
   '33333333-3333-3333-3333-333333333333',
   '44444444-4444-4444-4444-444444444444'
 );

INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts
) VALUES (
  '55555555-5555-5555-5555-555555555555',
  tests.get_supabase_uid('promo_alice'),
  'cccc0001-cccc-cccc-cccc-cccccccccccc',
  :'alice_fridge', 1.0, NULL, now()
);

-- Bob's resolver run for HIS product. Should NOT touch Alice's lot.
SET LOCAL role postgres;
SELECT private.resolve_add_to_shelf_lot(
  tests.get_supabase_uid('promo_bob'),
  'dddd0001-dddd-dddd-dddd-dddddddddddd',
  'live_shelf',
  :'bob_fridge',
  500.0,
  NULL,
  now()
) AS bob_run \gset
RESET role;

SELECT tests.authenticate_as('promo_alice');

SELECT is(
  (SELECT last_update_source FROM chefbyte.stock_lots
    WHERE lot_id = '55555555-5555-5555-5555-555555555555'),
  NULL,
  'Bob''s resolver run did NOT promote Alice''s untracked lot (cross-user)'
);

------------------------------------------------------------
-- 5. live_shelf-tracked lot takes precedence over an untracked
--    sibling: step 2 wins, step 2.5 never sees the untracked row.
--    Cleanup, then seed both shapes.
------------------------------------------------------------
DELETE FROM chefbyte.stock_lots
 WHERE lot_id = '55555555-5555-5555-5555-555555555555';

-- Tracked: live_shelf qty=0.5
INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts
) VALUES (
  '66666666-6666-6666-6666-666666666666',
  tests.get_supabase_uid('promo_alice'),
  'cccc0001-cccc-cccc-cccc-cccccccccccc',
  :'alice_fridge', 0.5, 'live_shelf', now() - interval '30 min'
);
-- Untracked: pantry-style qty=1.0 with different expires_on so the
-- merge-key doesn't collide.
INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts, expires_on
) VALUES (
  '77777777-7777-7777-7777-777777777777',
  tests.get_supabase_uid('promo_alice'),
  'cccc0001-cccc-cccc-cccc-cccccccccccc',
  :'alice_pantry', 1.0, NULL, now() - interval '1 hour',
  '2026-08-15'
);

SET LOCAL role postgres;
SELECT private.resolve_add_to_shelf_lot(
  tests.get_supabase_uid('promo_alice'),
  'cccc0001-cccc-cccc-cccc-cccccccccccc',
  'live_shelf',
  :'alice_fridge',
  450.0,  -- half-bottle worth
  NULL,
  now()
) AS tracked_winner \gset
RESET role;

SELECT tests.authenticate_as('promo_alice');

SELECT is(
  :'tracked_winner'::uuid,
  '66666666-6666-6666-6666-666666666666'::uuid,
  'live_shelf-tracked lot wins via step 2 (step 2.5 never fires)'
);

SELECT is(
  (SELECT last_update_source FROM chefbyte.stock_lots
    WHERE lot_id = '77777777-7777-7777-7777-777777777777'),
  NULL,
  'untracked sibling lot stays untracked when a tracked lot already exists'
);

-- Updated 2026-04-29 (migration 20260429210000): step 2 must NOT bump
-- qty (return-of-existing-bottle, not a second container). qty stays at
-- the planted 0.5; placement weight goes to last_observed_weight_g.
SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '66666666-6666-6666-6666-666666666666')::numeric,
  0.5::numeric,
  'tracked lot qty preserved (return-of-existing-bottle, no qty bump)'
);

SELECT * FROM finish();
ROLLBACK;
