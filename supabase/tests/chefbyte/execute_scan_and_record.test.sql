-- H-8 (deep-audit 2026-06-03): shelf-ingest barcode-scan stock mutation
-- committed in a SEPARATE PostgREST transaction from the scan_transactions
-- audit insert. If the audit insert failed (e.g. an invalid `unit` hitting the
-- scan_transactions CHECK), the stock RPC had already committed and the 500
-- path wrote NO idempotency row → on Pi retry the idempotency SELECT found
-- nothing → execute_scan_action re-ran → double mint / double consume.
--
-- Fix: private.execute_scan_and_record folds the stock mutation AND the audit
-- insert into ONE transaction. This suite asserts that contract:
--   * a successful purchase mints exactly ONE stock_lot AND writes exactly ONE
--     applied scan_transactions row, with applied_lot_id linking them
--   * an INVALID unit ('kg') raises BEFORE any mutation — NO stock_lot and NO
--     scan_transactions row are left behind (the partial-apply is impossible)
--   * a consume_macros applies + records atomically (food_log + applied row)
--   * the recorded row carries pi_event_id (the dedup key) + source
--   * logical_date is the profile-tz logical date (not raw UTC) — closes the
--     TZ-02/03 audit-ledger stamp drift

BEGIN;
SELECT plan(13);

------------------------------------------------------------
-- Setup — auth + activation + a product with stock-ish config.
------------------------------------------------------------
SELECT tests.create_supabase_user('scan_rec_user');
SELECT tests.authenticate_as('scan_rec_user');
SELECT hub.activate_app('chefbyte');
SELECT tests.get_supabase_uid('scan_rec_user') AS _uid \gset

INSERT INTO chefbyte.products (
  user_id, name, barcode,
  servings_per_container, calories_per_serving,
  protein_per_serving, carbs_per_serving, fat_per_serving
) VALUES (
  :'_uid'::uuid, 'Scan Rec Pasta', 'BARCODE-SR-1',
  2, 300, 10, 50, 5
);
SELECT product_id AS _pid
  FROM chefbyte.products
 WHERE user_id = :'_uid'::uuid AND name = 'Scan Rec Pasta' \gset

SELECT tests.clear_authentication();
SET ROLE service_role;

------------------------------------------------------------
-- 1-5. Successful purchase: one stock_lot + one applied audit row, linked.
------------------------------------------------------------
SELECT lives_ok(
  format($$
    SELECT private.execute_scan_and_record(
      p_user_id            => %L::uuid,
      p_product_id         => %L::uuid,
      p_barcode            => 'BARCODE-SR-1',
      p_mode               => 'purchase',
      p_qty                => 1,
      p_unit               => 'container',
      p_nutrition_snapshot => NULL,
      p_source             => 'pi_usb',
      p_pi_event_id        => 'evt-sr-1'
    )
  $$, :'_uid', :'_pid'),
  'execute_scan_and_record(purchase) does not raise'
);

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid AND product_id = :'_pid'::uuid AND deleted_at IS NULL),
  '=', 1,
  'purchase minted exactly one live stock_lot'
);

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.scan_transactions
    WHERE user_id = :'_uid'::uuid AND pi_event_id = 'evt-sr-1' AND status = 'applied'),
  '=', 1,
  'purchase wrote exactly one applied scan_transactions row'
);

-- The audit row's applied_lot_id must point at the minted lot (atomic linkage).
SELECT is(
  (SELECT t.applied_lot_id FROM chefbyte.scan_transactions t
    WHERE t.user_id = :'_uid'::uuid AND t.pi_event_id = 'evt-sr-1'),
  (SELECT l.lot_id FROM chefbyte.stock_lots l
    WHERE l.user_id = :'_uid'::uuid AND l.product_id = :'_pid'::uuid AND l.deleted_at IS NULL),
  'audit row applied_lot_id links to the minted stock_lot'
);

-- logical_date is the profile-tz logical date — resolved via
-- get_logical_date(profile.timezone, day_start_hour), NOT a raw UTC stamp.
-- hub.profiles defaults timezone='America/New_York', so this is materially
-- different from a raw UTC `toISOString().slice(0,10)` near the day boundary
-- (the TZ-02/03 audit-vs-macro ledger drift the fix also closes). Assert
-- against the user's OWN profile resolution, not a hardcoded zone.
SELECT is(
  (SELECT logical_date FROM chefbyte.scan_transactions
    WHERE user_id = :'_uid'::uuid AND pi_event_id = 'evt-sr-1'),
  (SELECT private.get_logical_date(now(), p.timezone, p.day_start_hour)
     FROM hub.profiles p WHERE p.user_id = :'_uid'::uuid),
  'audit row logical_date is the profile-tz logical date (not raw UTC stamp)'
);

------------------------------------------------------------
-- 6-9. INVALID unit raises BEFORE any mutation (the H-8 core):
-- no NEW stock_lot, no NEW scan_transactions row.
------------------------------------------------------------
-- Snapshot counts before the bad call.
SELECT (SELECT count(*)::int FROM chefbyte.stock_lots
         WHERE user_id = :'_uid'::uuid AND product_id = :'_pid'::uuid) AS _lots_before \gset
SELECT (SELECT count(*)::int FROM chefbyte.scan_transactions
         WHERE user_id = :'_uid'::uuid) AS _tx_before \gset

SELECT throws_ok(
  format($$
    SELECT private.execute_scan_and_record(
      p_user_id            => %L::uuid,
      p_product_id         => %L::uuid,
      p_barcode            => 'BARCODE-SR-1',
      p_mode               => 'purchase',
      p_qty                => 1,
      p_unit               => 'kg',
      p_nutrition_snapshot => NULL,
      p_source             => 'pi_usb',
      p_pi_event_id        => 'evt-sr-bad'
    )
  $$, :'_uid', :'_pid'),
  '23514',
  NULL,
  'invalid unit ''kg'' raises a CHECK-violation (23514) before any mutation'
);

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid AND product_id = :'_pid'::uuid),
  '=', :'_lots_before'::int,
  'invalid unit minted NO new stock_lot (no partial apply)'
);

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.scan_transactions
    WHERE user_id = :'_uid'::uuid),
  '=', :'_tx_before'::int,
  'invalid unit wrote NO scan_transactions row (no orphan audit / no missing idempotency row)'
);

-- And specifically no row for the bad event id.
SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.scan_transactions
    WHERE user_id = :'_uid'::uuid AND pi_event_id = 'evt-sr-bad'),
  '=', 0,
  'invalid unit left no audit row under its pi_event_id'
);

------------------------------------------------------------
-- 10-13. consume_macros applies + records atomically.
-- Purchase above left 1 container; consume 1 serving (=0.5 ctn).
------------------------------------------------------------
SELECT lives_ok(
  format($$
    SELECT private.execute_scan_and_record(
      p_user_id            => %L::uuid,
      p_product_id         => %L::uuid,
      p_barcode            => 'BARCODE-SR-1',
      p_mode               => 'consume_macros',
      p_qty                => 1,
      p_unit               => 'serving',
      p_nutrition_snapshot => NULL,
      p_source             => 'pi_usb',
      p_pi_event_id        => 'evt-sr-2'
    )
  $$, :'_uid', :'_pid'),
  'execute_scan_and_record(consume_macros) does not raise'
);

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.food_logs
    WHERE user_id = :'_uid'::uuid AND product_id = :'_pid'::uuid),
  '=', 1,
  'consume_macros wrote a food_log'
);

-- The applied audit row links to that food_log + carries the dedup key.
SELECT is(
  (SELECT t.applied_food_log_id FROM chefbyte.scan_transactions t
    WHERE t.user_id = :'_uid'::uuid AND t.pi_event_id = 'evt-sr-2'),
  (SELECT f.log_id FROM chefbyte.food_logs f
    WHERE f.user_id = :'_uid'::uuid AND f.product_id = :'_pid'::uuid
    ORDER BY f.created_at DESC LIMIT 1),
  'consume audit row applied_food_log_id links to the food_log'
);

SELECT is(
  (SELECT source FROM chefbyte.scan_transactions
    WHERE user_id = :'_uid'::uuid AND pi_event_id = 'evt-sr-2'),
  'pi_usb',
  'consume audit row records source=pi_usb'
);

------------------------------------------------------------
-- Teardown
------------------------------------------------------------
RESET ROLE;
SELECT tests.delete_supabase_user('scan_rec_user');

SELECT * FROM finish();
ROLLBACK;
