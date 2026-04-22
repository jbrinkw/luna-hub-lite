BEGIN;
SELECT plan(30);

-- Coverage for chefbyte.export_chefbyte_backup / chefbyte.restore_chefbyte_backup:
--   1. Export shape — schema_version + tables keys + per-table array
--   2. Export content — row counts per table match seeded data
--   3. Restore roundtrip — export → wipe a subset → restore recovers state
--   4. Wipe semantics — seed 5 products, restore backup with 3, final count = 3
--   5. Cross-user reject — User B's backup uploaded by User A throws
--   6. schema_version mismatch — tampered version throws and wipes nothing
--   7. Mismatched row.user_id inside payload — throws and wipes nothing
--   8. Empty backup (schema_version + user_id + tables.* = []) wipes cleanly
--   9. PK preservation — FK references (stock_lots → products) stay valid
--  10. FK ordering — recipes inserted before recipe_ingredients, etc.

-- ─────────────────────────────────────────────────────────────
-- Setup — two users, both on chefbyte
-- ─────────────────────────────────────────────────────────────

SELECT tests.create_supabase_user('backup_owner');
SELECT tests.create_supabase_user('backup_intruder');

SELECT tests.authenticate_as('backup_owner');
SELECT hub.activate_app('chefbyte');
SELECT tests.authenticate_as('backup_intruder');
SELECT hub.activate_app('chefbyte');

SELECT tests.get_supabase_uid('backup_owner')    AS _owner_uid    \gset
SELECT tests.get_supabase_uid('backup_intruder') AS _intruder_uid \gset

-- Pull the default Fridge location for owner (created by activate_app).
SELECT tests.authenticate_as('backup_owner');
SELECT location_id AS owner_fridge_id
  FROM chefbyte.locations
 WHERE user_id = :'_owner_uid'::uuid AND name = 'Fridge' \gset

-- Seed: 3 products, 2 stock lots, 1 recipe with 2 ingredients, 1 meal plan
-- entry, 1 food log, 1 temp item, 1 shopping row, 1 user_config entry.
INSERT INTO chefbyte.products (product_id, user_id, name,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving)
VALUES
  ('90000000-0000-0000-0000-000000000001', :'_owner_uid'::uuid, 'Prod A', 100, 10, 20, 5),
  ('90000000-0000-0000-0000-000000000002', :'_owner_uid'::uuid, 'Prod B', 200, 20, 10, 8),
  ('90000000-0000-0000-0000-000000000003', :'_owner_uid'::uuid, 'Prod C', 50,  5,  3,  1);

INSERT INTO chefbyte.stock_lots (lot_id, user_id, product_id, location_id, qty_containers, expires_on)
VALUES
  ('90000000-0000-0000-0000-0000000000a1', :'_owner_uid'::uuid,
   '90000000-0000-0000-0000-000000000001', :'owner_fridge_id', 5, '2026-12-31'),
  ('90000000-0000-0000-0000-0000000000a2', :'_owner_uid'::uuid,
   '90000000-0000-0000-0000-000000000002', :'owner_fridge_id', 2, NULL);

INSERT INTO chefbyte.recipes (recipe_id, user_id, name, base_servings)
VALUES ('90000000-0000-0000-0000-000000000aa1', :'_owner_uid'::uuid, 'Recipe A', 2);

INSERT INTO chefbyte.recipe_ingredients (ingredient_id, recipe_id, product_id, user_id, quantity, unit)
VALUES
  ('90000000-0000-0000-0000-000000000bb1',
   '90000000-0000-0000-0000-000000000aa1',
   '90000000-0000-0000-0000-000000000001',
   :'_owner_uid'::uuid, 1, 'container'),
  ('90000000-0000-0000-0000-000000000bb2',
   '90000000-0000-0000-0000-000000000aa1',
   '90000000-0000-0000-0000-000000000002',
   :'_owner_uid'::uuid, 0.5, 'container');

INSERT INTO chefbyte.meal_plan_entries
  (meal_id, user_id, recipe_id, logical_date, servings)
VALUES
  ('90000000-0000-0000-0000-000000000cc1',
   :'_owner_uid'::uuid,
   '90000000-0000-0000-0000-000000000aa1',
   '2026-04-23', 1);

INSERT INTO chefbyte.food_logs
  (log_id, user_id, product_id, logical_date, qty_consumed, unit,
   calories, carbs, protein, fat)
VALUES
  ('90000000-0000-0000-0000-000000000dd1',
   :'_owner_uid'::uuid,
   '90000000-0000-0000-0000-000000000001',
   '2026-04-23', 1, 'serving', 100, 10, 20, 5);

INSERT INTO chefbyte.temp_items
  (temp_id, user_id, name, logical_date, calories, carbs, protein, fat)
VALUES
  ('90000000-0000-0000-0000-000000000ee1',
   :'_owner_uid'::uuid, 'Pizza slice', '2026-04-23', 300, 35, 12, 14);

INSERT INTO chefbyte.shopping_list
  (cart_item_id, user_id, product_id, qty_containers)
VALUES
  ('90000000-0000-0000-0000-000000000ff1',
   :'_owner_uid'::uuid,
   '90000000-0000-0000-0000-000000000003', 2);

INSERT INTO chefbyte.user_config (config_id, user_id, key, value)
VALUES
  ('90000000-0000-0000-0000-00000000abc1',
   :'_owner_uid'::uuid, 'goal_calories', '2200');

-- ─────────────────────────────────────────────────────────────
-- Test 1–4: Export shape & content
-- ─────────────────────────────────────────────────────────────

SELECT is(
  chefbyte.export_chefbyte_backup()->>'schema_version',
  '20260423010000',
  'export: schema_version matches expected'
);

SELECT is(
  (chefbyte.export_chefbyte_backup()->>'user_id')::uuid,
  :'_owner_uid'::uuid,
  'export: user_id matches caller'
);

SELECT is(
  jsonb_typeof(chefbyte.export_chefbyte_backup()->'tables'),
  'object',
  'export: tables is a JSON object'
);

SELECT is(
  jsonb_array_length(chefbyte.export_chefbyte_backup()->'tables'->'products'),
  3,
  'export: 3 products captured'
);

SELECT is(
  jsonb_array_length(chefbyte.export_chefbyte_backup()->'tables'->'stock_lots'),
  2,
  'export: 2 stock lots captured'
);

SELECT is(
  jsonb_array_length(chefbyte.export_chefbyte_backup()->'tables'->'recipes'),
  1,
  'export: 1 recipe captured'
);

SELECT is(
  jsonb_array_length(chefbyte.export_chefbyte_backup()->'tables'->'recipe_ingredients'),
  2,
  'export: 2 recipe ingredients captured'
);

SELECT is(
  jsonb_array_length(chefbyte.export_chefbyte_backup()->'tables'->'meal_plan_entries'),
  1,
  'export: 1 meal plan entry captured'
);

SELECT is(
  jsonb_array_length(chefbyte.export_chefbyte_backup()->'tables'->'food_logs'),
  1,
  'export: 1 food log captured'
);

SELECT is(
  jsonb_array_length(chefbyte.export_chefbyte_backup()->'tables'->'temp_items'),
  1,
  'export: 1 temp item captured'
);

SELECT is(
  jsonb_array_length(chefbyte.export_chefbyte_backup()->'tables'->'shopping_list'),
  1,
  'export: 1 shopping row captured'
);

SELECT is(
  jsonb_array_length(chefbyte.export_chefbyte_backup()->'tables'->'user_config'),
  1,
  'export: 1 user_config row captured'
);

-- ─────────────────────────────────────────────────────────────
-- Test 13–15: Restore roundtrip — snapshot, delete some rows, restore,
-- assert state returns to snapshot.
-- ─────────────────────────────────────────────────────────────

-- Snapshot current state.
CREATE TEMP TABLE _snapshot AS
  SELECT chefbyte.export_chefbyte_backup() AS payload;

-- Delete 1 product (cascades to stock_lot, recipe_ingredient, food_log).
DELETE FROM chefbyte.products WHERE product_id = '90000000-0000-0000-0000-000000000001';
-- Delete the temp item.
DELETE FROM chefbyte.temp_items WHERE temp_id = '90000000-0000-0000-0000-000000000ee1';

-- Verify the delete actually happened so the restore test means something.
SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.products WHERE user_id = :'_owner_uid'::uuid),
  2,
  'pre-restore: only 2 products remain after delete'
);

-- Restore.
SELECT lives_ok(
  $$ SELECT chefbyte.restore_chefbyte_backup((SELECT payload FROM _snapshot)) $$,
  'restore: roundtrip succeeds'
);

-- Post-restore state should match the pre-delete state exactly.
SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.products WHERE user_id = :'_owner_uid'::uuid),
  3,
  'post-restore: products back to 3'
);

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.stock_lots WHERE user_id = :'_owner_uid'::uuid),
  2,
  'post-restore: stock_lots back to 2'
);

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.temp_items WHERE user_id = :'_owner_uid'::uuid),
  1,
  'post-restore: temp_items back to 1'
);

-- PK preservation: the exact same product_id survived.
SELECT ok(
  EXISTS(SELECT 1 FROM chefbyte.products
         WHERE product_id = '90000000-0000-0000-0000-000000000001'
           AND user_id = :'_owner_uid'::uuid),
  'post-restore: original product UUID preserved'
);

-- FK integrity: recipe_ingredient still references the recipe it used to.
SELECT is(
  (SELECT recipe_id FROM chefbyte.recipe_ingredients
    WHERE ingredient_id = '90000000-0000-0000-0000-000000000bb1'),
  '90000000-0000-0000-0000-000000000aa1'::uuid,
  'post-restore: recipe_ingredient → recipe FK preserved'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Wipe semantics — 5 existing products, restore backup with 3 → final = 3
-- ─────────────────────────────────────────────────────────────

-- Add 2 extra products that do NOT exist in the snapshot.
INSERT INTO chefbyte.products (product_id, user_id, name,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving)
VALUES
  ('90000000-0000-0000-0000-00000000000e', :'_owner_uid'::uuid, 'Extra 1', 10, 1, 1, 1),
  ('90000000-0000-0000-0000-00000000000f', :'_owner_uid'::uuid, 'Extra 2', 20, 2, 2, 2);

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.products WHERE user_id = :'_owner_uid'::uuid),
  5,
  'pre-restore: 5 products (3 original + 2 extra)'
);

SELECT lives_ok(
  $$ SELECT chefbyte.restore_chefbyte_backup((SELECT payload FROM _snapshot)) $$,
  'restore: wipe-and-restore succeeds against pre-existing rows'
);

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.products WHERE user_id = :'_owner_uid'::uuid),
  3,
  'post-restore: products back to 3 (extras wiped)'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Cross-user reject
-- ─────────────────────────────────────────────────────────────

-- Intruder tries to restore Owner's backup.
SELECT tests.authenticate_as('backup_intruder');

SELECT throws_ok(
  $$ SELECT chefbyte.restore_chefbyte_backup((SELECT payload FROM _snapshot)) $$,
  NULL,
  'backup belongs to a different user — cannot restore',
  'cross-user: restore rejected when user_id in payload differs from auth.uid()'
);

-- Intruder's ChefByte data is NOT polluted by a failed restore.
SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.products WHERE user_id = :'_intruder_uid'::uuid),
  0,
  'cross-user: intruder still has zero products after rejected restore'
);

-- ─────────────────────────────────────────────────────────────
-- Test: schema_version mismatch
-- ─────────────────────────────────────────────────────────────

SELECT tests.authenticate_as('backup_owner');

-- Pre-tamper row count to assert wipe DID NOT happen on the failed restore.
CREATE TEMP TABLE _pre_mismatch AS
  SELECT COUNT(*) AS n FROM chefbyte.products WHERE user_id = (select auth.uid());

SELECT throws_ok(
  $$ SELECT chefbyte.restore_chefbyte_backup(
       (SELECT jsonb_set(payload, '{schema_version}', '"99999999999999"') FROM _snapshot)
     ) $$,
  NULL,
  'schema_version mismatch: backup=99999999999999 expected=20260423010000',
  'version: restore rejected on schema_version mismatch'
);

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.products WHERE user_id = :'_owner_uid'::uuid),
  (SELECT n::int FROM _pre_mismatch),
  'version: products unchanged after rejected mismatch restore'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Per-row user_id guard — aborts before wipe if ANY row has wrong user_id
-- ─────────────────────────────────────────────────────────────

-- Craft a payload whose top-level user_id is the owner but one product row
-- carries the intruder's UUID. Must throw + leave existing state intact.
SELECT throws_ok(
  format($sql$
    SELECT chefbyte.restore_chefbyte_backup(
      jsonb_set(
        (SELECT payload FROM _snapshot),
        '{tables,products,0,user_id}',
        to_jsonb(%L::uuid)
      )
    )
  $sql$, :'_intruder_uid'::text),
  NULL,
  'backup.tables.products contains 1 row(s) with a foreign user_id',
  'row-guard: mixed-user payload rejected'
);

-- State unchanged (the owner still has 3 products).
SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.products WHERE user_id = :'_owner_uid'::uuid),
  3,
  'row-guard: products unchanged after rejected mixed-user restore'
);

-- ─────────────────────────────────────────────────────────────
-- Test: Empty backup (no rows under any table key)
-- ─────────────────────────────────────────────────────────────

-- Build a minimal valid payload with all table arrays empty.
SELECT lives_ok(
  format($sql$
    SELECT chefbyte.restore_chefbyte_backup(jsonb_build_object(
      'schema_version', '20260423010000',
      'generated_at',   to_jsonb(now()),
      'user_id',        to_jsonb(%L::uuid),
      'tables', jsonb_build_object(
        'locations', '[]'::jsonb,
        'products', '[]'::jsonb,
        'stock_lots', '[]'::jsonb,
        'recipes', '[]'::jsonb,
        'recipe_ingredients', '[]'::jsonb,
        'meal_plan_entries', '[]'::jsonb,
        'food_logs', '[]'::jsonb,
        'temp_items', '[]'::jsonb,
        'shopping_list', '[]'::jsonb,
        'user_config', '[]'::jsonb
      )
    ))
  $sql$, :'_owner_uid'::text),
  'empty: restore with all-empty arrays succeeds'
);

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.products WHERE user_id = :'_owner_uid'::uuid),
  0,
  'empty: user has no products after empty-backup restore (full wipe)'
);

SELECT * FROM finish();
ROLLBACK;
