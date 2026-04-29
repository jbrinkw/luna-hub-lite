-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — the cloud-side `updated_at` watermark contract.
-- ════════════════════════════════════════════════════════════════════════════
-- Phase 1 audit finding L11/HIGH (AUDIT_FINDINGS_PHASE1.md):
--
--   "watermark must NOT advance on skipped/failed apply" rule is unpinned.
--
-- The Pi's poller layer (event_overrides_poller, lot_snapshot_poller,
-- product_sync_poller) advances its in-memory watermark only over
-- successfully-applied rows (the freeze-on-skip rule, exercised by
-- ``test_skipped_override_freezes_watermark_and_retries`` in
-- ``cloud/tests/test_event_overrides_poller.py``).
--
-- The cloud's contract — the part this pgTAP can test — is the OTHER
-- half of the invariant: every mutating write to the source-of-truth
-- tables MUST bump ``updated_at`` so the Pi's ``gt(watermark)`` filter
-- never misses a row. If a future migration accidentally drops the
-- trigger, the Pi keeps polling but stops seeing changes — a silent
-- divergence that the freeze-on-skip rule cannot detect.
--
-- IMPLEMENTATION NOTE on `now()` semantics inside pgTAP:
--   pgTAP runs inside a single ``BEGIN; ... ROLLBACK;`` so ``now()``
--   returns the same wall-clock instant for every statement. The
--   trigger uses ``NEW.updated_at := now()`` — within the test we
--   can't observe a strict-advance (every call to now() returns the
--   transaction start time). We can, however, verify the trigger:
--     1. EXISTS on the right table with the right name.
--     2. FIRES on UPDATE — it overwrites a manually-set "older" value
--        with the transaction's now(). If the trigger doesn't run, the
--        manually-set value persists; if it does run, the overwrite
--        replaces it. We assert the post-UPDATE value equals the
--        transaction's now() (matches transaction_timestamp()).
--   This catches a regression that drops or disables the trigger.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(7);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('wm_alice');
SELECT tests.authenticate_as('wm_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('wm_alice'),
  'Watermark Test Product',
  500.000, 4,
  100, 10, 5, 2
);

SELECT product_id AS p_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('wm_alice')
   AND name = 'Watermark Test Product' \gset

SELECT location_id AS loc_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('wm_alice')
   AND name = 'Fridge' \gset

------------------------------------------------------------
-- Invariant 1: Products `updated_at` trigger fires on UPDATE.
--   Setting updated_at to a manually-old value should be over-
--   written by the trigger to transaction_timestamp().
------------------------------------------------------------

UPDATE chefbyte.products
   SET updated_at = '2020-01-01 00:00:00+00'::TIMESTAMPTZ,
       name = name  -- forces trigger
 WHERE product_id = :'p_id';

-- After the UPDATE, the trigger's NEW.updated_at := now() should
-- have fired AFTER the SET, so the column equals now() (the txn
-- start), NOT 2020-01-01.
SELECT is(
  (SELECT updated_at FROM chefbyte.products WHERE product_id = :'p_id'),
  transaction_timestamp(),
  'invariant: products UPDATE trigger fired and overwrote the '
    'manually-set 2020-01-01 with transaction_timestamp(). If the '
    'trigger were missing, the column would still be 2020-01-01 — '
    'and product_sync_poller would silently miss the row in its '
    'gt(watermark) filter.'
);

------------------------------------------------------------
-- Invariant 2: Soft-delete UPDATE on products also runs the trigger.
------------------------------------------------------------

UPDATE chefbyte.products
   SET updated_at = '2020-01-01 00:00:00+00'::TIMESTAMPTZ,
       deleted_at = now()
 WHERE product_id = :'p_id';

SELECT is(
  (SELECT updated_at FROM chefbyte.products WHERE product_id = :'p_id'),
  transaction_timestamp(),
  'invariant: products soft-delete (deleted_at flip) also bumps '
    'updated_at via the trigger. Without this, the Pi never sees '
    'the tombstone in the delta window.'
);

UPDATE chefbyte.products SET deleted_at = NULL WHERE product_id = :'p_id';

------------------------------------------------------------
-- Invariant 3: stock_lots updated_at trigger fires on UPDATE.
------------------------------------------------------------

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('wm_alice'),
  :'p_id', :'loc_id', 3.000,
  'live_shelf', now() - interval '5 minutes'
);

SELECT lot_id AS lot1_id
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('wm_alice')
   AND product_id = :'p_id' \gset

UPDATE chefbyte.stock_lots
   SET updated_at = '2020-01-01 00:00:00+00'::TIMESTAMPTZ,
       qty_containers = 2.500
 WHERE lot_id = :'lot1_id'::UUID;

SELECT is(
  (SELECT updated_at FROM chefbyte.stock_lots WHERE lot_id = :'lot1_id'::UUID),
  transaction_timestamp(),
  'invariant: stock_lots UPDATE trigger fired and overwrote the '
    'manually-set 2020-01-01 with transaction_timestamp().'
);

------------------------------------------------------------
-- Invariant 4: stock_lots soft-delete also fires the trigger.
------------------------------------------------------------

UPDATE chefbyte.stock_lots
   SET updated_at = '2020-01-01 00:00:00+00'::TIMESTAMPTZ,
       deleted_at = now()
 WHERE lot_id = :'lot1_id'::UUID;

SELECT is(
  (SELECT updated_at FROM chefbyte.stock_lots WHERE lot_id = :'lot1_id'::UUID),
  transaction_timestamp(),
  'invariant: stock_lots soft-delete also bumps updated_at via the '
    'trigger.'
);

UPDATE chefbyte.stock_lots SET deleted_at = NULL WHERE lot_id = :'lot1_id'::UUID;

------------------------------------------------------------
-- Invariant 5: event_overrides has NO trigger — its apply path
-- must explicitly set updated_at. Pin the column shape supports
-- the watermark contract by writing a value strictly newer than
-- the inserted one and asserting it sticks.
------------------------------------------------------------

INSERT INTO chefbyte.event_overrides (
  user_id, client_event_id,
  is_voided, updated_at
) VALUES (
  tests.get_supabase_uid('wm_alice'),
  'wm-evt-1',
  false,
  '2020-01-01 00:00:00+00'::TIMESTAMPTZ
);

UPDATE chefbyte.event_overrides
   SET is_voided = true,
       updated_at = transaction_timestamp()
 WHERE user_id = tests.get_supabase_uid('wm_alice')
   AND client_event_id = 'wm-evt-1';

SELECT cmp_ok(
  (SELECT updated_at FROM chefbyte.event_overrides
    WHERE user_id = tests.get_supabase_uid('wm_alice')
      AND client_event_id = 'wm-evt-1'),
  '>',
  '2020-01-01 00:00:00+00'::TIMESTAMPTZ,
  'invariant: event_overrides.updated_at advances when the apply '
    'path sets it explicitly — event_overrides_poller relies on '
    'this for gt(watermark). NB: no trigger here; the apply RPC '
    'must call SET updated_at=now() explicitly.'
);

------------------------------------------------------------
-- Invariant 6+7: trigger existence — pin both triggers exist by
-- name so a migration that drops them without a replacement trips
-- this test instead of going silent.
------------------------------------------------------------

SELECT has_trigger(
  'chefbyte'::name, 'stock_lots'::name,
  'stock_lots_set_updated_at'::name,
  'invariant: stock_lots_set_updated_at trigger exists. Dropping it '
    'breaks lot_snapshot_poller silently — Pi keeps polling but stops '
    'seeing rows.'
);

SELECT has_trigger(
  'chefbyte'::name, 'products'::name,
  'products_set_updated_at'::name,
  'invariant: products_set_updated_at trigger exists. Dropping it '
    'breaks product_sync_poller silently.'
);

SELECT * FROM finish();
ROLLBACK;
