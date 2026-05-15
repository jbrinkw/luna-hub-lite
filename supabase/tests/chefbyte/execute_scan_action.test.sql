-- Pi USB scanner forwarder (Task 2): private.execute_scan_action covers the
-- four scanner modes (purchase / consume_macros / consume_no_macros / shopping)
-- as a single SECURITY DEFINER entry point. The Pi USB forwarder edge function
-- (and a future chefbyte.* public wrapper) call this RPC.
--
-- Coverage in this batch:
--   * purchase mode mints exactly one stock_lot.
--   * consume_macros writes a food_log AND decrements stock by the
--     servings → containers conversion via servings_per_container.
--   * consume_no_macros decrements stock WITHOUT writing a food_log;
--     the FEFO waterfall in private.consume_product DELETES depleted
--     lots (not floor-at-0 in place).
--   * shopping mode upserts a shopping_list row and sums qty on
--     repeat calls (idempotent UPSERT semantics).
--   * consume_macros with empty stock STILL writes a food_log (the
--     project-wide "macros always logged" invariant).
--   * Multi-lot consume waterfalls FEFO across lots (NOT a single-lot
--     under-decrement) — verifies the I-1 fix.
--   * Missing product raises 'product_not_found_or_unauthorized' on
--     the consume + purchase paths.
--   * purchase with no locations configured raises 'no_location_configured'.

BEGIN;
SELECT plan(18);

------------------------------------------------------------
-- Setup — project-canonical test helpers (auth + activation)
------------------------------------------------------------

SELECT tests.create_supabase_user('scan_user');
SELECT tests.authenticate_as('scan_user');
SELECT hub.activate_app('chefbyte');

-- Capture user UUID + product_id while authenticated, then switch to
-- service_role for the private.* RPC calls (matches the canonical
-- private-function test pattern, e.g. apply_shelf_event_strict.test.sql).
SELECT tests.get_supabase_uid('scan_user') AS _uid \gset

-- Test product: 2 servings/container, 300cal/10p/50c/5f per serving.
INSERT INTO chefbyte.products (
  user_id, name, barcode,
  servings_per_container, calories_per_serving,
  protein_per_serving, carbs_per_serving, fat_per_serving
) VALUES (
  :'_uid'::uuid,
  'Test Pasta',
  '0123456789012',
  2, 300, 10, 50, 5
);

SELECT product_id AS _pid
  FROM chefbyte.products
 WHERE user_id = :'_uid'::uuid
   AND name = 'Test Pasta' \gset

-- Switch to service_role — private.* functions are not exposed to
-- authenticated callers (no USAGE on schema private).
SELECT tests.clear_authentication();
SET ROLE service_role;

------------------------------------------------------------
-- Test 1 + 2 — purchase mode mints a stock_lot
------------------------------------------------------------

SELECT lives_ok(
  format($$
    SELECT private.execute_scan_action(
      p_user_id            => %L::uuid,
      p_product_id         => %L::uuid,
      p_mode               => 'purchase',
      p_qty                => 1,
      p_unit               => 'container',
      p_nutrition_snapshot => NULL
    )
  $$, :'_uid', :'_pid'),
  'execute_scan_action(purchase) does not raise'
);

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid
      AND product_id = :'_pid'::uuid),
  '=', 1,
  'purchase created exactly one stock_lot'
);

------------------------------------------------------------
-- Test 3 + 4 — consume_macros writes a food_log
-- (purchase above already left 1 container in stock, so the
--  consume path has a lot to decrement.)
------------------------------------------------------------

SELECT lives_ok(
  format($$
    SELECT private.execute_scan_action(
      p_user_id            => %L::uuid,
      p_product_id         => %L::uuid,
      p_mode               => 'consume_macros',
      p_qty                => 1,
      p_unit               => 'serving',
      p_nutrition_snapshot => NULL
    )
  $$, :'_uid', :'_pid'),
  'execute_scan_action(consume_macros) does not raise'
);

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.food_logs
    WHERE user_id = :'_uid'::uuid
      AND product_id = :'_pid'::uuid),
  '=', 1,
  'consume_macros wrote a food_log'
);

------------------------------------------------------------
-- Test 5–7 — consume_no_macros decrements stock but writes
-- NO food_log. After the consume_macros call above, the lot
-- has 0.5 containers left (purchase=1, then 1 serving = 0.5
-- containers via servings_per_container=2). consume_no_macros
-- with 1 serving (= 0.5 containers) drains the lot exactly →
-- consume_product's FEFO waterfall DELETES depleted lots, so
-- the stock row goes away (count=0), distinct from the legacy
-- floor-at-0 in-place behavior.
------------------------------------------------------------

SELECT lives_ok(
  format($$
    SELECT private.execute_scan_action(
      p_user_id            => %L::uuid,
      p_product_id         => %L::uuid,
      p_mode               => 'consume_no_macros',
      p_qty                => 1,
      p_unit               => 'serving',
      p_nutrition_snapshot => NULL
    )
  $$, :'_uid', :'_pid'),
  'execute_scan_action(consume_no_macros) does not raise'
);

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.food_logs
    WHERE user_id = :'_uid'::uuid
      AND product_id = :'_pid'::uuid),
  '=', 1,
  'consume_no_macros did NOT write an additional food_log (still 1 from consume_macros)'
);

-- Gap G1: depleted lots are now soft-deleted (deleted_at IS NOT NULL)
-- instead of hard-deleted, so the Pi's lot_snapshot_poller can mirror
-- the tombstone. We filter to live rows only.
SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id    = :'_uid'::uuid
      AND product_id = :'_pid'::uuid
      AND deleted_at IS NULL),
  '=', 0,
  'consume_no_macros drained the stock_lot to 0 (FEFO waterfall soft-deletes depleted lots)'
);

------------------------------------------------------------
-- Test 8–10 — shopping mode upserts a shopping_list row and
-- sums qty_containers on a second call for the same product
-- (ON CONFLICT DO UPDATE … qty_containers + EXCLUDED).
------------------------------------------------------------

SELECT lives_ok(
  format($$
    SELECT private.execute_scan_action(
      p_user_id            => %L::uuid,
      p_product_id         => %L::uuid,
      p_mode               => 'shopping',
      p_qty                => 1,
      p_unit               => 'container',
      p_nutrition_snapshot => NULL
    )
  $$, :'_uid', :'_pid'),
  'execute_scan_action(shopping) first call does not raise'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.shopping_list
    WHERE user_id    = :'_uid'::uuid
      AND product_id = :'_pid'::uuid),
  1.000::numeric,
  'shopping inserted exactly one shopping_list row with qty=1'
);

-- Second call with qty=2 should sum into the same row → 3.
SELECT private.execute_scan_action(
  p_user_id            => :'_uid'::uuid,
  p_product_id         => :'_pid'::uuid,
  p_mode               => 'shopping',
  p_qty                => 2,
  p_unit               => 'container',
  p_nutrition_snapshot => NULL
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.shopping_list
    WHERE user_id    = :'_uid'::uuid
      AND product_id = :'_pid'::uuid),
  3.000::numeric,
  'shopping second call summed qty into the existing row (1+2=3)'
);

------------------------------------------------------------
-- Test 11 + 12 — Macros invariant: consume_macros with EMPTY
-- stock still writes a food_log. Stock is already empty for
-- the test product (consume_no_macros above drained the lot),
-- so this directly probes the "macros always logged for full
-- consumed amount regardless of stock" project rule.
------------------------------------------------------------

-- Sanity: stock IS empty heading in (live rows only; tombstones excluded).
SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid
      AND product_id = :'_pid'::uuid
      AND deleted_at IS NULL),
  '=', 0,
  'precondition: stock_lots is empty for the test product (live rows only)'
);

-- Capture food_logs count before the empty-stock consume.
SELECT (SELECT count(*)::int FROM chefbyte.food_logs
         WHERE user_id    = :'_uid'::uuid
           AND product_id = :'_pid'::uuid) AS _logs_before \gset

SELECT lives_ok(
  format($$
    SELECT private.execute_scan_action(
      p_user_id            => %L::uuid,
      p_product_id         => %L::uuid,
      p_mode               => 'consume_macros',
      p_qty                => 1,
      p_unit               => 'serving',
      p_nutrition_snapshot => NULL
    )
  $$, :'_uid', :'_pid'),
  'consume_macros with 0 stock does not raise (stock floors, macros invariant)'
);

SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.food_logs
    WHERE user_id    = :'_uid'::uuid
      AND product_id = :'_pid'::uuid),
  '>', :'_logs_before'::int,
  'consume_macros with 0 stock STILL wrote a food_log (macros invariant)'
);

------------------------------------------------------------
-- Test 13–15 — Multi-lot FEFO waterfall (verifies I-1 fix).
-- Seed 2 lots: lot A qty=0.5 expires sooner, lot B qty=10
-- expires later. consume_no_macros qty=2 containers should
-- waterfall: drain A entirely (0.5), decrement B by 1.5
-- (leaving B with 8.5). The pre-fix single-lot path would
-- only decrement A (floored at 0), silently under-counting.
------------------------------------------------------------

-- Seed two lots with distinct expiration dates so FEFO ordering is stable.
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on,
  last_update_source, last_update_ts
)
SELECT :'_uid'::uuid, :'_pid'::uuid, l.location_id, 0.5,
       (current_date + 1)::date, 'manual', now()
  FROM chefbyte.locations l
 WHERE l.user_id = :'_uid'::uuid
 ORDER BY l.created_at ASC LIMIT 1;

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on,
  last_update_source, last_update_ts
)
SELECT :'_uid'::uuid, :'_pid'::uuid, l.location_id, 10,
       (current_date + 30)::date, 'manual', now()
  FROM chefbyte.locations l
 WHERE l.user_id = :'_uid'::uuid
 ORDER BY l.created_at ASC LIMIT 1;

SELECT lives_ok(
  format($$
    SELECT private.execute_scan_action(
      p_user_id            => %L::uuid,
      p_product_id         => %L::uuid,
      p_mode               => 'consume_no_macros',
      p_qty                => 2,
      p_unit               => 'container',
      p_nutrition_snapshot => NULL
    )
  $$, :'_uid', :'_pid'),
  'multi-lot consume_no_macros qty=2 containers does not raise'
);

-- Lot A (qty=0.5, expires sooner) should be fully drained → SOFT-DELETED
-- per Gap G1 (deleted_at IS NOT NULL, qty_containers = 0).
SELECT cmp_ok(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid
      AND product_id = :'_pid'::uuid
      AND expires_on = (current_date + 1)::date
      AND deleted_at IS NULL),
  '=', 0,
  'multi-lot waterfall: lot A (nearer expiry) fully drained and soft-deleted'
);

-- Lot B (qty=10, expires later) should have 10 - 1.5 = 8.5 remaining.
SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE user_id = :'_uid'::uuid
      AND product_id = :'_pid'::uuid
      AND expires_on = (current_date + 30)::date),
  8.500::numeric,
  'multi-lot waterfall: lot B (later expiry) decremented by remainder (10 - 1.5 = 8.5)'
);

------------------------------------------------------------
-- Test 16 — Missing product raises 'product_not_found_or_unauthorized'.
-- Use a random UUID so no row matches; covers the I-2 fix.
------------------------------------------------------------

SELECT throws_ok(
  format($$
    SELECT private.execute_scan_action(
      p_user_id            => %L::uuid,
      p_product_id         => '00000000-0000-0000-0000-000000000000'::uuid,
      p_mode               => 'purchase',
      p_qty                => 1,
      p_unit               => 'container',
      p_nutrition_snapshot => NULL
    )
  $$, :'_uid'),
  'product_not_found_or_unauthorized',
  'execute_scan_action raises product_not_found_or_unauthorized on missing product'
);

------------------------------------------------------------
-- Test 17 — purchase with no locations configured raises
-- 'no_location_configured'. Cascade-delete locations (this
-- also cascade-deletes the stock_lots created above), then
-- attempt a purchase. Product still exists, so the new
-- product-existence check passes; the location check fires.
------------------------------------------------------------

DELETE FROM chefbyte.locations WHERE user_id = :'_uid'::uuid;

SELECT throws_ok(
  format($$
    SELECT private.execute_scan_action(
      p_user_id            => %L::uuid,
      p_product_id         => %L::uuid,
      p_mode               => 'purchase',
      p_qty                => 1,
      p_unit               => 'container',
      p_nutrition_snapshot => NULL
    )
  $$, :'_uid', :'_pid'),
  'no_location_configured',
  'purchase with no locations raises no_location_configured'
);

------------------------------------------------------------
-- Teardown
------------------------------------------------------------

RESET ROLE;
SELECT tests.delete_supabase_user('scan_user');

SELECT * FROM finish();
ROLLBACK;
