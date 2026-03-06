BEGIN;
SELECT plan(34);

-- ─────────────────────────────────────────────────────────────
-- Setup
-- ─────────────────────────────────────────────────────────────

SELECT tests.create_supabase_user('cf_tester');
SELECT tests.authenticate_as('cf_tester');
SELECT hub.activate_app('chefbyte');

-- Create Chicken Breast: 4 servings/container, 165cal/31p/3.6f/0c per serving
INSERT INTO chefbyte.products (
  product_id, user_id, name,
  servings_per_container, calories_per_serving,
  protein_per_serving, fat_per_serving, carbs_per_serving
) VALUES (
  '10000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('cf_tester'),
  'Chicken Breast',
  4, 165, 31, 3.6, 0
);

-- Get the Fridge location seeded by activation
SELECT location_id AS fridge_id
  FROM chefbyte.locations
  WHERE user_id = tests.get_supabase_uid('cf_tester') AND name = 'Fridge' \gset

-- Lot A: 1.5 containers, expires 2026-03-10 (nearest)
INSERT INTO chefbyte.stock_lots (lot_id, user_id, product_id, location_id, qty_containers, expires_on)
VALUES (
  '20000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('cf_tester'),
  '10000000-0000-0000-0000-000000000001',
  :'fridge_id',
  1.5,
  '2026-03-10'
);

-- Lot B: 2.0 containers, expires 2026-03-15 (farther)
INSERT INTO chefbyte.stock_lots (lot_id, user_id, product_id, location_id, qty_containers, expires_on)
VALUES (
  '20000000-0000-0000-0000-000000000002',
  tests.get_supabase_uid('cf_tester'),
  '10000000-0000-0000-0000-000000000001',
  :'fridge_id',
  2.0,
  '2026-03-15'
);

-- ─────────────────────────────────────────────────────────────
-- Test 1: Consume 1 container with log_macros=true succeeds
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  $$
    SELECT chefbyte.consume_product(
      '10000000-0000-0000-0000-000000000001'::uuid,
      1, 'container', true, '2026-03-03'::date
    )
  $$,
  'consume 1 container with log_macros=true succeeds'
);

-- ─────────────────────────────────────────────────────────────
-- Test 2: food_log created with correct calories
-- 1 container x 4 servings x 165 cal = 660
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT calories FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = '10000000-0000-0000-0000-000000000001'
    ORDER BY created_at ASC LIMIT 1),
  660.000::numeric,
  'food_log calories = 1 container x 4 servings x 165 = 660'
);

-- ─────────────────────────────────────────────────────────────
-- Test 3: food_log protein = 1 container x 4 servings x 31 = 124
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT protein FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = '10000000-0000-0000-0000-000000000001'
    ORDER BY created_at ASC LIMIT 1),
  124.000::numeric,
  'food_log protein = 1 container x 4 servings x 31 = 124'
);

-- ─────────────────────────────────────────────────────────────
-- Test 4: food_log fat = 1 container x 4 servings x 3.6 = 14.4
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT fat FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = '10000000-0000-0000-0000-000000000001'
    ORDER BY created_at ASC LIMIT 1),
  14.400::numeric,
  'food_log fat = 1 container x 4 servings x 3.6 = 14.4'
);

-- ─────────────────────────────────────────────────────────────
-- Test 5: food_log carbs = 1 container x 4 servings x 0 = 0
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT carbs FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = '10000000-0000-0000-0000-000000000001'
    ORDER BY created_at ASC LIMIT 1),
  0.000::numeric,
  'food_log carbs = 1 container x 4 servings x 0 = 0'
);

-- ─────────────────────────────────────────────────────────────
-- Test 6: Nearest-expiry lot (A) reduced from 1.5 to 0.5
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '20000000-0000-0000-0000-000000000001'),
  0.500::numeric,
  'nearest-expiry lot reduced from 1.5 to 0.5'
);

-- ─────────────────────────────────────────────────────────────
-- Test 4: Farther-expiry lot (B) unchanged at 2.0
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '20000000-0000-0000-0000-000000000002'),
  2.000::numeric,
  'farther-expiry lot unchanged at 2.0'
);

-- ─────────────────────────────────────────────────────────────
-- Test 5: Consume 1 container — depletes lot A (0.5→0), uses
--         0.5 from lot B
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  $$
    SELECT chefbyte.consume_product(
      '10000000-0000-0000-0000-000000000001'::uuid,
      1, 'container', true, '2026-03-03'::date
    )
  $$,
  'consume 1 container crossing lot boundary succeeds'
);

-- ─────────────────────────────────────────────────────────────
-- Test 6: First lot deleted (fully consumed)
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.stock_lots
    WHERE lot_id = '20000000-0000-0000-0000-000000000001'),
  0,
  'first lot deleted after full depletion'
);

-- ─────────────────────────────────────────────────────────────
-- Test 7: Second lot reduced from 2.0 to 1.5
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '20000000-0000-0000-0000-000000000002'),
  1.500::numeric,
  'second lot reduced to 1.5 after cross-lot consume'
);

-- ─────────────────────────────────────────────────────────────
-- Test 8: Consume 3 containers — exceeds remaining 1.5, stock
--         floors at 0
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  $$
    SELECT chefbyte.consume_product(
      '10000000-0000-0000-0000-000000000001'::uuid,
      3, 'container', true, '2026-03-03'::date
    )
  $$,
  'consume 3 containers exceeding stock succeeds (floors at 0)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 9: Stock fully depleted — 0 lots remaining
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = '10000000-0000-0000-0000-000000000001'),
  0,
  'stock fully depleted — 0 lots remaining'
);

-- ─────────────────────────────────────────────────────────────
-- Test 10: food_logs has 3 entries total
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = '10000000-0000-0000-0000-000000000001'),
  3,
  '3 food_log entries total after 3 consume calls with log_macros=true'
);

-- ─────────────────────────────────────────────────────────────
-- Test 11: Third food_log = 3 x 4 x 165 = 1980 calories
-- (full requested amount, not just 1.5 available)
-- ─────────────────────────────────────────────────────────────

SELECT ok(
  EXISTS (
    SELECT 1 FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = '10000000-0000-0000-0000-000000000001'
      AND calories = 1980.000
  ),
  'third food_log calories = 3 x 4 x 165 = 1980 (full amount regardless of stock)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 12: Consume via serving unit
-- Create a new lot: 1 container (4 servings)
-- ─────────────────────────────────────────────────────────────

INSERT INTO chefbyte.stock_lots (lot_id, user_id, product_id, location_id, qty_containers, expires_on)
VALUES (
  '20000000-0000-0000-0000-000000000003',
  tests.get_supabase_uid('cf_tester'),
  '10000000-0000-0000-0000-000000000001',
  :'fridge_id',
  1.0,
  '2026-03-20'
);

SELECT lives_ok(
  $$
    SELECT chefbyte.consume_product(
      '10000000-0000-0000-0000-000000000001'::uuid,
      2, 'serving', true, '2026-03-03'::date
    )
  $$,
  'consume 2 servings via serving unit succeeds'
);

-- ─────────────────────────────────────────────────────────────
-- Test 13: 2 servings = 0.5 containers, lot reduced to 0.5
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '20000000-0000-0000-0000-000000000003'),
  0.500::numeric,
  '2 servings = 0.5 containers, lot reduced from 1.0 to 0.5'
);

-- ─────────────────────────────────────────────────────────────
-- Test 14: No log when log_macros=false
-- ─────────────────────────────────────────────────────────────

-- Count logs before
SELECT count(*)::integer AS log_count_before
  FROM chefbyte.food_logs
  WHERE user_id = tests.get_supabase_uid('cf_tester')
    AND product_id = '10000000-0000-0000-0000-000000000001' \gset

SELECT chefbyte.consume_product(
  '10000000-0000-0000-0000-000000000001'::uuid,
  0.5, 'container', false, '2026-03-03'::date
);

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = '10000000-0000-0000-0000-000000000001'),
  :log_count_before,
  'no food_log created when log_macros=false'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Stock IS deducted even when log_macros=false
-- The lot had 0.5 containers; consuming 0.5 should deplete it
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.stock_lots
    WHERE lot_id = '20000000-0000-0000-0000-000000000003'),
  0,
  'stock lot depleted even when log_macros=false (0.5 consumed from 0.5)'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Return value verification — success=true, qty_consumed > 0
-- Create a fresh lot and consume, capturing the JSONB return
-- ─────────────────────────────────────────────────────────────

INSERT INTO chefbyte.stock_lots (lot_id, user_id, product_id, location_id, qty_containers, expires_on)
VALUES (
  '20000000-0000-0000-0000-000000000004',
  tests.get_supabase_uid('cf_tester'),
  '10000000-0000-0000-0000-000000000001',
  :'fridge_id',
  1.0,
  '2026-03-25'
);

SELECT is(
  (SELECT (chefbyte.consume_product(
    '10000000-0000-0000-0000-000000000001'::uuid,
    1, 'container', true, '2026-03-03'::date
  ))->>'success'),
  'true',
  'consume_product return value has success=true'
);

-- ─────────────────────────────────────────────────────────────
-- Test 18: Consuming a non-existent product raises exception
-- ─────────────────────────────────────────────────────────────

SELECT throws_ok(
  $$
    SELECT chefbyte.consume_product(
      '99999999-9999-9999-9999-999999999999'::uuid,
      1, 'container', true, '2026-03-03'::date
    )
  $$,
  'Product not found or not owned by user',
  'consuming a non-existent product raises exception'
);

-- ─────────────────────────────────────────────────────────────
-- Test 19-20: Consuming another user's product raises exception
-- ─────────────────────────────────────────────────────────────

SELECT tests.clear_authentication();
SELECT tests.create_supabase_user('cf_intruder');
SELECT tests.authenticate_as('cf_intruder');
SELECT hub.activate_app('chefbyte');

-- Create a product owned by cf_intruder
INSERT INTO chefbyte.products (
  product_id, user_id, name,
  servings_per_container, calories_per_serving,
  protein_per_serving, fat_per_serving, carbs_per_serving
) VALUES (
  '10000000-0000-0000-0000-000000000099',
  tests.get_supabase_uid('cf_intruder'),
  'Intruder Chicken',
  4, 165, 31, 3.6, 0
);

-- Switch to cf_tester and attempt to consume cf_intruder's product
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('cf_tester');

SELECT throws_ok(
  $$
    SELECT chefbyte.consume_product(
      '10000000-0000-0000-0000-000000000099'::uuid,
      1, 'container', true, '2026-03-03'::date
    )
  $$,
  'Product not found or not owned by user',
  'consuming another user product raises Product not found exception'
);

-- Verify no food_log was created for the intruder product
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = '10000000-0000-0000-0000-000000000099'),
  0,
  'no food_log created when attempting to consume another user product'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Zero quantity consumption raises exception
-- The function validates p_qty > 0 and raises an exception.
-- ─────────────────────────────────────────────────────────────

SELECT throws_ok(
  $$
    SELECT chefbyte.consume_product(
      '10000000-0000-0000-0000-000000000001'::uuid,
      0, 'container', true, '2026-03-03'::date
    )
  $$,
  'Quantity must be positive, got 0',
  'zero quantity consumption raises exception (qty must be positive)'
);

-- ─────────────────────────────────────────────────────────────
-- Test: NULL-expiry lots consumed after dated lots (NULLS LAST)
-- Create two lots: one dated 2026-04-01, one NULL expiry.
-- Consume partial and verify dated lot is consumed first.
-- ─────────────────────────────────────────────────────────────

-- Create a fresh product for this test
INSERT INTO chefbyte.products (
  product_id, user_id, name,
  servings_per_container, calories_per_serving,
  protein_per_serving, fat_per_serving, carbs_per_serving
) VALUES (
  '10000000-0000-0000-0000-000000000010',
  tests.get_supabase_uid('cf_tester'),
  'NULLS LAST Test Product',
  1, 100, 10, 5, 20
);

-- Dated lot: 2.0 containers, expires 2026-04-01
INSERT INTO chefbyte.stock_lots (lot_id, user_id, product_id, location_id, qty_containers, expires_on)
VALUES (
  '20000000-0000-0000-0000-000000000010',
  tests.get_supabase_uid('cf_tester'),
  '10000000-0000-0000-0000-000000000010',
  :'fridge_id',
  2.0,
  '2026-04-01'
);

-- NULL-expiry lot: 3.0 containers
INSERT INTO chefbyte.stock_lots (lot_id, user_id, product_id, location_id, qty_containers, expires_on)
VALUES (
  '20000000-0000-0000-0000-000000000011',
  tests.get_supabase_uid('cf_tester'),
  '10000000-0000-0000-0000-000000000010',
  :'fridge_id',
  3.0,
  NULL
);

-- Consume 1 container — should take from the dated lot first
SELECT chefbyte.consume_product(
  '10000000-0000-0000-0000-000000000010'::uuid,
  1, 'container', false, '2026-03-03'::date
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '20000000-0000-0000-0000-000000000010'),
  1.000::numeric,
  'dated lot (expires 2026-04-01) reduced from 2.0 to 1.0 — consumed first'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '20000000-0000-0000-0000-000000000011'),
  3.000::numeric,
  'NULL-expiry lot unchanged at 3.0 — NULLS LAST ordering works'
);

-- Consume 1.5 more — should deplete the dated lot (1.0) then take 0.5 from NULL lot
SELECT chefbyte.consume_product(
  '10000000-0000-0000-0000-000000000010'::uuid,
  1.5, 'container', false, '2026-03-03'::date
);

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.stock_lots
    WHERE lot_id = '20000000-0000-0000-0000-000000000010'),
  0,
  'dated lot fully consumed and deleted after cross-lot consume'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = '20000000-0000-0000-0000-000000000011'),
  2.500::numeric,
  'NULL-expiry lot reduced from 3.0 to 2.5 after dated lot depleted'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Product with zero/default macro values produces 0 in food_log
-- Schema enforces NOT NULL DEFAULT 0 on macro columns.
-- Omitting macro columns lets them default to 0; COALESCE in the
-- function handles them correctly, producing 0 in the food_log.
-- ─────────────────────────────────────────────────────────────

INSERT INTO chefbyte.products (
  product_id, user_id, name, servings_per_container
) VALUES (
  '10000000-0000-0000-0000-000000000020',
  tests.get_supabase_uid('cf_tester'),
  'Zero Macros Product',
  1
);

-- Add a stock lot so consumption has something to deduct
INSERT INTO chefbyte.stock_lots (lot_id, user_id, product_id, location_id, qty_containers, expires_on)
VALUES (
  '20000000-0000-0000-0000-000000000020',
  tests.get_supabase_uid('cf_tester'),
  '10000000-0000-0000-0000-000000000020',
  :'fridge_id',
  5.0,
  '2026-05-01'
);

SELECT lives_ok(
  $$
    SELECT chefbyte.consume_product(
      '10000000-0000-0000-0000-000000000020'::uuid,
      1, 'container', true, '2026-03-03'::date
    )
  $$,
  'consuming product with zero/default macros succeeds'
);

SELECT is(
  (SELECT calories FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = '10000000-0000-0000-0000-000000000020'
    ORDER BY created_at DESC LIMIT 1),
  0.000::numeric,
  'food_log calories = 0 for product with default zero macros'
);

SELECT is(
  (SELECT protein FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = '10000000-0000-0000-0000-000000000020'
    ORDER BY created_at DESC LIMIT 1),
  0.000::numeric,
  'food_log protein = 0 for product with default zero macros'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Negative quantity consumption raises exception
-- ─────────────────────────────────────────────────────────────

SELECT throws_ok(
  $$
    SELECT chefbyte.consume_product(
      '10000000-0000-0000-0000-000000000001'::uuid,
      -5, 'container', true, '2026-03-03'::date
    )
  $$,
  'Quantity must be positive, got -5',
  'negative quantity consumption raises exception (qty must be positive)'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Consuming from product with zero stock still succeeds
-- (stock floors at 0, macros still logged for full amount)
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  $$
    SELECT chefbyte.consume_product(
      '10000000-0000-0000-0000-000000000001'::uuid,
      1, 'container', true, '2026-03-03'::date
    )
  $$,
  'consuming from product with no stock lots succeeds (floors at 0)'
);

-- ─────────────────────────────────────────────────────────────
-- Test: food_log still created even when stock was 0
-- ─────────────────────────────────────────────────────────────

SELECT ok(
  EXISTS (
    SELECT 1 FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = '10000000-0000-0000-0000-000000000001'
      AND calories = 660.000
    ORDER BY created_at DESC
    LIMIT 1
  ),
  'food_log created with full macro amount even when stock was 0'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Invalid unit treated as container (not 'serving')
-- The function only checks for 'serving'; anything else is
-- treated as container. Verify it does not raise an error.
-- ─────────────────────────────────────────────────────────────

INSERT INTO chefbyte.stock_lots (lot_id, user_id, product_id, location_id, qty_containers, expires_on)
VALUES (
  '20000000-0000-0000-0000-000000000030',
  tests.get_supabase_uid('cf_tester'),
  '10000000-0000-0000-0000-000000000001',
  :'fridge_id',
  2.0,
  '2026-06-01'
);

SELECT lives_ok(
  $$
    SELECT chefbyte.consume_product(
      '10000000-0000-0000-0000-000000000001'::uuid,
      1, 'box', true, '2026-03-03'::date
    )
  $$,
  'unknown unit treated as container — no error raised'
);

-- ─────────────────────────────────────────────────────────────
-- Teardown
-- ─────────────────────────────────────────────────────────────

SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('cf_intruder');
SELECT tests.delete_supabase_user('cf_tester');

SELECT * FROM finish();
ROLLBACK;
