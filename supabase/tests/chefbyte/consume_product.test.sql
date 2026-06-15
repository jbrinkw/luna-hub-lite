-- CB-PG-03 (MOCK_AUDIT_CHEFBYTE_SERVER.md 2026-04-29): replaced all
-- hardcoded product/lot UUIDs with gen_random_uuid() + RETURNING capture
-- via _test_state temp table to eliminate identity-collision risk.
-- Previously, 10000000-...0001 (product) and 20000000-...0001 (lot) used
-- adjacent namespaces; cf_intruder's product at 10000000-...0099 shared
-- the same prefix, creating FK-collision risk under concurrent runs.

BEGIN;
SELECT plan(40);

-- ─────────────────────────────────────────────────────────────
-- Setup — capture generated IDs into a temp table to avoid
-- hardcoded-UUID identity collisions (CB-PG-03).
-- ─────────────────────────────────────────────────────────────

SELECT tests.create_supabase_user('cf_tester');
SELECT tests.authenticate_as('cf_tester');
SELECT hub.activate_app('chefbyte');

-- Temp state table — all generated IDs land here
CREATE TEMP TABLE _test_state (
  key   TEXT PRIMARY KEY,
  val   TEXT NOT NULL
);

-- Chicken Breast: 4 servings/container, 165cal/31p/3.6f/0c per serving
WITH ins AS (
  INSERT INTO chefbyte.products (
    user_id, name,
    servings_per_container, calories_per_serving,
    protein_per_serving, fat_per_serving, carbs_per_serving
  ) VALUES (
    tests.get_supabase_uid('cf_tester'),
    'Chicken Breast',
    4, 165, 31, 3.6, 0
  ) RETURNING product_id
)
INSERT INTO _test_state SELECT 'chicken_pid', product_id::text FROM ins;

-- Get the Fridge location seeded by activation
INSERT INTO _test_state
  SELECT 'fridge_id', location_id::text
    FROM chefbyte.locations
   WHERE user_id = tests.get_supabase_uid('cf_tester') AND name = 'Fridge';

-- Lot A: 1.5 containers, expires 2026-03-10 (nearest)
WITH ins AS (
  INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
  VALUES (
    tests.get_supabase_uid('cf_tester'),
    (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid'),
    (SELECT val::uuid FROM _test_state WHERE key = 'fridge_id'),
    1.5,
    '2026-03-10'
  ) RETURNING lot_id
)
INSERT INTO _test_state SELECT 'lot_a', lot_id::text FROM ins;

-- Lot B: 2.0 containers, expires 2026-03-15 (farther)
WITH ins AS (
  INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
  VALUES (
    tests.get_supabase_uid('cf_tester'),
    (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid'),
    (SELECT val::uuid FROM _test_state WHERE key = 'fridge_id'),
    2.0,
    '2026-03-15'
  ) RETURNING lot_id
)
INSERT INTO _test_state SELECT 'lot_b', lot_id::text FROM ins;

-- ─────────────────────────────────────────────────────────────
-- Test 1: Consume 1 container with log_macros=true succeeds
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  format($$
    SELECT chefbyte.consume_product(
      %L::uuid,
      1, 'container', true, '2026-03-03'::date
    )
  $$, (SELECT val FROM _test_state WHERE key = 'chicken_pid')),
  'consume 1 container with log_macros=true succeeds'
);

-- ─────────────────────────────────────────────────────────────
-- Test 2: food_log created with correct calories
-- 1 container x 4 servings x 165 cal = 660
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT calories FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid')
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
      AND product_id = (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid')
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
      AND product_id = (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid')
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
      AND product_id = (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid')
    ORDER BY created_at ASC LIMIT 1),
  0.000::numeric,
  'food_log carbs = 1 container x 4 servings x 0 = 0'
);

-- ─────────────────────────────────────────────────────────────
-- Test 6: Nearest-expiry lot (A) reduced from 1.5 to 0.5
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = (SELECT val::uuid FROM _test_state WHERE key = 'lot_a')),
  0.500::numeric,
  'nearest-expiry lot reduced from 1.5 to 0.5'
);

-- ─────────────────────────────────────────────────────────────
-- Test 7: Farther-expiry lot (B) unchanged at 2.0
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = (SELECT val::uuid FROM _test_state WHERE key = 'lot_b')),
  2.000::numeric,
  'farther-expiry lot unchanged at 2.0'
);

-- ─────────────────────────────────────────────────────────────
-- Test 8: Consume 1 container — depletes lot A (0.5→0), uses
--         0.5 from lot B
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  format($$
    SELECT chefbyte.consume_product(
      %L::uuid,
      1, 'container', true, '2026-03-03'::date
    )
  $$, (SELECT val FROM _test_state WHERE key = 'chicken_pid')),
  'consume 1 container crossing lot boundary succeeds'
);

-- ─────────────────────────────────────────────────────────────
-- Test 9: First lot soft-deleted (fully consumed) — Gap G1 fix.
-- Migration 20260515010000 converts the FIFO depletion DELETE to a
-- soft-delete so the Pi's lot_snapshot poller sees the tombstone.
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.stock_lots
    WHERE lot_id = (SELECT val::uuid FROM _test_state WHERE key = 'lot_a')
      AND deleted_at IS NULL),
  0,
  'first lot soft-deleted after full depletion (deleted_at IS NOT NULL)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 10: Second lot reduced from 2.0 to 1.5
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = (SELECT val::uuid FROM _test_state WHERE key = 'lot_b')),
  1.500::numeric,
  'second lot reduced to 1.5 after cross-lot consume'
);

-- ─────────────────────────────────────────────────────────────
-- Test 11: Consume 3 containers — exceeds remaining 1.5, stock
--          floors at 0
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  format($$
    SELECT chefbyte.consume_product(
      %L::uuid,
      3, 'container', true, '2026-03-03'::date
    )
  $$, (SELECT val FROM _test_state WHERE key = 'chicken_pid')),
  'consume 3 containers exceeding stock succeeds (floors at 0)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 12: Stock fully depleted — 0 LIVE lots remaining (Gap G1).
-- Tombstones from prior soft-deletes are excluded via deleted_at IS NULL.
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid')
      AND deleted_at IS NULL),
  0,
  'stock fully depleted — 0 LIVE lots remaining (tombstones excluded)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 13: food_logs has 3 entries total
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid')),
  3,
  '3 food_log entries total after 3 consume calls with log_macros=true'
);

-- ─────────────────────────────────────────────────────────────
-- Test 14: Third food_log = 3 x 4 x 165 = 1980 calories
-- (full requested amount, not just 1.5 available)
-- ─────────────────────────────────────────────────────────────

SELECT ok(
  EXISTS (
    SELECT 1 FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid')
      AND calories = 1980.000
  ),
  'third food_log calories = 3 x 4 x 165 = 1980 (full amount regardless of stock)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 15: Consume via serving unit
-- Create a new lot: 1 container (4 servings)
-- ─────────────────────────────────────────────────────────────

WITH ins AS (
  INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
  VALUES (
    tests.get_supabase_uid('cf_tester'),
    (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid'),
    (SELECT val::uuid FROM _test_state WHERE key = 'fridge_id'),
    1.0,
    '2026-03-20'
  ) RETURNING lot_id
)
INSERT INTO _test_state SELECT 'lot_serving', lot_id::text FROM ins;

SELECT lives_ok(
  format($$
    SELECT chefbyte.consume_product(
      %L::uuid,
      2, 'serving', true, '2026-03-03'::date
    )
  $$, (SELECT val FROM _test_state WHERE key = 'chicken_pid')),
  'consume 2 servings via serving unit succeeds'
);

-- ─────────────────────────────────────────────────────────────
-- Test 16: 2 servings = 0.5 containers, lot reduced to 0.5
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = (SELECT val::uuid FROM _test_state WHERE key = 'lot_serving')),
  0.500::numeric,
  '2 servings = 0.5 containers, lot reduced from 1.0 to 0.5'
);

-- ─────────────────────────────────────────────────────────────
-- Test 17: No log when log_macros=false
-- ─────────────────────────────────────────────────────────────

-- Count logs before
DO $$
DECLARE v_before INTEGER;
BEGIN
  SELECT count(*)::integer INTO v_before FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid');
  INSERT INTO _test_state VALUES ('log_count_before', v_before::text)
    ON CONFLICT (key) DO UPDATE SET val = EXCLUDED.val;
END $$;

SELECT chefbyte.consume_product(
  (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid'),
  0.5, 'container', false, '2026-03-03'::date
);

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid')),
  (SELECT val::integer FROM _test_state WHERE key = 'log_count_before'),
  'no food_log created when log_macros=false'
);

-- ─────────────────────────────────────────────────────────────
-- Test 18: Stock IS deducted even when log_macros=false
-- The lot had 0.5 containers; consuming 0.5 should deplete it
-- (soft-delete per Gap G1)
-- ─────────────────────────────────────────────────────────────

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.stock_lots
    WHERE lot_id = (SELECT val::uuid FROM _test_state WHERE key = 'lot_serving')
      AND deleted_at IS NULL),
  0,
  'stock lot soft-deleted even when log_macros=false (0.5 consumed from 0.5)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 19: Return value verification — success=true, qty_consumed > 0
-- Create a fresh lot and consume, capturing the JSONB return
-- ─────────────────────────────────────────────────────────────

WITH ins AS (
  INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
  VALUES (
    tests.get_supabase_uid('cf_tester'),
    (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid'),
    (SELECT val::uuid FROM _test_state WHERE key = 'fridge_id'),
    1.0,
    '2026-03-25'
  ) RETURNING lot_id
)
INSERT INTO _test_state SELECT 'lot_ret', lot_id::text FROM ins;

SELECT is(
  (SELECT (chefbyte.consume_product(
    (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid'),
    1, 'container', true, '2026-03-03'::date
  ))->>'success'),
  'true',
  'consume_product return value has success=true'
);

-- ─────────────────────────────────────────────────────────────
-- L5: Full JSONB return value verification — all keys checked
-- Create a fresh lot for predictable return values.
-- Product: Chicken Breast (4 spc, 165cal/31p/3.6f/0c)
-- Lot: 2.0 containers → consume 1 container → stock_remaining=1.0
-- ─────────────────────────────────────────────────────────────

WITH ins AS (
  INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
  VALUES (
    tests.get_supabase_uid('cf_tester'),
    (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid'),
    (SELECT val::uuid FROM _test_state WHERE key = 'fridge_id'),
    2.0,
    '2026-07-01'
  ) RETURNING lot_id
)
INSERT INTO _test_state SELECT 'lot_full_check', lot_id::text FROM ins;

-- Capture the full JSONB return to check all keys
SELECT is(
  (SELECT (chefbyte.consume_product(
    (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid'),
    1, 'container', true, '2026-03-03'::date
  ))->>'qty_consumed'),
  '1',
  'consume_product return: qty_consumed = 1 (matches requested amount)'
);

-- Consume again for remaining assertions (lot has 1.0 left, consume 0.5)
SELECT is(
  (SELECT (chefbyte.consume_product(
    (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid'),
    0.5, 'container', true, '2026-03-03'::date
  ))->'macros'->>'calories'),
  '330.000',
  'consume_product return: macros.calories = 0.5 * 4spc * 165 = 330'
);

-- One more consume to verify stock_remaining and nested macros
SELECT is(
  (SELECT (chefbyte.consume_product(
    (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid'),
    0.25, 'container', true, '2026-03-03'::date
  ))->>'stock_remaining'),
  '0.250',
  'consume_product return: stock_remaining = 0.25 after consuming 0.25 from 0.5'
);

-- Verify macros sub-object has all four keys (protein, fat, carbs, calories)
SELECT is(
  (SELECT count(*)::integer FROM jsonb_object_keys(
    (SELECT (chefbyte.consume_product(
      (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid'),
      0.25, 'container', false, '2026-03-03'::date
    ))->'macros')
  )),
  4,
  'consume_product return: macros sub-object has exactly 4 keys'
);

-- Verify top-level has exactly 5 keys: success, qty_consumed, food_log_id,
-- macros, stock_remaining. (food_log_id added by 20260515100000 for the
-- H-14 fix — present even when p_log_macros=false, where it is NULL.)
SELECT is(
  (SELECT count(*)::integer FROM jsonb_object_keys(
    chefbyte.consume_product(
      (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid'),
      0.001, 'container', false, '2026-03-03'::date
    )
  )),
  5,
  'consume_product return: top-level JSONB has exactly 5 keys (success, qty_consumed, food_log_id, macros, stock_remaining)'
);

-- H-14: food_log_id is NULL when p_log_macros=false (no row inserted).
SELECT is(
  (SELECT (chefbyte.consume_product(
    (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid'),
    0.001, 'container', false, '2026-03-03'::date
  ))->'food_log_id'),
  'null'::jsonb,
  'consume_product return: food_log_id is JSON null when p_log_macros=false'
);

-- H-14: food_log_id when p_log_macros=true points at a REAL, freshly
-- inserted food_logs row (so mark_meal_done can tag exactly that row).
-- Capture the returned id once, then assert it resolves to an existing
-- row — NOT by re-deriving "latest" (every row in this txn shares
-- created_at, so an ORDER BY created_at re-read is non-deterministic; that
-- fragility is precisely what H-14 replaces).
SELECT ((chefbyte.consume_product(
    (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid'),
    0.001, 'container', true, '2026-03-03'::date
  ))->>'food_log_id') AS h14_log_id \gset

SELECT ok(
  EXISTS (
    SELECT 1 FROM chefbyte.food_logs
    WHERE log_id = :'h14_log_id'::uuid
      AND user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid')
  ),
  'consume_product return: food_log_id resolves to the food_log row it just inserted'
);

-- Verify food_log logical_date is set correctly on records inserted by consume_product
SELECT is(
  (SELECT logical_date FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid')
    ORDER BY created_at DESC LIMIT 1),
  '2026-03-03'::date,
  'food_log logical_date = 2026-03-03 (matches p_logical_date argument)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 27: Consuming a non-existent product raises exception
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
-- Test 28-30: Consuming another user's product raises exception.
-- CB-PG-03: cf_intruder's product uses gen_random_uuid() — distinct
-- from cf_tester's chicken_pid namespace to prevent identity collision.
-- ─────────────────────────────────────────────────────────────

SELECT tests.clear_authentication();
SELECT tests.create_supabase_user('cf_intruder');
SELECT tests.authenticate_as('cf_intruder');
SELECT hub.activate_app('chefbyte');

-- Create a product owned by cf_intruder (UUID generated, not hardcoded)
WITH ins AS (
  INSERT INTO chefbyte.products (
    user_id, name,
    servings_per_container, calories_per_serving,
    protein_per_serving, fat_per_serving, carbs_per_serving
  ) VALUES (
    tests.get_supabase_uid('cf_intruder'),
    'Intruder Chicken',
    4, 165, 31, 3.6, 0
  ) RETURNING product_id
)
INSERT INTO _test_state SELECT 'intruder_pid', product_id::text FROM ins;

-- Switch to cf_tester and attempt to consume cf_intruder's product
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('cf_tester');

SELECT throws_ok(
  format($$
    SELECT chefbyte.consume_product(
      %L::uuid,
      1, 'container', true, '2026-03-03'::date
    )
  $$, (SELECT val FROM _test_state WHERE key = 'intruder_pid')),
  'Product not found or not owned by user',
  'consuming another user product raises Product not found exception'
);

-- Verify no food_log was created for the intruder product
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = (SELECT val::uuid FROM _test_state WHERE key = 'intruder_pid')),
  0,
  'no food_log created when attempting to consume another user product'
);

-- ─────────────────────────────────────────────────────────────
-- Test 31: Zero quantity consumption raises exception
-- ─────────────────────────────────────────────────────────────

SELECT throws_ok(
  format($$
    SELECT chefbyte.consume_product(
      %L::uuid,
      0, 'container', true, '2026-03-03'::date
    )
  $$, (SELECT val FROM _test_state WHERE key = 'chicken_pid')),
  'Quantity must be positive, got 0',
  'zero quantity consumption raises exception (qty must be positive)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 32-35: NULL-expiry lots consumed after dated lots (NULLS LAST)
-- Create two lots: one dated 2026-04-01, one NULL expiry.
-- Consume partial and verify dated lot is consumed first.
-- ─────────────────────────────────────────────────────────────

-- Create a fresh product for this test (gen_random_uuid via RETURNING)
WITH ins AS (
  INSERT INTO chefbyte.products (
    user_id, name,
    servings_per_container, calories_per_serving,
    protein_per_serving, fat_per_serving, carbs_per_serving
  ) VALUES (
    tests.get_supabase_uid('cf_tester'),
    'NULLS LAST Test Product',
    1, 100, 10, 5, 20
  ) RETURNING product_id
)
INSERT INTO _test_state SELECT 'nulllast_pid', product_id::text FROM ins;

-- Dated lot: 2.0 containers, expires 2026-04-01
WITH ins AS (
  INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
  VALUES (
    tests.get_supabase_uid('cf_tester'),
    (SELECT val::uuid FROM _test_state WHERE key = 'nulllast_pid'),
    (SELECT val::uuid FROM _test_state WHERE key = 'fridge_id'),
    2.0,
    '2026-04-01'
  ) RETURNING lot_id
)
INSERT INTO _test_state SELECT 'lot_dated', lot_id::text FROM ins;

-- NULL-expiry lot: 3.0 containers
WITH ins AS (
  INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
  VALUES (
    tests.get_supabase_uid('cf_tester'),
    (SELECT val::uuid FROM _test_state WHERE key = 'nulllast_pid'),
    (SELECT val::uuid FROM _test_state WHERE key = 'fridge_id'),
    3.0,
    NULL
  ) RETURNING lot_id
)
INSERT INTO _test_state SELECT 'lot_null_expiry', lot_id::text FROM ins;

-- Consume 1 container — should take from the dated lot first
SELECT chefbyte.consume_product(
  (SELECT val::uuid FROM _test_state WHERE key = 'nulllast_pid'),
  1, 'container', false, '2026-03-03'::date
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = (SELECT val::uuid FROM _test_state WHERE key = 'lot_dated')),
  1.000::numeric,
  'dated lot (expires 2026-04-01) reduced from 2.0 to 1.0 — consumed first'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = (SELECT val::uuid FROM _test_state WHERE key = 'lot_null_expiry')),
  3.000::numeric,
  'NULL-expiry lot unchanged at 3.0 — NULLS LAST ordering works'
);

-- Consume 1.5 more — should deplete the dated lot (1.0) then take 0.5 from NULL lot
SELECT chefbyte.consume_product(
  (SELECT val::uuid FROM _test_state WHERE key = 'nulllast_pid'),
  1.5, 'container', false, '2026-03-03'::date
);

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.stock_lots
    WHERE lot_id = (SELECT val::uuid FROM _test_state WHERE key = 'lot_dated')
      AND deleted_at IS NULL),
  0,
  'dated lot fully consumed and soft-deleted after cross-lot consume'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = (SELECT val::uuid FROM _test_state WHERE key = 'lot_null_expiry')),
  2.500::numeric,
  'NULL-expiry lot reduced from 3.0 to 2.5 after dated lot depleted'
);

-- ─────────────────────────────────────────────────────────────
-- Test 36-37: Product with zero/default macro values produces 0 in food_log
-- ─────────────────────────────────────────────────────────────

WITH ins AS (
  INSERT INTO chefbyte.products (
    user_id, name, servings_per_container
  ) VALUES (
    tests.get_supabase_uid('cf_tester'),
    'Zero Macros Product',
    1
  ) RETURNING product_id
)
INSERT INTO _test_state SELECT 'zeromacro_pid', product_id::text FROM ins;

WITH ins AS (
  INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
  VALUES (
    tests.get_supabase_uid('cf_tester'),
    (SELECT val::uuid FROM _test_state WHERE key = 'zeromacro_pid'),
    (SELECT val::uuid FROM _test_state WHERE key = 'fridge_id'),
    5.0,
    '2026-05-01'
  ) RETURNING lot_id
)
INSERT INTO _test_state SELECT 'lot_zeromacro', lot_id::text FROM ins;

SELECT lives_ok(
  format($$
    SELECT chefbyte.consume_product(
      %L::uuid,
      1, 'container', true, '2026-03-03'::date
    )
  $$, (SELECT val FROM _test_state WHERE key = 'zeromacro_pid')),
  'consuming product with zero/default macros succeeds'
);

SELECT is(
  (SELECT calories FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('cf_tester')
      AND product_id = (SELECT val::uuid FROM _test_state WHERE key = 'zeromacro_pid')
    ORDER BY created_at DESC LIMIT 1),
  0.000::numeric,
  'food_log calories = 0 for product with default zero macros'
);

-- ─────────────────────────────────────────────────────────────
-- Test 38: Negative quantity consumption raises exception
-- ─────────────────────────────────────────────────────────────

SELECT throws_ok(
  format($$
    SELECT chefbyte.consume_product(
      %L::uuid,
      -5, 'container', true, '2026-03-03'::date
    )
  $$, (SELECT val FROM _test_state WHERE key = 'chicken_pid')),
  'Quantity must be positive, got -5',
  'negative quantity consumption raises exception (qty must be positive)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 39: Consuming from product with zero stock still succeeds
-- (stock floors at 0, macros still logged for full amount)
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  format($$
    SELECT chefbyte.consume_product(
      %L::uuid,
      1, 'container', true, '2026-03-03'::date
    )
  $$, (SELECT val FROM _test_state WHERE key = 'chicken_pid')),
  'consuming from product with no stock lots succeeds (floors at 0)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 40: Invalid unit treated as container (not 'serving').
-- The function only checks for 'serving'; anything else is
-- treated as container. Verify it does not raise an error.
-- ─────────────────────────────────────────────────────────────

WITH ins AS (
  INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
  VALUES (
    tests.get_supabase_uid('cf_tester'),
    (SELECT val::uuid FROM _test_state WHERE key = 'chicken_pid'),
    (SELECT val::uuid FROM _test_state WHERE key = 'fridge_id'),
    2.0,
    '2026-06-01'
  ) RETURNING lot_id
)
INSERT INTO _test_state SELECT 'lot_unknown_unit', lot_id::text FROM ins;

SELECT lives_ok(
  format($$
    SELECT chefbyte.consume_product(
      %L::uuid,
      1, 'box', true, '2026-03-03'::date
    )
  $$, (SELECT val FROM _test_state WHERE key = 'chicken_pid')),
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
