-- Feature X — Shopping list auto-clear on import
--
-- Verifies the full lifecycle of the chefbyte.import_shopping_to_inventory
-- RPC + the imported_at column:
--   1. Importing purchased rows stamps imported_at and creates stock_lots.
--   2. Re-running the import is idempotent — imported rows are filtered
--      out, no new lots are minted.
--   3. New purchased rows added after a first import still get processed
--      on the next call.

BEGIN;
SELECT plan(19);

-- ─────────────────────────────────────────────────────────────
-- Setup — user, products, activation (activate_app seeds the Fridge location)
-- ─────────────────────────────────────────────────────────────

SELECT tests.create_supabase_user('shop_imp');
SELECT tests.authenticate_as('shop_imp');
SELECT hub.activate_app('chefbyte');

-- Create three products we'll import through the shopping list.
INSERT INTO chefbyte.products (product_id, user_id, name, servings_per_container, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving)
VALUES
  ('30000000-0000-0000-0000-000000000001', tests.get_supabase_uid('shop_imp'), 'Almond Butter', 16, 98, 3.5, 3, 9),
  ('30000000-0000-0000-0000-000000000002', tests.get_supabase_uid('shop_imp'), 'Canned Tuna', 2, 80, 18, 0, 1),
  ('30000000-0000-0000-0000-000000000003', tests.get_supabase_uid('shop_imp'), 'Brown Rice', 8, 216, 5, 45, 1.8);

-- Seed three shopping rows, all purchased, none imported yet.
INSERT INTO chefbyte.shopping_list (cart_item_id, user_id, product_id, qty_containers, purchased)
VALUES
  ('40000000-0000-0000-0000-000000000001', tests.get_supabase_uid('shop_imp'),
   '30000000-0000-0000-0000-000000000001', 1, true),
  ('40000000-0000-0000-0000-000000000002', tests.get_supabase_uid('shop_imp'),
   '30000000-0000-0000-0000-000000000002', 3, true),
  ('40000000-0000-0000-0000-000000000003', tests.get_supabase_uid('shop_imp'),
   '30000000-0000-0000-0000-000000000003', 2, true);

-- Baseline: column exists and all three rows have NULL imported_at.
SELECT has_column('chefbyte'::name, 'shopping_list'::name, 'imported_at'::name,
  'shopping_list.imported_at column exists');

SELECT is(
  (SELECT count(*)::int FROM chefbyte.shopping_list
    WHERE user_id = tests.get_supabase_uid('shop_imp') AND imported_at IS NULL),
  3,
  'all 3 shopping rows start with imported_at = NULL'
);

SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('shop_imp')),
  0,
  'no stock lots exist before first import'
);

-- ─────────────────────────────────────────────────────────────
-- First import — all 3 purchased rows should get imported_at, 3 stock_lots
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  $$ SELECT chefbyte.import_shopping_to_inventory() $$,
  'first import RPC call succeeds'
);

SELECT is(
  (SELECT count(*)::int FROM chefbyte.shopping_list
    WHERE user_id = tests.get_supabase_uid('shop_imp') AND imported_at IS NOT NULL),
  3,
  'first import stamps imported_at on all 3 rows'
);

SELECT is(
  (SELECT count(*)::int FROM chefbyte.shopping_list
    WHERE user_id = tests.get_supabase_uid('shop_imp') AND imported_at IS NULL),
  0,
  'first import leaves 0 active (non-imported) rows'
);

SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('shop_imp')),
  3,
  'first import creates 3 stock lots (one per product)'
);

SELECT is(
  (SELECT qty_containers::numeric FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('shop_imp')
      AND product_id = '30000000-0000-0000-0000-000000000001'),
  1::numeric,
  'Almond Butter lot qty=1 (matches shopping qty)'
);

SELECT is(
  (SELECT qty_containers::numeric FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('shop_imp')
      AND product_id = '30000000-0000-0000-0000-000000000002'),
  3::numeric,
  'Canned Tuna lot qty=3'
);

SELECT is(
  (SELECT qty_containers::numeric FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('shop_imp')
      AND product_id = '30000000-0000-0000-0000-000000000003'),
  2::numeric,
  'Brown Rice lot qty=2'
);

-- Snapshot imported_at values so we can prove they DO NOT change on round 2.
CREATE TEMP TABLE t_round1_snapshot AS
SELECT cart_item_id, imported_at
FROM chefbyte.shopping_list
WHERE user_id = tests.get_supabase_uid('shop_imp');

-- ─────────────────────────────────────────────────────────────
-- Second import — idempotent: no new lots, no imported_at mutation
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  $$ SELECT chefbyte.import_shopping_to_inventory() $$,
  'second import RPC call succeeds (idempotent)'
);

SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('shop_imp')),
  3,
  'second import does NOT mint new stock lots'
);

SELECT is(
  (SELECT (r.lots_processed)::int FROM
    (SELECT (chefbyte.import_shopping_to_inventory() ->> 'lots_processed')::int AS lots_processed) r),
  0,
  'third import returns lots_processed=0 (nothing left to process)'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM chefbyte.shopping_list s
    JOIN t_round1_snapshot t USING (cart_item_id)
    WHERE s.user_id = tests.get_supabase_uid('shop_imp')
      AND s.imported_at <> t.imported_at
  ),
  'existing rows keep their original imported_at across re-imports'
);

-- ─────────────────────────────────────────────────────────────
-- Add 2 new purchased rows → next import processes only those 2
-- ─────────────────────────────────────────────────────────────

INSERT INTO chefbyte.products (product_id, user_id, name, servings_per_container, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving)
VALUES
  ('30000000-0000-0000-0000-000000000004', tests.get_supabase_uid('shop_imp'), 'Greek Yogurt', 4, 100, 17, 6, 0),
  ('30000000-0000-0000-0000-000000000005', tests.get_supabase_uid('shop_imp'), 'Frozen Berries', 3, 80, 1, 20, 0);

INSERT INTO chefbyte.shopping_list (cart_item_id, user_id, product_id, qty_containers, purchased)
VALUES
  ('40000000-0000-0000-0000-000000000004', tests.get_supabase_uid('shop_imp'),
   '30000000-0000-0000-0000-000000000004', 2, true),
  ('40000000-0000-0000-0000-000000000005', tests.get_supabase_uid('shop_imp'),
   '30000000-0000-0000-0000-000000000005', 1, true);

SELECT is(
  (SELECT count(*)::int FROM chefbyte.shopping_list
    WHERE user_id = tests.get_supabase_uid('shop_imp') AND imported_at IS NULL),
  2,
  '2 active rows pending next import'
);

SELECT is(
  (SELECT (r.lots_processed)::int FROM
    (SELECT (chefbyte.import_shopping_to_inventory() ->> 'lots_processed')::int AS lots_processed) r),
  2,
  'import returns lots_processed=2 for the 2 new rows'
);

SELECT is(
  (SELECT count(*)::int FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('shop_imp')),
  5,
  'stock_lots total is now 5 (3 initial + 2 new) — the new import only added 2'
);

SELECT is(
  (SELECT count(*)::int FROM chefbyte.shopping_list
    WHERE user_id = tests.get_supabase_uid('shop_imp') AND imported_at IS NULL),
  0,
  'no active rows remaining after second wave of imports'
);

-- ─────────────────────────────────────────────────────────────
-- Non-purchased rows are never imported
-- ─────────────────────────────────────────────────────────────

INSERT INTO chefbyte.products (product_id, user_id, name, servings_per_container, calories_per_serving)
VALUES
  ('30000000-0000-0000-0000-00000000000F', tests.get_supabase_uid('shop_imp'), 'Oats', 10, 150);

INSERT INTO chefbyte.shopping_list (cart_item_id, user_id, product_id, qty_containers, purchased)
VALUES
  ('40000000-0000-0000-0000-00000000000F', tests.get_supabase_uid('shop_imp'),
   '30000000-0000-0000-0000-00000000000F', 1, false);

SELECT chefbyte.import_shopping_to_inventory();

SELECT is(
  (SELECT imported_at FROM chefbyte.shopping_list
    WHERE cart_item_id = '40000000-0000-0000-0000-00000000000F'),
  NULL::timestamptz,
  'non-purchased rows are never stamped with imported_at'
);

SELECT * FROM finish();
ROLLBACK;
