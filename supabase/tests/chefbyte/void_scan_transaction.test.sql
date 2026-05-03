-- Pi USB scanner forwarder (Task 3): private.void_scan_transaction
--
-- Reverses the side-effects of an applied scan_transactions row by
-- deleting any FK targets recorded on the audit row (applied_lot_id
-- in stock_lots, applied_food_log_id in food_logs, applied_cart_item_id
-- in shopping_list) and flipping status='voided'. Idempotent: voiding
-- an already-voided row is a no-op. Missing transactions raise
-- 'transaction_not_found'.
--
-- The function is contract-driven (it doesn't care how the row was
-- created — only that applied_*_id FKs point to real rows), so this
-- suite seeds rows directly via INSERT instead of routing through
-- private.execute_scan_action.

BEGIN;
SELECT plan(13);

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
-- Test 1 + 2 + 3 — Void a purchase transaction.
-- A purchase transaction's applied_lot_id points at a stock_lots
-- row. Voiding deletes that lot and flips status='voided'.
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

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE lot_id = :'_lot_purchase'::uuid),
  '=', 0,
  'void deleted the applied stock_lot'
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
-- Teardown
------------------------------------------------------------

RESET ROLE;
SELECT tests.delete_supabase_user('void_user');

SELECT * FROM finish();
ROLLBACK;
