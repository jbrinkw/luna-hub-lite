-- Spec-vs-implementation: last-write-wins concurrency
--
-- CLAUDE.md spec: "last-write-wins concurrency — no locking, acceptable for single-user MVP"
--
-- Verifies that when two concurrent UPDATEs race on the same stock_lots row,
-- the later write prevails and the earlier write is overwritten (no optimistic
-- lock exception, no error — just silent override).
--
-- Also verifies the food_logs.logical_date NOT NULL constraint (spec claim
-- from docs/apps/chefbyte.md: "logical_date stored at insert time").

BEGIN;

SELECT plan(10);

-- =========================================================================
-- Setup: create a user, activate chefbyte, get a product + location
-- =========================================================================

SELECT tests.create_supabase_user('lww_user', 'lww@test.com', '555-9001');
SELECT tests.authenticate_as('lww_user');
SELECT hub.activate_app('chefbyte');

SELECT tests.get_supabase_uid('lww_user') AS _uid \gset

-- Grab location
SELECT location_id AS _loc_id FROM chefbyte.locations
  WHERE user_id = :'_uid' AND name = 'Fridge' LIMIT 1 \gset

-- Create a product
INSERT INTO chefbyte.products (user_id, name, servings_per_container)
VALUES (:'_uid', 'LWW Test Product', 4);

SELECT product_id AS _prod_id FROM chefbyte.products
  WHERE user_id = :'_uid' AND name = 'LWW Test Product' LIMIT 1 \gset

-- Insert a stock lot with 5 containers
INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers)
VALUES (:'_uid', :'_prod_id', :'_loc_id', 5.000);

SELECT lot_id AS _lot_id FROM chefbyte.stock_lots
  WHERE user_id = :'_uid' AND product_id = :'_prod_id' LIMIT 1 \gset

-- =========================================================================
-- Test 1: Initial lot qty is 5
-- =========================================================================

SELECT is(
  (SELECT qty_containers::numeric FROM chefbyte.stock_lots WHERE lot_id = :'_lot_id'),
  5.000::numeric,
  'Initial stock lot qty_containers = 5.000'
);

-- =========================================================================
-- Test 2: First write sets qty to 3.000
-- =========================================================================

UPDATE chefbyte.stock_lots SET qty_containers = 3.000 WHERE lot_id = :'_lot_id';

SELECT is(
  (SELECT qty_containers::numeric FROM chefbyte.stock_lots WHERE lot_id = :'_lot_id'),
  3.000::numeric,
  'After first UPDATE: qty_containers = 3.000'
);

-- =========================================================================
-- Test 3: Second write (later) sets qty to 1.500 — wins over the first
-- =========================================================================

UPDATE chefbyte.stock_lots SET qty_containers = 1.500 WHERE lot_id = :'_lot_id';

SELECT is(
  (SELECT qty_containers::numeric FROM chefbyte.stock_lots WHERE lot_id = :'_lot_id'),
  1.500::numeric,
  'After second UPDATE: qty_containers = 1.500 (last write wins)'
);

-- =========================================================================
-- Test 4: Verify no error is raised on the competing update (no lock)
--   Simulate "concurrent" second write by updating without a version guard.
--   If the spec were "optimistic lock", this would need to check a version
--   column. Since spec says last-write-wins (no lock), the update is silent.
-- =========================================================================

SELECT lives_ok(
  format(
    'UPDATE chefbyte.stock_lots SET qty_containers = 2.000 WHERE lot_id = %L',
    :'_lot_id'
  ),
  'Competing UPDATE succeeds without lock error (last-write-wins)'
);

SELECT is(
  (SELECT qty_containers::numeric FROM chefbyte.stock_lots WHERE lot_id = :'_lot_id'),
  2.000::numeric,
  'Third UPDATE prevails: qty_containers = 2.000'
);

-- =========================================================================
-- Test 5: food_logs.logical_date NOT NULL (spec: "logical_date stored at insert time")
-- =========================================================================

-- Inserting a food_log without logical_date must fail
SELECT throws_ok(
  format(
    $sql$
      INSERT INTO chefbyte.food_logs
        (user_id, product_id, logical_date, qty_consumed, unit, calories, carbs, protein, fat)
      VALUES
        (%L, %L, NULL, 1.0, 'container', 200, 30, 10, 5)
    $sql$,
    :'_uid', :'_prod_id'
  ),
  '23502',  -- not_null_violation
  NULL,
  'food_logs: logical_date NOT NULL — INSERT with NULL logical_date rejected'
);

-- Inserting with a valid logical_date works
SELECT lives_ok(
  format(
    $sql$
      INSERT INTO chefbyte.food_logs
        (user_id, product_id, logical_date, qty_consumed, unit, calories, carbs, protein, fat)
      VALUES
        (%L, %L, CURRENT_DATE, 1.0, 'container', 200, 30, 10, 5)
    $sql$,
    :'_uid', :'_prod_id'
  ),
  'food_logs: INSERT with valid logical_date succeeds'
);

-- =========================================================================
-- Test 6: temp_items.logical_date NOT NULL (same spec claim)
-- =========================================================================

SELECT throws_ok(
  format(
    $sql$
      INSERT INTO chefbyte.temp_items
        (user_id, name, logical_date, calories, carbs, protein, fat)
      VALUES
        (%L, 'Coffee', NULL, 5, 0, 0, 0)
    $sql$,
    :'_uid'
  ),
  '23502',
  NULL,
  'temp_items: logical_date NOT NULL — INSERT with NULL logical_date rejected'
);

-- Inserting with a valid logical_date works
SELECT lives_ok(
  format(
    $sql$
      INSERT INTO chefbyte.temp_items
        (user_id, name, logical_date, calories, carbs, protein, fat)
      VALUES
        (%L, 'Coffee', CURRENT_DATE, 5, 0, 0, 0)
    $sql$,
    :'_uid'
  ),
  'temp_items: INSERT with valid logical_date succeeds'
);

-- =========================================================================
-- Test 7: stock_lots NUMERIC(10,3) stores 3-decimal precision
-- =========================================================================

UPDATE chefbyte.stock_lots SET qty_containers = 1.234 WHERE lot_id = :'_lot_id';

SELECT is(
  (SELECT qty_containers::numeric FROM chefbyte.stock_lots WHERE lot_id = :'_lot_id'),
  1.234::numeric,
  'stock_lots stores NUMERIC(10,3) — 3-decimal precision preserved at rest'
);

SELECT * FROM finish();
ROLLBACK;
