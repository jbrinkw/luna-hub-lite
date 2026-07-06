-- Pi USB scanner forwarder (Task 3): private.void_scan_transaction
--
-- Reverses the side-effects of an applied scan_transactions row.
--   * PURCHASE (applied_lot_id non-NULL): SUBTRACTS the scan's qty
--     (COALESCE(qty,1) containers) from the merged lot — floored at 0 —
--     instead of zeroing the whole lot. A full reversal to 0 tombstones
--     the lot (deleted_at set); a partial reversal leaves it live. This is
--     the H-11 / A5-01 data-loss fix (migration 20260515110000): two
--     same-day purchases (or a purchase merged onto pre-existing stock)
--     share ONE lot_id via execute_scan_action's ON CONFLICT merge, so
--     deleting the whole lot on void destroyed the sibling/pre-existing
--     quantity.
--   * consume_macros (applied_food_log_id non-NULL): deletes the food_log.
--   * shopping (applied_cart_item_id non-NULL): deletes the cart item.
-- Then flips status='voided'. Idempotent: voiding an already-voided row is
-- a no-op. Missing transactions raise 'transaction_not_found'.
--
-- The function is contract-driven (it doesn't care how the row was
-- created — only that applied_*_id FKs point to real rows), so this
-- suite seeds rows directly via INSERT instead of routing through
-- private.execute_scan_action.

BEGIN;
SELECT plan(21);

------------------------------------------------------------
-- Setup — project-canonical test helpers (auth + activation)
------------------------------------------------------------

SELECT tests.create_supabase_user('void_user');
SELECT tests.authenticate_as('void_user');
SELECT hub.activate_app('chefbyte');

SELECT tests.get_supabase_uid('void_user') AS _uid \gset

-- Seed product (re-used across all sub-tests).
INSERT INTO chefbyte.products (
  user_id, name, barcode,
  servings_per_container, calories_per_serving,
  protein_per_serving, carbs_per_serving, fat_per_serving
) VALUES (
  :'_uid'::uuid,
  'Void Test Product',
  '9990000000001',
  2, 200, 10, 30, 5
);

SELECT product_id AS _pid
  FROM chefbyte.products
 WHERE user_id = :'_uid'::uuid
   AND name = 'Void Test Product' \gset

-- Capture default location for stock_lots seeds.
SELECT location_id AS _loc
  FROM chefbyte.locations
 WHERE user_id = :'_uid'::uuid
 ORDER BY created_at ASC LIMIT 1 \gset

SELECT tests.clear_authentication();
SET ROLE service_role;

------------------------------------------------------------
-- Test 1 + 2 + 3 + 4 — Void a FULLY-reversing purchase.
-- A purchase whose scan qty (1) equals the lot's whole qty (1):
-- voiding SUBTRACTS 1 -> 0, which tombstones the lot (qty=0,
-- deleted_at set) and flips status='voided'. This is the boundary
-- case where the subtract bottoms out at the soft-delete tombstone.
------------------------------------------------------------

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on,
  last_update_source, last_update_ts
) VALUES (
  :'_uid'::uuid, :'_pid'::uuid, :'_loc'::uuid, 1.000,
  (current_date + 7)::date, 'manual', now()
)
RETURNING lot_id AS _lot_purchase \gset

INSERT INTO chefbyte.scan_transactions (
  user_id, barcode, product_id, mode, qty, unit,
  status, logical_date, source, applied_lot_id, applied_at
) VALUES (
  :'_uid'::uuid, '9990000000001', :'_pid'::uuid, 'purchase', 1, 'container',
  'applied', current_date, 'pi_usb', :'_lot_purchase'::uuid, now()
)
RETURNING transaction_id AS _txn_purchase \gset

SELECT lives_ok(
  format($$SELECT private.void_scan_transaction(%L::uuid)$$, :'_txn_purchase'),
  'void_scan_transaction(purchase) does not raise'
);

-- Full reversal bottoms the subtract out at 0. Per the soft-delete model
-- (G1, 20260515010000) + the explicit deleted_at=now() in the void's
-- subtract branch, the lot becomes a TOMBSTONE: the row still EXISTS with
-- deleted_at NOT NULL + qty_containers = 0 (so the Pi's lot_snapshot poller
-- picks it up). It is NOT row-deleted.
SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE lot_id = :'_lot_purchase'::uuid
      AND deleted_at IS NULL),
  '=', 0,
  'fully-voided purchase: applied lot is no longer live (deleted_at set)'
);

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE lot_id = :'_lot_purchase'::uuid
      AND deleted_at IS NOT NULL
      AND qty_containers = 0),
  '=', 1,
  'fully-voided purchase left a tombstone row (qty=0, deleted_at set) for Pi delta sync'
);

-- Tombstone, not a row delete: the lot_id row must still be present.
SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE lot_id = :'_lot_purchase'::uuid),
  '=', 1,
  'fully-voided purchase did not row-delete the lot (tombstone row survives)'
);

SELECT is(
  (SELECT status FROM chefbyte.scan_transactions
    WHERE transaction_id = :'_txn_purchase'::uuid),
  'voided',
  'void flipped scan_transaction status to voided'
);

------------------------------------------------------------
-- Test 4 + 5 + 6 — Void a consume_macros transaction.
-- consume_macros leaves applied_lot_id NULL (waterfall touches
-- multiple lots) and applied_food_log_id non-NULL (the row in
-- chefbyte.food_logs the consume wrote). Voiding deletes that
-- food_log row and flips status='voided'.
------------------------------------------------------------

INSERT INTO chefbyte.food_logs (
  user_id, product_id, logical_date, qty_consumed, unit,
  calories, carbs, protein, fat
) VALUES (
  :'_uid'::uuid, :'_pid'::uuid, current_date, 1, 'serving',
  200, 30, 10, 5
)
RETURNING log_id AS _log_consume \gset

INSERT INTO chefbyte.scan_transactions (
  user_id, barcode, product_id, mode, qty, unit,
  status, logical_date, source,
  applied_lot_id, applied_food_log_id, applied_at
) VALUES (
  :'_uid'::uuid, '9990000000001', :'_pid'::uuid, 'consume_macros', 1, 'serving',
  'applied', current_date, 'pi_usb',
  NULL, :'_log_consume'::uuid, now()
)
RETURNING transaction_id AS _txn_consume \gset

SELECT lives_ok(
  format($$SELECT private.void_scan_transaction(%L::uuid)$$, :'_txn_consume'),
  'void_scan_transaction(consume_macros) does not raise'
);

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.food_logs
    WHERE log_id = :'_log_consume'::uuid),
  '=', 0,
  'void deleted the applied food_log'
);

SELECT is(
  (SELECT status FROM chefbyte.scan_transactions
    WHERE transaction_id = :'_txn_consume'::uuid),
  'voided',
  'void(consume_macros) flipped status to voided'
);

------------------------------------------------------------
-- Test 7 + 8 + 9 — Void a shopping transaction.
-- A shopping transaction's applied_cart_item_id points at the
-- shopping_list row that was inserted/upserted. Voiding deletes
-- the cart row and flips status='voided'.
------------------------------------------------------------

INSERT INTO chefbyte.shopping_list (
  user_id, product_id, qty_containers, purchased
) VALUES (
  :'_uid'::uuid, :'_pid'::uuid, 2, false
)
RETURNING cart_item_id AS _cart_shopping \gset

INSERT INTO chefbyte.scan_transactions (
  user_id, barcode, product_id, mode, qty, unit,
  status, logical_date, source, applied_cart_item_id, applied_at
) VALUES (
  :'_uid'::uuid, '9990000000001', :'_pid'::uuid, 'shopping', 2, 'container',
  'applied', current_date, 'pi_usb', :'_cart_shopping'::uuid, now()
)
RETURNING transaction_id AS _txn_shopping \gset

SELECT lives_ok(
  format($$SELECT private.void_scan_transaction(%L::uuid)$$, :'_txn_shopping'),
  'void_scan_transaction(shopping) does not raise'
);

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.shopping_list
    WHERE cart_item_id = :'_cart_shopping'::uuid),
  '=', 0,
  'void deleted the applied shopping_list cart item'
);

SELECT is(
  (SELECT status FROM chefbyte.scan_transactions
    WHERE transaction_id = :'_txn_shopping'::uuid),
  'voided',
  'void(shopping) flipped status to voided'
);

------------------------------------------------------------
-- Test 10 + 11 — Idempotent: voiding an already-voided row is
-- a no-op (does not raise, status stays 'voided').
------------------------------------------------------------

SELECT lives_ok(
  format($$SELECT private.void_scan_transaction(%L::uuid)$$, :'_txn_purchase'),
  'void_scan_transaction on already-voided row does not raise (idempotent)'
);

SELECT is(
  (SELECT status FROM chefbyte.scan_transactions
    WHERE transaction_id = :'_txn_purchase'::uuid),
  'voided',
  'idempotent void leaves status=voided'
);

------------------------------------------------------------
-- Test 12 + 13 — transaction_not_found: voiding a non-existent
-- UUID raises 'transaction_not_found' (and does not silently
-- pass like an UPDATE WHERE no-match would).
------------------------------------------------------------

SELECT throws_ok(
  $$SELECT private.void_scan_transaction(
      '00000000-0000-0000-0000-000000000000'::uuid)$$,
  'transaction_not_found',
  'void on non-existent transaction_id raises transaction_not_found'
);

-- Sanity follow-up: the no-match attempt did not flip any rows
-- (a guard against a buggy implementation that UPDATEs unconditionally).
SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.scan_transactions
    WHERE user_id = :'_uid'::uuid
      AND status = 'voided'),
  '=', 3,
  'transaction_not_found path did not mutate other rows'
);

------------------------------------------------------------
-- Test 16 + 17 + 18 — H-11 / A5-01 REGRESSION: voiding a MERGED
-- purchase must subtract only the scan qty, not zero the lot.
--
-- Seed a lot with PRE-EXISTING qty 5 (e.g. prior stock), then apply
-- a purchase scan that MERGED +2 onto it (lot now qty 7), recording
-- applied_lot_id = that same lot and scan qty = 2 (mirrors the
-- execute_scan_action ON CONFLICT DO UPDATE
-- qty = qty + EXCLUDED.qty). Voiding that scan must leave the lot at
-- qty_containers = 5 (the pre-existing stock), still LIVE — NOT
-- deleted, NOT zeroed.
--
-- MUTATION PROOF: revert the void subtract branch back to the
-- whole-lot DELETE and this case goes RED — the G1 guard would
-- soft-delete the entire lot to (qty=0, deleted_at set), so the
-- qty=5 / deleted_at IS NULL assertion would fail.
------------------------------------------------------------

-- Pre-existing stock: qty 5 on the lot before any scan.
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on,
  last_update_source, last_update_ts
) VALUES (
  :'_uid'::uuid, :'_pid'::uuid, :'_loc'::uuid, 5.000,
  (current_date + 14)::date, 'manual', now()
)
RETURNING lot_id AS _lot_merged \gset

-- Simulate the purchase MERGE: +2 containers onto the existing lot
-- (qty 5 -> 7). This is exactly what the execute_scan_action
-- ON CONFLICT DO UPDATE qty = qty + EXCLUDED.qty produces, and it
-- returns this same lot_id as applied_lot_id.
UPDATE chefbyte.stock_lots
   SET qty_containers = qty_containers + 2.000,
       last_update_source = 'manual',
       last_update_ts = now()
 WHERE lot_id = :'_lot_merged'::uuid;

-- Audit row for the +2 purchase scan, applied_lot_id = the shared lot.
INSERT INTO chefbyte.scan_transactions (
  user_id, barcode, product_id, mode, qty, unit,
  status, logical_date, source, applied_lot_id, applied_at
) VALUES (
  :'_uid'::uuid, '9990000000001', :'_pid'::uuid, 'purchase', 2, 'container',
  'applied', current_date, 'pi_usb', :'_lot_merged'::uuid, now()
)
RETURNING transaction_id AS _txn_merged \gset

SELECT lives_ok(
  format($$SELECT private.void_scan_transaction(%L::uuid)$$, :'_txn_merged'),
  'void_scan_transaction(merged purchase) does not raise'
);

-- THE REGRESSION ASSERTION: only the scan +2 is reversed. The lot
-- survives LIVE at the pre-existing qty 5 (7 - 2). NOT zeroed, NOT a
-- tombstone. The old whole-lot DELETE would have dropped this to a
-- (qty=0, deleted_at set) tombstone — destroying the pre-existing 5.
SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE lot_id = :'_lot_merged'::uuid
      AND qty_containers = 5.000
      AND deleted_at IS NULL),
  '=', 1,
  'void(merged purchase) subtracted only the scan qty: lot survives LIVE at qty 5 (pre-existing stock intact)'
);

SELECT is(
  (SELECT status FROM chefbyte.scan_transactions
    WHERE transaction_id = :'_txn_merged'::uuid),
  'voided',
  'void(merged purchase) flipped status to voided'
);

------------------------------------------------------------
-- Test 19 + 20 + 21 — two same-day purchases sharing ONE lot:
-- void exactly one, the sibling stock survives.
--
-- execute_scan_action merges repeat same-day purchases of the same
-- product into a single lot_id (0 -> 1 -> 2 via two qty=1 scans, each
-- returning the same applied_lot_id). Voiding ONE scan must leave the
-- lot at qty 1 (the sibling purchase container), still live, and
-- must NOT void the sibling audit row.
------------------------------------------------------------

-- Fresh lot minted by the first purchase (+1 -> qty 1).
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on,
  last_update_source, last_update_ts
) VALUES (
  :'_uid'::uuid, :'_pid'::uuid, :'_loc'::uuid, 1.000,
  (current_date + 21)::date, 'manual', now()
)
RETURNING lot_id AS _lot_two \gset

INSERT INTO chefbyte.scan_transactions (
  user_id, barcode, product_id, mode, qty, unit,
  status, logical_date, source, applied_lot_id, applied_at
) VALUES (
  :'_uid'::uuid, '9990000000001', :'_pid'::uuid, 'purchase', 1, 'container',
  'applied', current_date, 'pi_usb', :'_lot_two'::uuid, now()
)
RETURNING transaction_id AS _txn_two_a \gset

-- Second purchase MERGES +1 onto the same lot (qty 1 -> 2), same
-- applied_lot_id.
UPDATE chefbyte.stock_lots
   SET qty_containers = qty_containers + 1.000,
       last_update_source = 'manual',
       last_update_ts = now()
 WHERE lot_id = :'_lot_two'::uuid;

INSERT INTO chefbyte.scan_transactions (
  user_id, barcode, product_id, mode, qty, unit,
  status, logical_date, source, applied_lot_id, applied_at
) VALUES (
  :'_uid'::uuid, '9990000000001', :'_pid'::uuid, 'purchase', 1, 'container',
  'applied', current_date, 'pi_usb', :'_lot_two'::uuid, now()
)
RETURNING transaction_id AS _txn_two_b \gset

-- Void only the SECOND purchase. Lot 2 -> 1 (the first purchase
-- container survives), still live.
SELECT lives_ok(
  format($$SELECT private.void_scan_transaction(%L::uuid)$$, :'_txn_two_b'),
  'void_scan_transaction(one of two merged purchases) does not raise'
);

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE lot_id = :'_lot_two'::uuid
      AND qty_containers = 1.000
      AND deleted_at IS NULL),
  '=', 1,
  'void(one merged purchase) leaves the lot LIVE at qty 1 (sibling purchase stock intact)'
);

-- The sibling (first) purchase audit row must be untouched.
SELECT is(
  (SELECT status FROM chefbyte.scan_transactions
    WHERE transaction_id = :'_txn_two_a'::uuid),
  'applied',
  'void(one merged purchase) did not void the sibling purchase transaction'
);

------------------------------------------------------------
-- Teardown
------------------------------------------------------------

RESET ROLE;
SELECT tests.delete_supabase_user('void_user');

SELECT * FROM finish();
ROLLBACK;
