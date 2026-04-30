-- pgTAP — chefbyte.products.visual_unit_label + visual_units_per_serving
--
-- Asserts the products_visual_pair_complete CHECK constraint added in
-- migration 20260430040000_products_visual_unit.sql:
--   1. Both columns NULL                             → succeeds
--   2. Both columns set with units > 0               → succeeds
--   3. Only label set (units NULL)                   → check_violation (23514)
--   4. Only units set (label NULL)                   → check_violation (23514)
--   5. units = 0 (label set)                         → check_violation (23514)
--   6. units < 0 (label set)                         → check_violation (23514)
--   7. UPDATE that flips an existing pair into the    → check_violation (23514)
--      partial state is rejected too (constraint
--      runs on UPDATE same as INSERT)

BEGIN;
SELECT plan(7);

-- ─────────────────────────────────────────────────────────────
-- Setup
-- ─────────────────────────────────────────────────────────────

SELECT tests.create_supabase_user('pvu_tester');
SELECT tests.authenticate_as('pvu_tester');
SELECT hub.activate_app('chefbyte');

CREATE TEMP TABLE _pvu_state (
  key TEXT PRIMARY KEY,
  val TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────
-- Test 1: Both visual columns NULL → succeeds (default state)
-- ─────────────────────────────────────────────────────────────

WITH ins AS (
  INSERT INTO chefbyte.products (
    user_id, name, servings_per_container,
    calories_per_serving, protein_per_serving, fat_per_serving, carbs_per_serving
  ) VALUES (
    tests.get_supabase_uid('pvu_tester'),
    'Bulk Item',
    1, 100, 5, 8, 1
  )
  RETURNING product_id
)
INSERT INTO _pvu_state SELECT 'pid_null', product_id::text FROM ins;

SELECT ok(
  EXISTS (
    SELECT 1 FROM chefbyte.products
    WHERE product_id = (SELECT val::uuid FROM _pvu_state WHERE key = 'pid_null')
      AND visual_unit_label IS NULL
      AND visual_units_per_serving IS NULL
  ),
  'INSERT with both visual columns NULL succeeds (default state)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 2: Both columns set with units > 0 → succeeds
-- ─────────────────────────────────────────────────────────────

SELECT lives_ok(
  format($$
    INSERT INTO chefbyte.products (
      user_id, name, servings_per_container,
      calories_per_serving, protein_per_serving, fat_per_serving, carbs_per_serving,
      visual_unit_label, visual_units_per_serving
    ) VALUES (
      %L::uuid,
      'Eggs',
      12, 70, 6, 5, 0,
      'egg', 1
    )
  $$, tests.get_supabase_uid('pvu_tester')::text),
  'INSERT with both visual columns set (units > 0) succeeds'
);

-- ─────────────────────────────────────────────────────────────
-- Test 3: Only label set → check_violation (23514)
-- ─────────────────────────────────────────────────────────────

SELECT throws_matching(
  format($$
    INSERT INTO chefbyte.products (
      user_id, name, servings_per_container,
      calories_per_serving, protein_per_serving, fat_per_serving, carbs_per_serving,
      visual_unit_label, visual_units_per_serving
    ) VALUES (
      %L::uuid,
      'Half-Pair Label',
      1, 100, 5, 8, 1,
      'slice', NULL
    )
  $$, tests.get_supabase_uid('pvu_tester')::text),
  'check',
  'INSERT with only visual_unit_label raises check_violation'
);

-- ─────────────────────────────────────────────────────────────
-- Test 4: Only units set → check_violation (23514)
-- ─────────────────────────────────────────────────────────────

SELECT throws_matching(
  format($$
    INSERT INTO chefbyte.products (
      user_id, name, servings_per_container,
      calories_per_serving, protein_per_serving, fat_per_serving, carbs_per_serving,
      visual_unit_label, visual_units_per_serving
    ) VALUES (
      %L::uuid,
      'Half-Pair Units',
      1, 100, 5, 8, 1,
      NULL, 2.5
    )
  $$, tests.get_supabase_uid('pvu_tester')::text),
  'check',
  'INSERT with only visual_units_per_serving raises check_violation'
);

-- ─────────────────────────────────────────────────────────────
-- Test 5: units = 0 (label set) → check_violation (23514)
-- ─────────────────────────────────────────────────────────────

SELECT throws_matching(
  format($$
    INSERT INTO chefbyte.products (
      user_id, name, servings_per_container,
      calories_per_serving, protein_per_serving, fat_per_serving, carbs_per_serving,
      visual_unit_label, visual_units_per_serving
    ) VALUES (
      %L::uuid,
      'Zero Units',
      1, 100, 5, 8, 1,
      'slice', 0
    )
  $$, tests.get_supabase_uid('pvu_tester')::text),
  'check',
  'INSERT with visual_units_per_serving = 0 raises check_violation'
);

-- ─────────────────────────────────────────────────────────────
-- Test 6: units < 0 → check_violation (23514)
-- ─────────────────────────────────────────────────────────────

SELECT throws_matching(
  format($$
    INSERT INTO chefbyte.products (
      user_id, name, servings_per_container,
      calories_per_serving, protein_per_serving, fat_per_serving, carbs_per_serving,
      visual_unit_label, visual_units_per_serving
    ) VALUES (
      %L::uuid,
      'Negative Units',
      1, 100, 5, 8, 1,
      'slice', -1
    )
  $$, tests.get_supabase_uid('pvu_tester')::text),
  'check',
  'INSERT with visual_units_per_serving < 0 raises check_violation'
);

-- ─────────────────────────────────────────────────────────────
-- Test 7: UPDATE that flips a complete pair into a partial pair
--   is rejected (constraint enforced on UPDATE same as INSERT).
-- ─────────────────────────────────────────────────────────────

-- Insert a row with a complete pair, then attempt to NULL one half.
WITH ins AS (
  INSERT INTO chefbyte.products (
    user_id, name, servings_per_container,
    calories_per_serving, protein_per_serving, fat_per_serving, carbs_per_serving,
    visual_unit_label, visual_units_per_serving
  ) VALUES (
    tests.get_supabase_uid('pvu_tester'),
    'Update Source',
    1, 100, 5, 8, 1,
    'scoop', 2
  )
  RETURNING product_id
)
INSERT INTO _pvu_state SELECT 'pid_update', product_id::text FROM ins;

SELECT throws_matching(
  format($$
    UPDATE chefbyte.products
       SET visual_units_per_serving = NULL
     WHERE product_id = %L::uuid
  $$, (SELECT val FROM _pvu_state WHERE key = 'pid_update')),
  'check',
  'UPDATE that nulls only one half of the pair raises check_violation'
);

SELECT finish();
ROLLBACK;
