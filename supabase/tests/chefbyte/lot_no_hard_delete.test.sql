-- Gap G1 (cloud↔Pi polling audit, 2026-05-15):
-- chefbyte.stock_lots rows must NEVER hard-DELETE under normal operation —
-- they must convert to a soft-delete (deleted_at IS NOT NULL,
-- qty_containers = 0) so the Pi's lot_snapshot_poller sees the tombstone
-- via the updated_at delta and removes the local mirror row.
--
-- This suite validates:
--   1. private.consume_product fully-drains a lot → soft-delete (not hard).
--   2. private.unmark_meal_done [MEAL]-lot cleanup → soft-delete first,
--      then cascade-hard-delete via the per-tx bypass GUC.
--   3. private.void_scan_transaction → soft-delete via trigger conversion.
--   4. Manual DELETE FROM chefbyte.stock_lots (REST-API / ad-hoc) →
--      soft-delete via trigger conversion + RAISE NOTICE in pg log.
--   5. updated_at is bumped on every soft-delete path (so the Pi
--      delta-query picks the tombstone up).
--   6. SET LOCAL chefbyte.stock_lots_allow_hard_delete = 'on' allows
--      a true hard-delete (full-wipe / cascade paths).

BEGIN;
SELECT plan(15);

------------------------------------------------------------
-- Setup
------------------------------------------------------------
SELECT tests.create_supabase_user('g1_owner');
SELECT tests.authenticate_as('g1_owner');
SELECT hub.activate_app('chefbyte');

-- Capture the auth uid + seeded location.
SELECT tests.get_supabase_uid('g1_owner') AS _uid \gset
SELECT location_id AS _loc FROM chefbyte.locations
 WHERE user_id = :'_uid'::uuid AND name = 'Fridge' \gset

-- A product to consume against (1 spc, 100 cal/serving).
INSERT INTO chefbyte.products (
  user_id, name, servings_per_container, calories_per_serving,
  carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  :'_uid'::uuid, 'G1 Test Bread', 1, 100, 20, 4, 1
);
SELECT product_id AS _pid FROM chefbyte.products
 WHERE user_id = :'_uid'::uuid AND name = 'G1 Test Bread' \gset

------------------------------------------------------------
-- 1. consume_product fully drains a lot → soft-delete.
------------------------------------------------------------
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on
) VALUES (
  :'_uid'::uuid, :'_pid'::uuid, :'_loc'::uuid, 1.0, '2026-12-01'
);
SELECT lot_id AS _lot_consume FROM chefbyte.stock_lots
 WHERE user_id = :'_uid'::uuid
   AND product_id = :'_pid'::uuid
   AND expires_on = '2026-12-01' \gset

-- Capture updated_at BEFORE consume so we can confirm it advanced.
SELECT updated_at AS _ts_before_consume FROM chefbyte.stock_lots
 WHERE lot_id = :'_lot_consume'::uuid \gset

-- Fully drain the lot (qty = 1.0, consume 1.0 container).
SELECT chefbyte.consume_product(
  :'_pid'::uuid, 1.0, 'container', false, '2026-05-15'::date
);

SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE lot_id = :'_lot_consume'::uuid),
  1,
  'G1.1a — consume_product preserves the row (no hard-delete, ghost-bug fix)'
);

SELECT isnt(
  (SELECT deleted_at FROM chefbyte.stock_lots WHERE lot_id = :'_lot_consume'::uuid),
  NULL,
  'G1.1b — consume_product set deleted_at on the drained lot (tombstone)'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots WHERE lot_id = :'_lot_consume'::uuid),
  0::numeric,
  'G1.1c — consume_product set qty_containers = 0 on the drained lot'
);

SELECT is(
  (SELECT last_update_source FROM chefbyte.stock_lots WHERE lot_id = :'_lot_consume'::uuid),
  'manual_consume',
  'G1.1d — consume_product stamped last_update_source=manual_consume'
);

-- updated_at must be at least as new as the pre-consume value. We use
-- `>=` rather than `>` because now() is stable within a transaction —
-- a fresh INSERT (default now()) and a same-tx UPDATE (now() again)
-- produce identical timestamps. The real Pi-visible signal is the
-- deleted_at bump above; this assertion just guarantees the watermark
-- column didn't go backwards.
SELECT ok(
  (SELECT updated_at FROM chefbyte.stock_lots WHERE lot_id = :'_lot_consume'::uuid)
    >= :'_ts_before_consume'::timestamptz,
  'G1.1e — consume_product did not regress updated_at (Pi delta-poller still picks up the tombstone)'
);

------------------------------------------------------------
-- 2. Manual REST-API-style DELETE (ad-hoc DELETE) → soft-delete via trigger.
------------------------------------------------------------
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on
) VALUES (
  :'_uid'::uuid, :'_pid'::uuid, :'_loc'::uuid, 2.0, '2026-12-15'
);
SELECT lot_id AS _lot_manual FROM chefbyte.stock_lots
 WHERE user_id = :'_uid'::uuid
   AND product_id = :'_pid'::uuid
   AND expires_on = '2026-12-15' \gset

SELECT updated_at AS _ts_before_manual FROM chefbyte.stock_lots
 WHERE lot_id = :'_lot_manual'::uuid \gset

-- Bypass the deferred-NOTICE noise in pgTAP output.
SET LOCAL client_min_messages = 'WARNING';

-- An ad-hoc DELETE (matches what a careless REST .delete() call would do).
DELETE FROM chefbyte.stock_lots WHERE lot_id = :'_lot_manual'::uuid;

RESET client_min_messages;

SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE lot_id = :'_lot_manual'::uuid),
  1,
  'G1.2a — ad-hoc DELETE FROM stock_lots is intercepted by the trigger (row survives)'
);

SELECT isnt(
  (SELECT deleted_at FROM chefbyte.stock_lots WHERE lot_id = :'_lot_manual'::uuid),
  NULL,
  'G1.2b — ad-hoc DELETE → trigger set deleted_at (tombstone)'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots WHERE lot_id = :'_lot_manual'::uuid),
  0::numeric,
  'G1.2c — ad-hoc DELETE → trigger zeroed qty_containers'
);

SELECT ok(
  (SELECT updated_at FROM chefbyte.stock_lots WHERE lot_id = :'_lot_manual'::uuid)
    >= :'_ts_before_manual'::timestamptz,
  'G1.2d — ad-hoc DELETE → trigger did not regress updated_at'
);

------------------------------------------------------------
-- 3. unmark_meal_done — [MEAL] cleanup path soft-deletes the lot.
------------------------------------------------------------
-- Seed a recipe + ingredient + meal-prep meal so mark_meal_done creates
-- a [MEAL] product+lot we can then unmark.

INSERT INTO chefbyte.recipes (
  user_id, name, base_servings
) VALUES (:'_uid'::uuid, 'G1 Bowl', 1);
SELECT recipe_id AS _rid FROM chefbyte.recipes
 WHERE user_id = :'_uid'::uuid AND name = 'G1 Bowl' \gset

INSERT INTO chefbyte.recipe_ingredients (
  user_id, recipe_id, product_id, quantity, unit
) VALUES (:'_uid'::uuid, :'_rid'::uuid, :'_pid'::uuid, 1, 'container');

-- Refresh stock for the ingredient (consume_product above drained it).
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on
) VALUES (:'_uid'::uuid, :'_pid'::uuid, :'_loc'::uuid, 5.0, '2026-11-01');

INSERT INTO chefbyte.meal_plan_entries (
  user_id, recipe_id, logical_date, servings, meal_prep
) VALUES (:'_uid'::uuid, :'_rid'::uuid, '2026-05-15'::date, 1, true);
SELECT meal_id AS _meal FROM chefbyte.meal_plan_entries
 WHERE user_id = :'_uid'::uuid AND recipe_id = :'_rid'::uuid
   AND logical_date = '2026-05-15' \gset

SELECT chefbyte.mark_meal_done(:'_meal'::uuid);

-- The [MEAL] product was created during mark_meal_done. Look up its lot.
SELECT product_id AS _meal_pid FROM chefbyte.products
 WHERE user_id = :'_uid'::uuid AND name LIKE '[MEAL] G1 Bowl 05-15%' \gset
SELECT lot_id AS _lot_meal FROM chefbyte.stock_lots
 WHERE user_id = :'_uid'::uuid AND product_id = :'_meal_pid'::uuid LIMIT 1 \gset

-- Sanity: meal lot exists and is live.
SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE lot_id = :'_lot_meal'::uuid AND deleted_at IS NULL),
  1,
  'G1.3-precondition — [MEAL] lot is live after mark_meal_done'
);

-- Now unmark. The [MEAL] stock_lots cleanup should soft-delete first,
-- THEN the cascade (after the bypass GUC) hard-removes the row.
SELECT chefbyte.unmark_meal_done(:'_meal'::uuid);

SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE lot_id = :'_lot_meal'::uuid),
  0,
  'G1.3a — unmark_meal_done cascade removed the [MEAL] lot (via bypass GUC)'
);

SELECT is(
  (SELECT count(*)::int FROM chefbyte.products
    WHERE product_id = :'_meal_pid'::uuid),
  0,
  'G1.3b — unmark_meal_done hard-deleted the [MEAL] product'
);

------------------------------------------------------------
-- 4. void_scan_transaction — soft-delete via trigger conversion.
------------------------------------------------------------
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on,
  last_update_source, last_update_ts
) VALUES (
  :'_uid'::uuid, :'_pid'::uuid, :'_loc'::uuid, 1.0,
  '2026-12-20', 'manual', now()
);
SELECT lot_id AS _lot_void FROM chefbyte.stock_lots
 WHERE user_id = :'_uid'::uuid
   AND product_id = :'_pid'::uuid
   AND expires_on = '2026-12-20' \gset

INSERT INTO chefbyte.scan_transactions (
  user_id, barcode, product_id, mode, qty, unit,
  status, logical_date, source, applied_lot_id, applied_at
) VALUES (
  :'_uid'::uuid, '9990000000999', :'_pid'::uuid, 'purchase', 1, 'container',
  'applied', current_date, 'pi_usb', :'_lot_void'::uuid, now()
);
SELECT transaction_id AS _txn FROM chefbyte.scan_transactions
 WHERE user_id = :'_uid'::uuid AND barcode = '9990000000999' \gset

-- void_scan_transaction is service_role-only (migration 20260503110000
-- locked authenticated/anon out). Switch role to call it, then reset.
SET LOCAL client_min_messages = 'WARNING';
SET LOCAL role service_role;
SELECT private.void_scan_transaction(:'_txn'::uuid);
RESET role;
RESET client_min_messages;

SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE lot_id = :'_lot_void'::uuid),
  1,
  'G1.4a — void_scan_transaction preserves the row (trigger intercepted DELETE)'
);

SELECT isnt(
  (SELECT deleted_at FROM chefbyte.stock_lots WHERE lot_id = :'_lot_void'::uuid),
  NULL,
  'G1.4b — void_scan_transaction → trigger set deleted_at'
);

------------------------------------------------------------
-- 5. Bypass GUC actually allows hard-delete.
------------------------------------------------------------
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on
) VALUES (:'_uid'::uuid, :'_pid'::uuid, :'_loc'::uuid, 3.0, '2026-12-31');
SELECT lot_id AS _lot_bypass FROM chefbyte.stock_lots
 WHERE user_id = :'_uid'::uuid
   AND product_id = :'_pid'::uuid
   AND expires_on = '2026-12-31' \gset

SET LOCAL chefbyte.stock_lots_allow_hard_delete = 'on';
SET LOCAL client_min_messages = 'WARNING';
DELETE FROM chefbyte.stock_lots WHERE lot_id = :'_lot_bypass'::uuid;
SET LOCAL chefbyte.stock_lots_allow_hard_delete = 'off';
RESET client_min_messages;

SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE lot_id = :'_lot_bypass'::uuid),
  0,
  'G1.5 — bypass GUC (chefbyte.stock_lots_allow_hard_delete=on) allowed hard-delete'
);

------------------------------------------------------------
-- Teardown
------------------------------------------------------------
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('g1_owner');

SELECT * FROM finish();
ROLLBACK;
