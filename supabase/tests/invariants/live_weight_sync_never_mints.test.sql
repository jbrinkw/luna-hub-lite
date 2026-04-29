-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — live_weight_sync NEVER mints OR mutates qty.
-- ════════════════════════════════════════════════════════════════════════════
-- Phase 1 audit finding L11/HIGH (AUDIT_FINDINGS_PHASE1.md):
--
--   "live_scale_never_mints.test.sql exists for the original event_kinds.
--    The newly-added live_weight_sync event (migration 20260429030000) routes
--    through private.apply_live_weight_sync_admin, a different code path. No
--    pgTAP asserts live_weight_sync with kind='live_scale' AND a non-existing
--    pi_lot_id does not mint a stock_lots row."
--
-- The companion `live_weight_sync.test.sql` covers happy-path semantics. This
-- file pins the systemic-bug class that destroyed user trust during the
-- 2026-04-28 single_track regression — namely that ANY new code path which
-- accepts a Pi-emitted weight signal must NEVER mint a lot. live_weight_sync
-- is the third code path (after consumed/depleted and added/refilled), so it
-- gets its own pinning test.
--
-- Scenarios:
--   1. live_weight_sync with kind='live_scale' and a non-existing pi_lot_id
--      → applied=false, reason='lot_id not found', NO new stock_lots row.
--   2. live_weight_sync with kind='live_shelf' and a non-existing pi_lot_id
--      → same applied=false, NO mint (covers the second permitted kind).
--   3. live_weight_sync with kind='live_scale' targeting an EXISTING qty=0
--      lot → qty stays at 0, no second row minted (paranoia: rules out a
--      "mint a fresh lot when target is empty" regression).
--
-- The companion test_quality-tier mutation: re-introducing an `INSERT INTO
-- stock_lots` in the apply_live_weight_sync helper (or a "fall back to mint"
-- branch when the lot lookup misses) trips assertions 1, 2, 5 below.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(8);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('lwsnm_alice');
SELECT tests.authenticate_as('lwsnm_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('lwsnm_alice'),
  'LWSNM Test Product',
  1500.000, 6,
  200, 30, 5, 8
);

SELECT product_id AS p_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('lwsnm_alice')
   AND name = 'LWSNM Test Product' \gset

SELECT location_id AS fridge_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('lwsnm_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('lwsnm_alice'),
  'lwsnm-pi',
  'lwsnm_hash_alice',
  true
);

SELECT device_id AS d_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('lwsnm_alice')
   AND device_name = 'lwsnm-pi' \gset

SET LOCAL role postgres;

-- Snapshot starting lot count so assertions are robust to any seed data.
SELECT COUNT(*)::bigint AS baseline_lots
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('lwsnm_alice') \gset

------------------------------------------------------------
-- Case 1: live_scale + non-existing pi_lot_id → NO mint, applied=false.
------------------------------------------------------------

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_live_weight_sync(
        %L::UUID, %L::UUID, 'scale-single', 'live_scale',
        '99999999-9999-9999-9999-999999999999'::UUID,
        2400.0::NUMERIC, now()::TIMESTAMPTZ, 'lwsnm-evt-1', NULL
      )$$,
    tests.get_supabase_uid('lwsnm_alice'),
    :'d_id'
  ),
  'case 1: live_weight_sync (live_scale) on non-existing pi_lot_id runs without raising'
);

SELECT is(
  (SELECT COUNT(*)::bigint FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('lwsnm_alice')),
  :baseline_lots::bigint,
  'case 1: live_weight_sync (live_scale) MUST NOT mint a stock_lots row '
    'when pi_lot_id does not resolve — same systemic-bug class as the '
    '2026-04-28 single_track regression, on a different code path.'
);

SELECT is(
  (SELECT applied FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('lwsnm_alice')
      AND client_event_id = 'lwsnm-evt-1'),
  false,
  'case 1: applied=false because the lot did not resolve'
);

SELECT is(
  (SELECT reason FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('lwsnm_alice')
      AND client_event_id = 'lwsnm-evt-1'),
  'lot_id not found',
  'case 1: reason explains why the row was rejected'
);

------------------------------------------------------------
-- Case 2: live_shelf + non-existing pi_lot_id → also NO mint.
------------------------------------------------------------

SELECT * FROM private.apply_live_weight_sync(
  tests.get_supabase_uid('lwsnm_alice'),
  :'d_id'::UUID, 'scale-01', 'live_shelf',
  '88888888-8888-8888-8888-888888888888'::UUID,
  1200.0::NUMERIC, now()::TIMESTAMPTZ, 'lwsnm-evt-2', NULL
);

SELECT is(
  (SELECT COUNT(*)::bigint FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('lwsnm_alice')),
  :baseline_lots::bigint,
  'case 2: live_weight_sync (live_shelf) MUST NOT mint a stock_lots row '
    'when pi_lot_id does not resolve — both permitted kinds are pinned.'
);

------------------------------------------------------------
-- Case 3: live_weight_sync against an EXISTING zero-qty lot.
--         Verify qty stays at 0 AND no parallel row is minted.
------------------------------------------------------------

INSERT INTO chefbyte.stock_lots (
  lot_id, user_id, product_id, location_id,
  qty_containers, last_update_source, last_update_ts
) VALUES (
  '77777777-7777-7777-7777-777777777777',
  tests.get_supabase_uid('lwsnm_alice'),
  :'p_id', :'fridge_id',
  0.000, 'live_shelf', now() - interval '1 hour'
);

SELECT COUNT(*)::bigint AS pre_case3_count
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('lwsnm_alice')
   AND product_id = :'p_id' \gset

SELECT * FROM private.apply_live_weight_sync(
  tests.get_supabase_uid('lwsnm_alice'),
  :'d_id'::UUID, 'scale-01', 'live_shelf',
  '77777777-7777-7777-7777-777777777777'::UUID,
  450.0::NUMERIC, now()::TIMESTAMPTZ, 'lwsnm-evt-3', NULL
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '77777777-7777-7777-7777-777777777777')::numeric(10,3),
  0.000::numeric(10,3),
  'case 3: live_weight_sync MUST NOT mutate qty_containers — only '
    'last_observed_weight_g + last_observed_at. A regression that bumps '
    'qty when the observed weight is non-zero corrupts inventory totals.'
);

SELECT is(
  (SELECT COUNT(*)::bigint FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('lwsnm_alice')
      AND product_id = :'p_id'),
  :pre_case3_count::bigint,
  'case 3: same-product lot count UNCHANGED — live_weight_sync MUST '
    'NEVER mint a parallel row when the targeted lot resolved.'
);

-- Confirm the helper actually ran (not a no-op early-return) — last_observed_*
-- must have been written.
SELECT isnt(
  (SELECT last_observed_weight_g FROM chefbyte.stock_lots
    WHERE lot_id = '77777777-7777-7777-7777-777777777777'),
  NULL,
  'case 3: last_observed_weight_g WAS written — confirms the assertions '
    'above exercised the real apply branch, not a dedup early-return.'
);

SELECT * FROM finish();
ROLLBACK;
