-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — live_scale (single-track) NEVER mints AND NEVER
-- accumulates qty on an existing lot.
-- ════════════════════════════════════════════════════════════════════════════
-- User-reported bug 2026-04-28:
--
--   "I just scanned a gallon of milk, bringing my inventory from 0 to 1
--    container, and then I put it on the single track scale, and now I
--    have 2 containers."
--
-- Sequence:
--   1. User scans the milk barcode → wizard inserts a stock_lots row
--      (qty=1, last_update_source=NULL).
--   2. User places the gallon on a paired live_scale → Pi emits a
--      ``refilled`` event with delta_g≈3677g (the bottle's full mass).
--   3. PRE-FIX cloud routed live_scale ADD through resolve_add_to_shelf_lot,
--      which hit step 2.5 (promote untracked lot) — promoted the wizard
--      lot to source=live_scale AND ADDED qty (3677/1537.8 ≈ 2.39).
--      Inventory shows 3.39 ctn instead of 1.0.
--
-- User's hard rule (this invariant pins it):
--
--   A single-track (live_scale) ADD/refilled event MUST NEVER mint a new
--   stock_lots row, AND MUST NEVER accumulate qty onto an existing lot.
--   Its only side-effect on lot qty is via consumed/depleted events.
--
--   For ADD/refilled the legitimate behaviour is "claim an existing lot
--   for the paired product" (auto-pair + flip last_update_source) or
--   "no-op" when no candidate exists. Qty is preserved either way.
--
-- The companion test_quality-tier mutation: re-introducing a `qty + delta`
-- arithmetic on the live_scale ADD branch (or a `mint a new row` fallback)
-- trips assertions 1+2 below.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
-- Gap G1 (20260515010000): test plumbing DELETEs between cases need
-- bypass; test exercises live_scale single-track semantics, not the
-- delete-guard.
SET LOCAL chefbyte.stock_lots_allow_hard_delete = 'on';
SELECT plan(8);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('lsnm_alice');
SELECT tests.authenticate_as('lsnm_alice');
SELECT hub.activate_app('chefbyte');

-- Whole milk: 3677.856 g full container, 8 servings (matches user's repro).
INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('lsnm_alice'),
  'LSNM Whole Milk',
  3677.856, 8,
  150, 12, 8, 8
);

SELECT product_id AS p_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('lsnm_alice')
   AND name = 'LSNM Whole Milk' \gset

SELECT location_id AS fridge_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('lsnm_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('lsnm_alice'),
  'lsnm-pi',
  'lsnm_hash_alice',
  true
);

SELECT device_id AS d_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('lsnm_alice')
   AND device_name = 'lsnm-pi' \gset

SET LOCAL role postgres;

------------------------------------------------------------
-- Case 1: User's exact bug repro.
--
--   Pre-state: untracked qty=1.0 lot from a barcode scan
--   (last_update_source=NULL).
--   Event:     live_scale refilled with delta_g=3677.856 (full bottle).
--   Expected:  qty STAYS at 1.0. Lot is claimed (source flipped to
--              live_scale). No new row minted.
------------------------------------------------------------

INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts
) VALUES (
  '11111111-aaaa-aaaa-aaaa-111111111111',
  tests.get_supabase_uid('lsnm_alice'),
  :'p_id',
  :'fridge_id',
  1.0, NULL, now() - interval '1 hour'
);

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-03', 'live_scale', 'refilled',
        %L::UUID, 3677.856, now()::TIMESTAMPTZ, 'lsnm-evt-1', NULL
      )$$,
    tests.get_supabase_uid('lsnm_alice'),
    :'d_id',
    :'p_id'
  ),
  'case 1 (bug repro): live_scale refilled on untracked qty=1.0 lot runs without error'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '11111111-aaaa-aaaa-aaaa-111111111111')::numeric(10,3),
  1.000::numeric(10,3),
  'case 1 (bug repro): qty STAYS at 1.0 — single_track must NOT accumulate '
    '(pre-fix qty became ≈3.39)'
);

SELECT is(
  (SELECT COUNT(*)::bigint FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('lsnm_alice')
      AND product_id = :'p_id'),
  1::bigint,
  'case 1 (bug repro): exactly ONE lot exists — single_track must NEVER mint '
    'a new row'
);

SELECT is(
  (SELECT last_update_source FROM chefbyte.stock_lots
    WHERE lot_id = '11111111-aaaa-aaaa-aaaa-111111111111'),
  'live_scale',
  'case 1 (bug repro): existing untracked lot was claimed (source flipped to live_scale)'
);

SELECT is(
  (SELECT applied FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('lsnm_alice')
      AND client_event_id = 'lsnm-evt-1'),
  true,
  'case 1 (bug repro): event applied=true (claim is a successful no-op on qty)'
);

------------------------------------------------------------
-- Case 2: No existing lot at all → applied=true no-op (no mint).
--
--   This is the matrix-test-compatible path. The live_scale event
--   has nothing to claim, but must still report applied=true so the
--   EMIT→HANDLE matrix invariant is satisfied. CRUCIALLY, no new
--   stock_lots row may appear.
------------------------------------------------------------

-- Wipe the case-1 lot.
DELETE FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('lsnm_alice')
   AND product_id = :'p_id';

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-03', 'live_scale', 'refilled',
        %L::UUID, 3677.856, now()::TIMESTAMPTZ, 'lsnm-evt-2', NULL
      )$$,
    tests.get_supabase_uid('lsnm_alice'),
    :'d_id',
    :'p_id'
  ),
  'case 2 (no-lot): live_scale refilled on product with NO lots runs without error'
);

SELECT is(
  (SELECT COUNT(*)::bigint FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('lsnm_alice')
      AND product_id = :'p_id'),
  0::bigint,
  'case 2 (no-lot): NO stock_lots row was minted — single_track must never mint'
);

SELECT is(
  (SELECT applied FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('lsnm_alice')
      AND client_event_id = 'lsnm-evt-2'),
  true,
  'case 2 (no-lot): event applied=true (matrix EMIT→HANDLE invariant)'
);

SELECT * FROM finish();
ROLLBACK;
