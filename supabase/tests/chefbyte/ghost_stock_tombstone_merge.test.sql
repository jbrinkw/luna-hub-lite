-- ════════════════════════════════════════════════════════════════════════════
-- T1 — Ghost-stock / tombstone-merge class (deep audit 2026-06-03).
-- ════════════════════════════════════════════════════════════════════════════
-- ROOT CAUSE (MERGEKEY-ROOT / C-2 / C-3 / H-1 / H-12 + live_scale):
--   The G1 soft-delete model (20260515010000) drains a fully-consumed lot to
--   a TOMBSTONE: qty_containers=0, deleted_at=now(). But the
--   `stock_lots_merge_key` unique index
--     (user_id, product_id, location_id, COALESCE(expires_on,'9999-12-31'))
--   is NOT partial on deleted_at, so the tombstone keeps occupying the merge
--   slot. Every merge writer then bumps qty ONTO the tombstone and leaves
--   deleted_at set → the stock is invisible in every UI read (all filter
--   `deleted_at IS NULL`) and unspendable by consume_product's FEFO loop
--   (which also filters `deleted_at IS NULL`). Pure silent data loss.
--
-- This test exercises EACH plpgsql merge writer through a tombstone:
--   1. private.import_shopping_to_inventory   (C-2  / GHOST-IMPORT)
--   2. private.execute_scan_action 'purchase' (H-1  / GHOST-SCAN)
--   3. private.resolve_add_to_shelf_lot step-4 revive (H-12, live_shelf)
--   4. apply_shelf_event live_scale tier-4 claim (MERGEKEY-ROOT live_scale)
-- and proves the *legit* live-lot merge still collapses to ONE row (the
-- partial index must not break that).
--
-- The pass criterion per writer is the audit's: after the writer runs the
-- slot has a LIVE VISIBLE row — qty_containers > 0 AND deleted_at IS NULL —
-- and SUM(qty_containers) WHERE deleted_at IS NULL > 0. For the live_scale
-- claim (which by design KEEPs qty), the criterion is that the claimed lot
-- is no longer a tombstone (deleted_at IS NULL) so the scale pairing binds a
-- live, spendable lot rather than a dead one.
--
-- RED-before-GREEN: against current code (non-partial index + writers that
-- never clear deleted_at) writers 1/2/4 leave deleted_at set and writer 3
-- likewise; the LIVE-visible / not-tombstone assertions fail.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(13);

------------------------------------------------------------
-- Setup — user + activation (activate_app seeds the Fridge location).
------------------------------------------------------------
SELECT tests.create_supabase_user('ghost_user');
SELECT tests.authenticate_as('ghost_user');
SELECT hub.activate_app('chefbyte');

SELECT tests.get_supabase_uid('ghost_user') AS _uid \gset

SELECT location_id AS _fridge
  FROM chefbyte.locations
 WHERE user_id = :'_uid'::uuid AND name = 'Fridge' \gset

-- Four distinct products, one per writer, so each writer's tombstone is
-- isolated. net_weight_g set for the live_shelf/live_scale resolver paths.
INSERT INTO chefbyte.products (
  user_id, name, servings_per_container,
  calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving,
  net_weight_g
) VALUES
  (:'_uid'::uuid, 'Ghost Import Prod',  1, 100, 5, 10, 2, NULL),
  (:'_uid'::uuid, 'Ghost Scan Prod',    1, 100, 5, 10, 2, NULL),
  (:'_uid'::uuid, 'Ghost Shelf Prod',   1, 100, 5, 10, 2, 500),
  (:'_uid'::uuid, 'Ghost Scale Prod',   1, 100, 5, 10, 2, 500),
  (:'_uid'::uuid, 'Live Merge Prod',    1, 100, 5, 10, 2, NULL);

SELECT product_id AS _p_import FROM chefbyte.products
  WHERE user_id = :'_uid'::uuid AND name = 'Ghost Import Prod' \gset
SELECT product_id AS _p_scan FROM chefbyte.products
  WHERE user_id = :'_uid'::uuid AND name = 'Ghost Scan Prod' \gset
SELECT product_id AS _p_shelf FROM chefbyte.products
  WHERE user_id = :'_uid'::uuid AND name = 'Ghost Shelf Prod' \gset
SELECT product_id AS _p_scale FROM chefbyte.products
  WHERE user_id = :'_uid'::uuid AND name = 'Ghost Scale Prod' \gset
SELECT product_id AS _p_merge FROM chefbyte.products
  WHERE user_id = :'_uid'::uuid AND name = 'Live Merge Prod' \gset

-- A live_scale device so apply_shelf_event has a device to attribute the
-- live_scale event to.
INSERT INTO chefbyte.live_shelf_devices (user_id, device_name, import_key_hash, is_active)
VALUES (:'_uid'::uuid, 'ghost-pi', 'ghost_hash', true);
SELECT device_id AS _dev FROM chefbyte.live_shelf_devices
  WHERE user_id = :'_uid'::uuid AND device_name = 'ghost-pi' \gset

------------------------------------------------------------
-- Helper: drain a product's single NULL-expiry lot to a tombstone via
-- the real consume_product (the canonical tombstone factory). Seed 1
-- container, consume 1 container → qty=0, deleted_at=now().
------------------------------------------------------------

-- ── Writer 1: import_shopping_to_inventory ───────────────────────────
INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
VALUES (:'_uid'::uuid, :'_p_import'::uuid, :'_fridge'::uuid, 1, NULL);

SELECT chefbyte.consume_product(:'_p_import'::uuid, 1, 'container', false, CURRENT_DATE, true);

-- Precondition: exactly one row and it is a tombstone (qty=0, deleted_at set).
SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid AND product_id = :'_p_import'::uuid
      AND deleted_at IS NOT NULL AND qty_containers = 0),
  1,
  'import: precondition — drained lot is a tombstone (qty=0, deleted_at set)'
);

-- A purchased, not-yet-imported shopping row for 3 containers.
INSERT INTO chefbyte.shopping_list (user_id, product_id, qty_containers, purchased)
VALUES (:'_uid'::uuid, :'_p_import'::uuid, 3, true);

SELECT chefbyte.import_shopping_to_inventory();

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid AND product_id = :'_p_import'::uuid
      AND qty_containers > 0 AND deleted_at IS NULL),
  '>=', 1,
  'import: a LIVE VISIBLE lot (qty>0, deleted_at IS NULL) exists after import'
);

SELECT cmp_ok(
  (SELECT COALESCE(SUM(qty_containers), 0)::numeric FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid AND product_id = :'_p_import'::uuid
      AND deleted_at IS NULL),
  '>', 0::numeric,
  'import: SUM(qty) over live rows > 0 — imported containers are spendable'
);

-- Revive-IN-PLACE proof: the import must NOT split stock across a second row.
-- The trigger clears deleted_at on the SAME tombstone the merge writer bumped,
-- so the product still has exactly ONE stock_lots row total (the revived lot),
-- not a live row + an orphan tombstone. This is the structural guarantee the
-- partial-index approach would have broken.
SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid AND product_id = :'_p_import'::uuid),
  1,
  'import: revive is IN PLACE — exactly ONE stock_lots row (no split live+tombstone)'
);

-- ── Writer 2: execute_scan_action 'purchase' ─────────────────────────
INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
VALUES (:'_uid'::uuid, :'_p_scan'::uuid, :'_fridge'::uuid, 1, NULL);

SELECT chefbyte.consume_product(:'_p_scan'::uuid, 1, 'container', false, CURRENT_DATE, true);

SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid AND product_id = :'_p_scan'::uuid
      AND deleted_at IS NOT NULL AND qty_containers = 0),
  1,
  'scan: precondition — drained lot is a tombstone'
);

SET LOCAL role postgres;
SELECT private.execute_scan_action(
  :'_uid'::uuid, :'_p_scan'::uuid, 'purchase', 3, 'container', NULL
);
RESET role;
SELECT tests.authenticate_as('ghost_user');

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid AND product_id = :'_p_scan'::uuid
      AND qty_containers > 0 AND deleted_at IS NULL),
  '>=', 1,
  'scan(purchase): a LIVE VISIBLE lot exists after purchase onto a tombstone'
);

SELECT cmp_ok(
  (SELECT COALESCE(SUM(qty_containers), 0)::numeric FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid AND product_id = :'_p_scan'::uuid
      AND deleted_at IS NULL),
  '>', 0::numeric,
  'scan(purchase): SUM(qty) over live rows > 0'
);

-- ── Writer 3: resolve_add_to_shelf_lot step-4 (live_shelf revive) ────
-- Tombstone (qty=0) skips steps 1/2/2.5/2.6/3 (all require qty>0) and falls
-- to step 4 (empty-lot revive). Step 4 must clear deleted_at, not just set
-- qty=1.0 onto a dead row.
INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
VALUES (:'_uid'::uuid, :'_p_shelf'::uuid, :'_fridge'::uuid, 1, NULL);

SELECT chefbyte.consume_product(:'_p_shelf'::uuid, 1, 'container', false, CURRENT_DATE, true);

SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid AND product_id = :'_p_shelf'::uuid
      AND deleted_at IS NOT NULL AND qty_containers = 0),
  1,
  'shelf: precondition — drained lot is a tombstone'
);

SET LOCAL role postgres;
SELECT private.resolve_add_to_shelf_lot(
  :'_uid'::uuid, :'_p_shelf'::uuid, 'live_shelf', :'_fridge'::uuid,
  450.0, NULL, now()
);
RESET role;
SELECT tests.authenticate_as('ghost_user');

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid AND product_id = :'_p_shelf'::uuid
      AND qty_containers > 0 AND deleted_at IS NULL),
  '>=', 1,
  'shelf(step-4): revived lot is LIVE VISIBLE (qty>0, deleted_at IS NULL)'
);

-- ── Writer 4: apply_shelf_event live_scale tier-4 claim ──────────────
-- live_scale claim KEEPs qty (so qty stays 0) but MUST clear deleted_at so
-- the auto-paired lot is live/spendable, not a dead tombstone.
INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
VALUES (:'_uid'::uuid, :'_p_scale'::uuid, :'_fridge'::uuid, 1, NULL);

SELECT chefbyte.consume_product(:'_p_scale'::uuid, 1, 'container', false, CURRENT_DATE, true);

SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid AND product_id = :'_p_scale'::uuid
      AND deleted_at IS NOT NULL AND qty_containers = 0),
  1,
  'scale: precondition — drained lot is a tombstone'
);

SET LOCAL role postgres;
SELECT private.apply_shelf_event(
  :'_uid'::uuid, :'_dev'::uuid, 'scale-09', 'live_scale', 'refilled',
  :'_p_scale'::uuid, 500.0, now()::timestamptz, 'ghost-scale-evt-1', NULL
);
RESET role;
SELECT tests.authenticate_as('ghost_user');

SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid AND product_id = :'_p_scale'::uuid
      AND deleted_at IS NOT NULL),
  0,
  'scale(tier-4 claim): claimed lot is NO LONGER a tombstone (deleted_at cleared)'
);

------------------------------------------------------------
-- LIVE-MERGE-STILL-WORKS proof: two live purchases on a fresh product
-- (same product/location/NULL expiry, no tombstone) MUST collapse into a
-- single row. The partial index must not break legitimate merging.
------------------------------------------------------------
SET LOCAL role postgres;
SELECT private.execute_scan_action(
  :'_uid'::uuid, :'_p_merge'::uuid, 'purchase', 2, 'container', NULL
);
SELECT private.execute_scan_action(
  :'_uid'::uuid, :'_p_merge'::uuid, 'purchase', 3, 'container', NULL
);
RESET role;
SELECT tests.authenticate_as('ghost_user');

SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid AND product_id = :'_p_merge'::uuid
      AND deleted_at IS NULL),
  1,
  'live-merge: two live purchases collapse into exactly ONE live row'
);

SELECT is(
  (SELECT qty_containers::numeric FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid AND product_id = :'_p_merge'::uuid
      AND deleted_at IS NULL),
  5::numeric,
  'live-merge: the single row carries the summed qty (2 + 3 = 5)'
);

SELECT * FROM finish();
ROLLBACK;
