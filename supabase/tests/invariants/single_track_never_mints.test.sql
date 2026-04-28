-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — single_track (live_scale) NEVER mints a lot
-- ════════════════════════════════════════════════════════════════════════════
-- Pins the no-mint rule for the LiveTrack single-track measurement scale
-- (chefbyte.scale_pairings.kind = 'live_scale'). The scale either:
--   1. Pulls from existing non-tracked inventory (claims an unpaired lot
--      of the same product via scale_pairings.lot_id), OR
--   2. Ignores the event entirely (no DB mutation).
--
-- Tonight's bug (2026-04-28): user scanned a gallon of milk → wizard
-- inserted a stock_lots row with qty_containers=1.0. User placed the
-- bottle on scale-03 (live_scale). The cloud applied with reason
-- 'promoted_untracked_lot' which ADDED qty (1.0 + 0.972 = 1.972) instead
-- of SETTING it. The "promote then add" path was structurally wrong for
-- a single-track scale — every event represents the absolute mass on the
-- scale (a SET, not an ADD), and a paired lot's qty must follow that
-- weight, not accumulate from it.
--
-- The contract (enforced by migration 20260428060000):
--   * private.resolve_add_to_shelf_lot rejects p_shelf_source='live_scale'
--     up-front with error message containing 'single_track_minted_a_lot'.
--   * private.apply_shelf_event for live_scale + (added|refilled) routes
--     through private.apply_live_scale_measurement which uses SET
--     semantics + claim-or-ignore (never INSERT).
--
-- A regression that re-introduces the mint path for live_scale (e.g.
-- removing the early reject from resolve_add_to_shelf_lot, or restoring
-- the resolve_add_to_shelf_lot call in the live_scale ADD branch) must
-- trip these tests with a clear "single_track minted a lot" message.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(8);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('invariant_st_alice');
SELECT tests.authenticate_as('invariant_st_alice');
SELECT hub.activate_app('chefbyte');

-- A device with a paired live_scale.
INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('invariant_st_alice'),
  'invariant single-track device',
  'sha256-placeholder-st',
  true
);

SELECT device_id AS d_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('invariant_st_alice')
   AND device_name = 'invariant single-track device' \gset

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('invariant_st_alice'),
  'ST Invariant Whole Milk',
  3785.410, 16,
  150, 12, 8, 8
);

SELECT product_id AS p_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('invariant_st_alice')
   AND name = 'ST Invariant Whole Milk' \gset

SELECT location_id AS loc_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('invariant_st_alice')
   AND name = 'Fridge' \gset

------------------------------------------------------------
-- Test 1: paired lot, SET semantics on refilled event
------------------------------------------------------------

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts, expires_on
) VALUES (
  tests.get_supabase_uid('invariant_st_alice'),
  :'p_id', :'loc_id', 1.000,
  'manual', now() - interval '5 minutes',
  '2027-12-31'::date
);

SELECT lot_id AS paired_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('invariant_st_alice')
   AND product_id = :'p_id' \gset

INSERT INTO chefbyte.scale_pairings (
  user_id, device_id, scale_id, kind, product_id, lot_id
) VALUES (
  tests.get_supabase_uid('invariant_st_alice'),
  :'d_id'::uuid,
  'scale-03', 'live_scale', :'p_id', :'paired_lot_id'
);

SET LOCAL role postgres;

SELECT COUNT(*) AS lots_before
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('invariant_st_alice')
   AND product_id = :'p_id' \gset

-- Drive the apply path. p_after_weight_g = 3785.41g = 1 full container.
SELECT private.apply_shelf_event(
  tests.get_supabase_uid('invariant_st_alice'),
  :'d_id'::uuid,
  'scale-03', 'live_scale', 'refilled',
  :'p_id'::uuid, 3785.410, now(),
  'client-event-paired-set-1', NULL, 3785.410
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'paired_lot_id')::numeric(10,3),
  1.000::numeric(10,3),
  'invariant: paired live_scale refilled MUST SET qty (not ADD). '
    'Expected qty=1.000 after refilled event of 1 container. A value '
    '> 1.000 means the resolver double-counted (today''s bug).'
);

SELECT is(
  (SELECT COUNT(*)::integer FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('invariant_st_alice')
      AND product_id = :'p_id'),
  :'lots_before'::integer,
  'invariant: single_track_never_mints — live_scale refilled MUST NOT '
    'INSERT a new stock_lots row. Row count after MUST equal count '
    'before. A new row here means a mint path is reachable for live_scale.'
);

------------------------------------------------------------
-- Test 2: NO pairing row → event ignored, no DB mutation
------------------------------------------------------------

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('invariant_st_alice'),
  'ST Invariant Orange Juice',
  1893.000, 8,
  120, 28, 1, 0
);

SELECT product_id AS p2_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('invariant_st_alice')
   AND name = 'ST Invariant Orange Juice' \gset

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts, expires_on
) VALUES (
  tests.get_supabase_uid('invariant_st_alice'),
  :'p2_id', :'loc_id', 0.500,
  'manual', now() - interval '1 hour',
  '2027-09-30'::date
);

SELECT lot_id AS oj_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('invariant_st_alice')
   AND product_id = :'p2_id' \gset

SELECT COUNT(*) AS oj_lots_before
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('invariant_st_alice')
   AND product_id = :'p2_id' \gset

-- No scale_pairings row for scale-99. Event MUST be ignored.
SELECT private.apply_shelf_event(
  tests.get_supabase_uid('invariant_st_alice'),
  :'d_id'::uuid,
  'scale-99', 'live_scale', 'refilled',
  :'p2_id'::uuid, 1893.000, now(),
  'client-event-no-pairing-1', NULL, 1893.000
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'oj_lot_id')::numeric(10,3),
  0.500::numeric(10,3),
  'invariant: live_scale refilled with NO scale_pairings row MUST NOT '
    'mutate any existing lot. Manual OJ lot must remain at qty=0.500.'
);

SELECT is(
  (SELECT COUNT(*)::integer FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('invariant_st_alice')
      AND product_id = :'p2_id'),
  :'oj_lots_before'::integer,
  'invariant: single_track_never_mints — live_scale refilled with no '
    'pairing MUST NOT INSERT a new stock_lots row. A new row here '
    'means the no-pairing branch fell through to a mint path.'
);

SELECT ok(
  (SELECT reason LIKE 'live_scale_no_pairing%'
     FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('invariant_st_alice')
      AND client_event_id = 'client-event-no-pairing-1'),
  'invariant: shelf_event_log.reason starts with live_scale_no_pairing '
    'when the event is ignored — operators need this fingerprint to '
    'find ignored events in the audit trail.'
);

------------------------------------------------------------
-- Test 3: pairing exists but lot_id is NULL + exactly one unpaired lot
-- of the same product → claim & SET (no mint).
------------------------------------------------------------

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('invariant_st_alice'),
  'ST Invariant Iced Tea',
  1000.000, 4,
  90, 22, 0, 0
);

SELECT product_id AS p3_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('invariant_st_alice')
   AND name = 'ST Invariant Iced Tea' \gset

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts, expires_on
) VALUES (
  tests.get_supabase_uid('invariant_st_alice'),
  :'p3_id', :'loc_id', 1.000,
  'manual', now() - interval '10 minutes',
  '2027-10-31'::date
);

SELECT lot_id AS tea_lot_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('invariant_st_alice')
   AND product_id = :'p3_id' \gset

INSERT INTO chefbyte.scale_pairings (
  user_id, device_id, scale_id, kind, product_id, lot_id
) VALUES (
  tests.get_supabase_uid('invariant_st_alice'),
  :'d_id'::uuid,
  'scale-04', 'live_scale', :'p3_id', NULL
);

SELECT COUNT(*) AS tea_lots_before
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('invariant_st_alice')
   AND product_id = :'p3_id' \gset

-- Half-full bottle = 500g of a 1000g product = 0.5 containers.
SELECT private.apply_shelf_event(
  tests.get_supabase_uid('invariant_st_alice'),
  :'d_id'::uuid,
  'scale-04', 'live_scale', 'refilled',
  :'p3_id'::uuid, 500.000, now(),
  'client-event-claim-1', NULL, 500.000
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'tea_lot_id')::numeric(10,3),
  0.500::numeric(10,3),
  'invariant: live_scale refilled with NULL pairing.lot_id and exactly '
    'one unpaired lot MUST claim it and SET qty := after_weight/net_weight. '
    'Expected qty=0.500 (500g / 1000g net).'
);

SELECT is(
  (SELECT lot_id FROM chefbyte.scale_pairings
    WHERE scale_id = 'scale-04'
      AND user_id = tests.get_supabase_uid('invariant_st_alice')),
  :'tea_lot_id'::uuid,
  'invariant: claim path MUST update scale_pairings.lot_id to the '
    'claimed lot — without this the next event would re-run the claim '
    'logic and might pick a different lot.'
);

SELECT is(
  (SELECT COUNT(*)::integer FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('invariant_st_alice')
      AND product_id = :'p3_id'),
  :'tea_lots_before'::integer,
  'invariant: single_track_never_mints — claim path MUST NOT INSERT a '
    'new lot. Row count after MUST equal count before.'
);

SELECT * FROM finish();
ROLLBACK;
