-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — `discarded` MUST NOT write food_logs
-- ════════════════════════════════════════════════════════════════════════════
-- Pins decisions.md #44 (manual discard event_kind):
--   "Sets last_update_source='manual_discard' ... Does NOT insert into
--    food_logs (no macro tracking by design — spilled / fed-to-pet /
--    given-away)."
--
-- An accidental food_logs INSERT inside the discarded branch (e.g.
-- copy-paste from the consumed branch) silently corrupts the user's
-- macro totals every time they discard a lot. This invariant pins
-- the design contract — non-zero food_logs after discard means the
-- design rule was broken.
--
-- Existing coverage: shelf_event_discarded.test.sql case 1 has a
-- food_logs assertion. This file adds a tighter, decision-focused
-- assertion across MULTIPLE lot states (qty>0, in_flight, etc.) so a
-- regression in any one branch is caught.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(6);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('invariant_disc_alice');
SELECT tests.authenticate_as('invariant_disc_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('invariant_disc_alice'),
  'Invariant Disc Product',
  1500.000, 3,
  300, 40, 20, 10  -- non-trivial macros so a single qty would burn 100s of cals
);

SELECT product_id AS p_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('invariant_disc_alice')
   AND name = 'Invariant Disc Product' \gset

SELECT location_id AS loc_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('invariant_disc_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('invariant_disc_alice'),
  'invariant-pi',
  'invariant_disc_hash',
  true
);

SELECT device_id AS d_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('invariant_disc_alice')
   AND device_name = 'invariant-pi' \gset

SET LOCAL role postgres;

------------------------------------------------------------
-- Case 1: discard on qty>0 live lot — NO food_logs row
------------------------------------------------------------

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('invariant_disc_alice'),
  :'p_id', :'loc_id', 2.000,
  'live_shelf', now() - interval '5 minutes'
);

SELECT * FROM private.apply_shelf_event(
  tests.get_supabase_uid('invariant_disc_alice'),
  :'d_id'::UUID, 'scale-01', 'live_shelf', 'discarded',
  :'p_id'::UUID, 0, now()::TIMESTAMPTZ, 'invariant-disc-evt-1', NULL
);

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('invariant_disc_alice')),
  0,
  'invariant (decision #44): discarded on qty>0 lot MUST NOT write '
    'food_logs. A row here means the discard branch is silently '
    'tracking macros — corrupts user totals every time they spill '
    'or feed-to-pet.'
);

------------------------------------------------------------
-- Case 2: discard on in_flight lot — STILL NO food_logs row
------------------------------------------------------------
-- Set the lot back to in_flight to test the secondary discard branch.
UPDATE chefbyte.stock_lots
   SET qty_containers = 1.500,
       in_flight_since = now() - interval '1 hour',
       pickup_event_id = '22222222-2222-2222-2222-222222222222'
 WHERE user_id = tests.get_supabase_uid('invariant_disc_alice')
   AND product_id = :'p_id';

SELECT * FROM private.apply_shelf_event(
  tests.get_supabase_uid('invariant_disc_alice'),
  :'d_id'::UUID, 'scale-01', 'live_shelf', 'discarded',
  :'p_id'::UUID, 0, now()::TIMESTAMPTZ, 'invariant-disc-evt-2', NULL
);

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('invariant_disc_alice')),
  0,
  'invariant (decision #44): discarded on in_flight lot MUST NOT '
    'write food_logs. The secondary discard branch (clearing '
    'in_flight markers) is the path users hit on stuck-in-flight '
    'recovery — silently logging macros there is even worse '
    'because the user is explicitly rescuing a tracking bug.'
);

------------------------------------------------------------
-- Case 3: discard on already-zeroed lot — idempotent, NO food_logs
------------------------------------------------------------
-- Lot is already at qty=0 from the previous case.
SELECT * FROM private.apply_shelf_event(
  tests.get_supabase_uid('invariant_disc_alice'),
  :'d_id'::UUID, 'scale-01', 'live_shelf', 'discarded',
  :'p_id'::UUID, 0, now()::TIMESTAMPTZ, 'invariant-disc-evt-3', NULL
);

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('invariant_disc_alice')),
  0,
  'invariant (decision #44): idempotent discard on already-zeroed '
    'lot MUST NOT write food_logs. Re-running the discard (e.g. UI '
    'retry) cannot multiply macros.'
);

------------------------------------------------------------
-- Case 4: discard branch never burns macros even when product has
--         non-trivial macro values (regression guard against
--         "fix_calories_when_zero" style backfills).
------------------------------------------------------------

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('invariant_disc_alice'),
  'Heavy Macro Product',
  500.000, 1,
  900, 100, 50, 50
);

SELECT product_id AS p2_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('invariant_disc_alice')
   AND name = 'Heavy Macro Product' \gset

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('invariant_disc_alice'),
  :'p2_id', :'loc_id', 5.000,
  'live_shelf', now() - interval '5 minutes'
);

SELECT * FROM private.apply_shelf_event(
  tests.get_supabase_uid('invariant_disc_alice'),
  :'d_id'::UUID, 'scale-01', 'live_shelf', 'discarded',
  :'p2_id'::UUID, 0, now()::TIMESTAMPTZ, 'invariant-disc-evt-4', NULL
);

-- Critically: even with 4500 cal of food_in_lot, NO food_logs row.
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('invariant_disc_alice')
      AND product_id = :'p2_id'),
  0,
  'invariant (decision #44): discarding a high-macro lot (5 ctn '
    '× 900cal = 4500cal) MUST NOT write a food_logs row. This is '
    'the bug class that would silently inject hundreds of '
    'phantom calories into the daily total.'
);

------------------------------------------------------------
-- Case 5: NEW lot-targeted discard path — apply_discard_with_lot_id
--         must NOT write food_logs even though it has its own
--         independent shelf_event_log + UPDATE branch (audit
--         finding L11/MEDIUM, 20260428030000_discard_lot_by_id.sql).
--
-- The legacy apply_shelf_event branch is exercised in cases 1–4. This
-- block pins the new helper introduced for catch-all empty-bottle
-- routing so a regression that copies-paste from the consumed branch
-- is caught here too.
------------------------------------------------------------

-- Use a non-default expires_on so the merge-key constraint
-- (UNIQUE(user_id, product_id, location_id, COALESCE(expires_on, '9999-12-31')))
-- doesn't collide with case 4's already-zeroed lot.
INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts,
  expires_on
) VALUES (
  '55555555-5555-5555-5555-555555555555',
  tests.get_supabase_uid('invariant_disc_alice'),
  :'p2_id', :'loc_id', 4.000,
  'live_shelf', now() - interval '5 minutes',
  CURRENT_DATE + INTERVAL '60 days'
);

-- Snapshot current food_logs count for this user so the assertion is
-- robust to anything earlier in the test that might have inserted.
SELECT COUNT(*)::integer AS pre_discard_logs
  FROM chefbyte.food_logs
 WHERE user_id = tests.get_supabase_uid('invariant_disc_alice') \gset

SELECT * FROM private.apply_discard_with_lot_id(
  tests.get_supabase_uid('invariant_disc_alice'),
  :'d_id'::UUID, 'scale-02', 'catch_all',
  '55555555-5555-5555-5555-555555555555'::UUID,
  :'p2_id'::UUID,
  now()::TIMESTAMPTZ, 'invariant-disc-evt-5', NULL
);

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('invariant_disc_alice')),
  :pre_discard_logs::integer,
  'invariant (decision #44, lot-targeted): apply_discard_with_lot_id '
    'MUST NOT write food_logs. Catch-all empty-bottle short-circuit '
    'targets a specific lot — silently logging macros there would '
    're-introduce the bug class the lot-targeted discard helper was '
    'introduced to bound.'
);

-- Sanity: the lot was actually zeroed (so we know the helper ran the
-- UPDATE branch, not just the dedup early-return).
SELECT is(
  (SELECT qty_containers::numeric(10,3) FROM chefbyte.stock_lots
    WHERE lot_id = '55555555-5555-5555-5555-555555555555'),
  0.000::numeric(10,3),
  'apply_discard_with_lot_id zeroed qty_containers — confirms the '
    'no-food_logs assertion above exercised the real UPDATE branch.'
);

SELECT * FROM finish();
ROLLBACK;
