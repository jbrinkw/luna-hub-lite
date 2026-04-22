BEGIN;
SELECT plan(10);

-- ─────────────────────────────────────────────────────────────
-- chefbyte.recipe_changed_since(recipe_id, ts)
-- Groundwork helper for future "recipe edited since" features.
-- The stale-macros problem does NOT exist in current
-- architecture (macros computed on read), so this test only
-- covers the helper's contract.
-- ─────────────────────────────────────────────────────────────

SELECT tests.create_supabase_user('recipe_changed_owner');
SELECT tests.create_supabase_user('recipe_changed_other');
SELECT tests.authenticate_as('recipe_changed_owner');
SELECT hub.activate_app('chefbyte');

-- Product to reference in ingredients
INSERT INTO chefbyte.products (product_id, user_id, name,
  servings_per_container, calories_per_serving, protein_per_serving,
  fat_per_serving, carbs_per_serving)
VALUES (
  '50000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('recipe_changed_owner'),
  'Test Product', 1, 100, 10, 5, 10
);

-- Recipe created at a known timestamp
INSERT INTO chefbyte.recipes (recipe_id, user_id, name, base_servings, created_at)
VALUES (
  '60000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('recipe_changed_owner'),
  'Test Recipe', 1,
  '2026-01-01 00:00:00+00'
);

-- ─────────────────────────────────────────────────────────────
-- Contract tests
-- ─────────────────────────────────────────────────────────────

-- 1. NULL timestamp -> FALSE (no comparison basis)
SELECT is(
  chefbyte.recipe_changed_since('60000000-0000-0000-0000-000000000001', NULL),
  FALSE,
  'NULL timestamp returns FALSE'
);

-- 2. Timestamp BEFORE recipe creation -> TRUE (recipe is newer)
SELECT is(
  chefbyte.recipe_changed_since(
    '60000000-0000-0000-0000-000000000001',
    '2025-06-01 00:00:00+00'
  ),
  TRUE,
  'Recipe created after ts returns TRUE'
);

-- 3. Timestamp AFTER recipe creation, no ingredients -> FALSE
SELECT is(
  chefbyte.recipe_changed_since(
    '60000000-0000-0000-0000-000000000001',
    '2026-02-01 00:00:00+00'
  ),
  FALSE,
  'Recipe older than ts with no ingredients returns FALSE'
);

-- Add an ingredient with an explicit past created_at
INSERT INTO chefbyte.recipe_ingredients (user_id, recipe_id, product_id, quantity, unit, created_at)
VALUES (
  tests.get_supabase_uid('recipe_changed_owner'),
  '60000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001',
  1, 'container',
  '2026-01-15 00:00:00+00'
);

-- 4. Timestamp AFTER the ingredient too -> FALSE (nothing has changed since)
SELECT is(
  chefbyte.recipe_changed_since(
    '60000000-0000-0000-0000-000000000001',
    '2026-02-01 00:00:00+00'
  ),
  FALSE,
  'Recipe + ingredients both older than ts returns FALSE'
);

-- 5. Timestamp BETWEEN recipe and ingredient -> TRUE (ingredient is newer)
SELECT is(
  chefbyte.recipe_changed_since(
    '60000000-0000-0000-0000-000000000001',
    '2026-01-10 00:00:00+00'
  ),
  TRUE,
  'Ingredient newer than ts returns TRUE'
);

-- Simulate a recipe edit: DELETE+INSERT the ingredient (matches
-- private.save_recipe_ingredients behavior) at a newer timestamp
DELETE FROM chefbyte.recipe_ingredients
WHERE recipe_id = '60000000-0000-0000-0000-000000000001';

INSERT INTO chefbyte.recipe_ingredients (user_id, recipe_id, product_id, quantity, unit, created_at)
VALUES (
  tests.get_supabase_uid('recipe_changed_owner'),
  '60000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001',
  2, 'container',
  '2026-03-01 00:00:00+00'
);

-- 6. ts = 2026-02-01 (the "old check" time): new ingredient is newer -> TRUE
SELECT is(
  chefbyte.recipe_changed_since(
    '60000000-0000-0000-0000-000000000001',
    '2026-02-01 00:00:00+00'
  ),
  TRUE,
  'Replaced ingredient (DELETE+INSERT) is detected as a change'
);

-- 7. ts = 2026-04-01 (after the edit): no changes since -> FALSE
SELECT is(
  chefbyte.recipe_changed_since(
    '60000000-0000-0000-0000-000000000001',
    '2026-04-01 00:00:00+00'
  ),
  FALSE,
  'After edit, ts past the edit returns FALSE again'
);

-- 8. Non-existent recipe -> FALSE (no information leak)
SELECT is(
  chefbyte.recipe_changed_since(
    '00000000-0000-0000-0000-000000000000',
    '2020-01-01 00:00:00+00'
  ),
  FALSE,
  'Non-existent recipe returns FALSE (no info leak)'
);

-- 9. Another user owns a recipe — current caller must get FALSE.
-- Switch to the other user to insert their own recipe (RLS-compliant),
-- then switch back to recipe_changed_owner for the foreign-recipe assertion.
SELECT tests.authenticate_as('recipe_changed_other');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.recipes (recipe_id, user_id, name, base_servings, created_at)
VALUES (
  '60000000-0000-0000-0000-000000000002',
  tests.get_supabase_uid('recipe_changed_other'),
  'Other User Recipe', 1,
  '2026-01-01 00:00:00+00'
);

-- Caller switches back to the owner — should NOT see other's recipe as theirs
SELECT tests.authenticate_as('recipe_changed_owner');
SELECT is(
  chefbyte.recipe_changed_since(
    '60000000-0000-0000-0000-000000000002',
    '2020-01-01 00:00:00+00'
  ),
  FALSE,
  'Foreign recipe returns FALSE even if it would otherwise be "changed"'
);

-- 10. The rightful owner of that recipe sees it as changed
SELECT tests.authenticate_as('recipe_changed_other');
SELECT is(
  chefbyte.recipe_changed_since(
    '60000000-0000-0000-0000-000000000002',
    '2020-01-01 00:00:00+00'
  ),
  TRUE,
  'Rightful owner sees their own recipe as changed since old ts'
);

SELECT * FROM finish();
ROLLBACK;
