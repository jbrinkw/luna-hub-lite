BEGIN;
SELECT plan(14);

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
-- Test 3: Nearest-expiry lot (A) reduced from 1.5 to 0.5
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
-- Teardown
-- ─────────────────────────────────────────────────────────────

SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('cf_tester');

SELECT * FROM finish();
ROLLBACK;
