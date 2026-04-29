-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — apply_shelf_event(...) MUST be idempotent on
-- duplicate (user_id, client_event_id).
-- ════════════════════════════════════════════════════════════════════════════
-- Phase 1 audit finding L10/MEDIUM (AUDIT_FINDINGS_PHASE1.md):
--
--   "private.apply_shelf_event redefined 16 times across migrations;
--    signature drift risk. apply_shelf_event_signature_unique.test.sql
--    pins uniqueness, but the in-tree idempotency on duplicate
--    event_id invariant is not separately pinned for the latest
--    signature."
--
-- The unique key is `chefbyte.shelf_event_log (user_id, client_event_id)`.
-- A second call with the same key must:
--   1. Return the cached `(resolved_lot_id, applied, reason)` result.
--   2. NOT mutate `chefbyte.stock_lots` a second time (e.g. double-debit
--      qty_containers — the consumed branch is idempotent only because
--      of this rule).
--   3. NOT insert a second row in `chefbyte.shelf_event_log`.
--   4. NOT insert a second row in `chefbyte.food_logs`.
--
-- Coverage by branch:
--   * consumed     — exercised below (the most damaging branch — silent
--                    double-debit of qty + double-write of food_logs).
--   * added/refilled — exercised below (silent double-credit).
--
-- Companion mutation: removing the `INSERT … ON CONFLICT DO NOTHING /
-- RETURNING event_id` early-return + re-running the body unconditionally
-- trips the qty + food_logs assertions below.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(11);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('idempot_alice');
SELECT tests.authenticate_as('idempot_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('idempot_alice'),
  'Idempotent Test Product',
  500.000, 4,
  100, 10, 5, 2
);

SELECT product_id AS p_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('idempot_alice')
   AND name = 'Idempotent Test Product' \gset

SELECT location_id AS loc_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('idempot_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('idempot_alice'),
  'idempot-pi',
  'idempot_hash',
  true
);

SELECT device_id AS d_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('idempot_alice')
   AND device_name = 'idempot-pi' \gset

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('idempot_alice'),
  :'p_id', :'loc_id', 5.000,
  'live_shelf', now() - interval '5 minutes'
);

SET LOCAL role postgres;

------------------------------------------------------------
-- Case A: consumed branch is idempotent.
--
-- First call: debit qty (consume 1 serving = 125g out of 500g/4srv ctn).
-- Second call (same client_event_id): MUST be a no-op on qty + food_logs.
------------------------------------------------------------

SELECT * FROM private.apply_shelf_event(
  tests.get_supabase_uid('idempot_alice'),
  :'d_id'::UUID, 'scale-01', 'live_shelf', 'consumed',
  :'p_id'::UUID, 125.0, now()::TIMESTAMPTZ,
  'idempot-evt-consumed', NULL
);

SELECT qty_containers AS qty_after_first_consume,
       updated_at     AS lot_updated_after_first
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('idempot_alice')
   AND product_id = :'p_id' \gset

SELECT COUNT(*)::integer AS food_logs_after_first
  FROM chefbyte.food_logs
 WHERE user_id = tests.get_supabase_uid('idempot_alice') \gset

SELECT COUNT(*)::integer AS sel_after_first
  FROM chefbyte.shelf_event_log
 WHERE user_id = tests.get_supabase_uid('idempot_alice')
   AND client_event_id = 'idempot-evt-consumed' \gset

-- Replay the same event.
SELECT * FROM private.apply_shelf_event(
  tests.get_supabase_uid('idempot_alice'),
  :'d_id'::UUID, 'scale-01', 'live_shelf', 'consumed',
  :'p_id'::UUID, 125.0, now()::TIMESTAMPTZ,
  'idempot-evt-consumed', NULL
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('idempot_alice')
      AND product_id = :'p_id'),
  :qty_after_first_consume::numeric,
  'consumed branch idempotent: qty_containers MUST NOT change on replay '
    '(otherwise replay → double-debit → user inventory silently lost)'
);

SELECT is(
  (SELECT COUNT(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('idempot_alice')),
  :food_logs_after_first::integer,
  'consumed branch idempotent: food_logs row count MUST NOT grow on '
    'replay (otherwise replay → double-log macros)'
);

SELECT is(
  (SELECT COUNT(*)::integer FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('idempot_alice')
      AND client_event_id = 'idempot-evt-consumed'),
  :sel_after_first::integer,
  'consumed branch idempotent: shelf_event_log row count MUST NOT grow '
    'on replay (UNIQUE(user_id, client_event_id) enforces this)'
);

SELECT is(
  :sel_after_first::integer,
  1,
  'sanity: shelf_event_log row count is exactly 1 after the first call'
);

------------------------------------------------------------
-- Case B: refilled branch is idempotent (silent double-credit guard).
------------------------------------------------------------

SELECT qty_containers AS qty_pre_refill
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('idempot_alice')
   AND product_id = :'p_id' \gset

SELECT * FROM private.apply_shelf_event(
  tests.get_supabase_uid('idempot_alice'),
  :'d_id'::UUID, 'scale-01', 'live_shelf', 'refilled',
  :'p_id'::UUID, 250.0, now()::TIMESTAMPTZ,
  'idempot-evt-refill', NULL
);

SELECT qty_containers AS qty_after_first_refill
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('idempot_alice')
   AND product_id = :'p_id' \gset

-- Replay.
SELECT * FROM private.apply_shelf_event(
  tests.get_supabase_uid('idempot_alice'),
  :'d_id'::UUID, 'scale-01', 'live_shelf', 'refilled',
  :'p_id'::UUID, 250.0, now()::TIMESTAMPTZ,
  'idempot-evt-refill', NULL
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('idempot_alice')
      AND product_id = :'p_id'),
  :qty_after_first_refill::numeric,
  'refilled branch idempotent: qty_containers MUST NOT grow on replay'
);

------------------------------------------------------------
-- Case C: discarded branch is idempotent — already-zeroed lot edge case.
------------------------------------------------------------

UPDATE chefbyte.stock_lots
   SET qty_containers = 0
 WHERE user_id = tests.get_supabase_uid('idempot_alice')
   AND product_id = :'p_id';

SELECT * FROM private.apply_shelf_event(
  tests.get_supabase_uid('idempot_alice'),
  :'d_id'::UUID, 'scale-01', 'live_shelf', 'discarded',
  :'p_id'::UUID, 0, now()::TIMESTAMPTZ,
  'idempot-evt-discard', NULL
);

-- Replay.
SELECT * FROM private.apply_shelf_event(
  tests.get_supabase_uid('idempot_alice'),
  :'d_id'::UUID, 'scale-01', 'live_shelf', 'discarded',
  :'p_id'::UUID, 0, now()::TIMESTAMPTZ,
  'idempot-evt-discard', NULL
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('idempot_alice')
      AND product_id = :'p_id'),
  0::numeric,
  'discarded branch idempotent on already-zeroed lot — qty stays 0'
);

SELECT is(
  (SELECT COUNT(*)::integer FROM chefbyte.shelf_event_log
    WHERE user_id = tests.get_supabase_uid('idempot_alice')
      AND client_event_id = 'idempot-evt-discard'),
  1,
  'discarded branch idempotent: shelf_event_log row count is exactly 1 '
    'after replay'
);

------------------------------------------------------------
-- Case D: replay returns the SAME (resolved_lot_id, applied, reason)
--         tuple — pins the cached-result contract.
------------------------------------------------------------

SELECT applied AS first_applied,
       resolved_lot_id AS first_lot,
       reason AS first_reason
  FROM chefbyte.shelf_event_log
 WHERE user_id = tests.get_supabase_uid('idempot_alice')
   AND client_event_id = 'idempot-evt-consumed' \gset

-- The third call to the same event still returns the cached values.
SELECT applied AS third_applied,
       resolved_lot_id AS third_lot,
       reason AS third_reason
  FROM private.apply_shelf_event(
    tests.get_supabase_uid('idempot_alice'),
    :'d_id'::UUID, 'scale-01', 'live_shelf', 'consumed',
    :'p_id'::UUID, 125.0, now()::TIMESTAMPTZ,
    'idempot-evt-consumed', NULL
  ) \gset

SELECT is(
  :'third_applied'::BOOLEAN, :'first_applied'::BOOLEAN,
  'replay returns the cached `applied` flag (idempotency contract)'
);

SELECT is(
  :'third_lot'::UUID, :'first_lot'::UUID,
  'replay returns the cached `resolved_lot_id` (idempotency contract)'
);

SELECT is(
  :'third_reason'::TEXT, :'first_reason'::TEXT,
  'replay returns the cached `reason` (idempotency contract)'
);

------------------------------------------------------------
-- Case E: function signature is exactly 10 args (the latest
--         signature post-migration 20260427130000). A new arg
--         added without bumping callers fails this test.
------------------------------------------------------------

SELECT is(
  (SELECT pronargs::integer
     FROM pg_proc
     JOIN pg_namespace n ON n.oid = pg_proc.pronamespace
    WHERE n.nspname = 'private'
      AND proname = 'apply_shelf_event'),
  11,
  'apply_shelf_event signature is exactly 11 args (post-2026-04-29 '
    'p_usage_kind addition) — adding a 12th parameter without bumping '
    'the call sites + tests fails here'
);

SELECT * FROM finish();
ROLLBACK;
