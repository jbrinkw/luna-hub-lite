-- ════════════════════════════════════════════════════════════════════════════
-- RLS Audit — Gap-closer tests (2026-04-22)
-- ════════════════════════════════════════════════════════════════════════════
-- Audit-wide sweep verifying every user-scoped table in hub/chefbyte/coachbyte
-- enforces the expected 4-operation isolation contract:
--   1. User A cannot SELECT User B's rows
--   2. User A cannot INSERT a row with user_id = B
--   3. User A cannot UPDATE User B's rows
--   4. User A cannot DELETE User B's rows
--
-- Existing per-table tests already cover most tables end-to-end. This file
-- closes gaps where a specific operation was not explicitly probed cross-user:
--   * hub.app_activations — no direct DML cross-user attempts (only function paths tested)
--   * coachbyte.daily_plans — missing cross-user DELETE
--   * coachbyte.planned_sets — missing cross-user DELETE
--   * chefbyte.recipes — missing cross-user DELETE
--   * chefbyte.recipe_ingredients — missing cross-user UPDATE + DELETE
--
-- Total new assertions: 4 ops × 5 tables = 20 assertions.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(20);

-- Setup: two users, each with both apps activated
SELECT tests.create_supabase_user('rls_audit_a');
SELECT tests.create_supabase_user('rls_audit_b');

SELECT tests.authenticate_as('rls_audit_a');
SELECT hub.activate_app('coachbyte');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('rls_audit_b');
SELECT hub.activate_app('coachbyte');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();

SELECT tests.get_supabase_uid('rls_audit_a') AS _a_uid \gset
SELECT tests.get_supabase_uid('rls_audit_b') AS _b_uid \gset

-- ════════════════════════════════════════════════════════════════════════════
-- 1. hub.app_activations
-- ════════════════════════════════════════════════════════════════════════════
-- Policies: SELECT/INSERT/DELETE only (no UPDATE policy exists — verified below).
-- Everything goes through hub.activate_app / hub.deactivate_app wrappers in
-- production, but direct DML must also respect RLS.

-- User A already has 'coachbyte' and 'chefbyte' activations from setup.
-- User B tries to SELECT them — must return 0.
SELECT tests.authenticate_as('rls_audit_b');

SELECT is(
  (SELECT count(*)::integer FROM hub.app_activations
    WHERE user_id = :'_a_uid'::uuid),
  0,
  'hub.app_activations: User B cannot SELECT User A activations'
);

-- User B attempts INSERT with User A's user_id — WITH CHECK violation.
SELECT throws_ok(
  format(
    'INSERT INTO hub.app_activations (user_id, app_name) VALUES (%L, ''spoofed_app'')',
    :'_a_uid'
  ),
  '42501',
  NULL,
  'hub.app_activations: User B cannot INSERT with User A user_id (RLS WITH CHECK)'
);

-- User B attempts UPDATE against User A's row — no UPDATE policy exists, so
-- RLS silently filters all rows. Verify User A's row is unchanged after
-- B's attack. (There's nothing meaningful to mutate on app_activations, but
-- the activated_at column is the only mutable surface.)
UPDATE hub.app_activations SET activated_at = '1999-01-01'::timestamptz
  WHERE user_id = :'_a_uid'::uuid;
SELECT tests.authenticate_as('rls_audit_a');
SELECT ok(
  (SELECT activated_at > '2000-01-01'::timestamptz
     FROM hub.app_activations
     WHERE user_id = :'_a_uid'::uuid AND app_name = 'coachbyte'),
  'hub.app_activations: User B cannot UPDATE User A rows (no UPDATE policy)'
);

-- User B attempts DELETE — RLS filters, 0 rows affected.
SELECT tests.authenticate_as('rls_audit_b');
DELETE FROM hub.app_activations
  WHERE user_id = :'_a_uid'::uuid AND app_name = 'coachbyte';
SELECT tests.authenticate_as('rls_audit_a');
SELECT ok(
  EXISTS (SELECT 1 FROM hub.app_activations
    WHERE user_id = :'_a_uid'::uuid AND app_name = 'coachbyte'),
  'hub.app_activations: User B cannot DELETE User A rows'
);

-- ════════════════════════════════════════════════════════════════════════════
-- 2. coachbyte.daily_plans
-- ════════════════════════════════════════════════════════════════════════════
-- Other ops covered by rls_tables.test.sql; DELETE cross-user was missing.

SELECT tests.authenticate_as('rls_audit_a');

INSERT INTO coachbyte.daily_plans (plan_id, user_id, plan_date, logical_date, summary)
VALUES (
  '11111111-1111-1111-1111-000000000001',
  :'_a_uid'::uuid,
  '2026-04-22', '2026-04-22', 'Audit plan'
);

-- User B SELECT cross-user
SELECT tests.authenticate_as('rls_audit_b');
SELECT is(
  (SELECT count(*)::integer FROM coachbyte.daily_plans
    WHERE plan_id = '11111111-1111-1111-1111-000000000001'),
  0,
  'coachbyte.daily_plans: User B cannot SELECT User A rows'
);

-- User B INSERT with User A's user_id — RLS WITH CHECK violation
SELECT throws_ok(
  format(
    'INSERT INTO coachbyte.daily_plans (plan_id, user_id, plan_date)
     VALUES (''11111111-1111-1111-1111-0000000000ff'', %L, ''2026-04-23'')',
    :'_a_uid'
  ),
  '42501',
  NULL,
  'coachbyte.daily_plans: User B cannot INSERT with User A user_id'
);

-- User B UPDATE cross-user — RLS filters, 0 rows affected
UPDATE coachbyte.daily_plans SET summary = 'Hacked'
  WHERE plan_id = '11111111-1111-1111-1111-000000000001';
SELECT tests.authenticate_as('rls_audit_a');
SELECT is(
  (SELECT summary FROM coachbyte.daily_plans
    WHERE plan_id = '11111111-1111-1111-1111-000000000001'),
  'Audit plan',
  'coachbyte.daily_plans: User B cannot UPDATE User A rows'
);

-- User B DELETE cross-user — RLS filters, 0 rows affected (gap filler)
SELECT tests.authenticate_as('rls_audit_b');
DELETE FROM coachbyte.daily_plans
  WHERE plan_id = '11111111-1111-1111-1111-000000000001';
SELECT tests.authenticate_as('rls_audit_a');
SELECT ok(
  EXISTS (SELECT 1 FROM coachbyte.daily_plans
    WHERE plan_id = '11111111-1111-1111-1111-000000000001'),
  'coachbyte.daily_plans: User B cannot DELETE User A rows'
);

-- ════════════════════════════════════════════════════════════════════════════
-- 3. coachbyte.planned_sets
-- ════════════════════════════════════════════════════════════════════════════
-- Other ops covered by rls_tables.test.sql; DELETE cross-user was missing.

SELECT exercise_id AS squat_id FROM coachbyte.exercises
  WHERE user_id IS NULL AND name = 'Squat' LIMIT 1 \gset

INSERT INTO coachbyte.planned_sets
  (planned_set_id, plan_id, user_id, exercise_id, "order", target_reps, target_load, rest_seconds)
VALUES (
  '11111111-1111-1111-1111-000000000002',
  '11111111-1111-1111-1111-000000000001',
  :'_a_uid'::uuid,
  :'squat_id', 1, 5, 135, 90
);

SELECT tests.authenticate_as('rls_audit_b');

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.planned_sets
    WHERE planned_set_id = '11111111-1111-1111-1111-000000000002'),
  0,
  'coachbyte.planned_sets: User B cannot SELECT User A rows'
);

SELECT throws_ok(
  format(
    'INSERT INTO coachbyte.planned_sets (planned_set_id, plan_id, user_id, exercise_id, "order")
     VALUES (''11111111-1111-1111-1111-0000000002ff'', ''11111111-1111-1111-1111-000000000001'', %L, %L, 2)',
    :'_a_uid', :'squat_id'
  ),
  '42501',
  NULL,
  'coachbyte.planned_sets: User B cannot INSERT with User A user_id'
);

UPDATE coachbyte.planned_sets SET target_reps = 99
  WHERE planned_set_id = '11111111-1111-1111-1111-000000000002';
SELECT tests.authenticate_as('rls_audit_a');
SELECT is(
  (SELECT target_reps FROM coachbyte.planned_sets
    WHERE planned_set_id = '11111111-1111-1111-1111-000000000002'),
  5,
  'coachbyte.planned_sets: User B cannot UPDATE User A rows'
);

-- DELETE cross-user (gap filler)
SELECT tests.authenticate_as('rls_audit_b');
DELETE FROM coachbyte.planned_sets
  WHERE planned_set_id = '11111111-1111-1111-1111-000000000002';
SELECT tests.authenticate_as('rls_audit_a');
SELECT ok(
  EXISTS (SELECT 1 FROM coachbyte.planned_sets
    WHERE planned_set_id = '11111111-1111-1111-1111-000000000002'),
  'coachbyte.planned_sets: User B cannot DELETE User A rows'
);

-- ════════════════════════════════════════════════════════════════════════════
-- 4. chefbyte.recipes
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT + UPDATE cross-user covered by rls_core.test.sql; DELETE missing.

INSERT INTO chefbyte.recipes (recipe_id, user_id, name, base_servings)
VALUES (
  '11111111-1111-1111-1111-000000000003',
  :'_a_uid'::uuid,
  'Audit Recipe', 4
);

SELECT tests.authenticate_as('rls_audit_b');

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.recipes
    WHERE recipe_id = '11111111-1111-1111-1111-000000000003'),
  0,
  'chefbyte.recipes: User B cannot SELECT User A rows'
);

SELECT throws_ok(
  format(
    'INSERT INTO chefbyte.recipes (recipe_id, user_id, name)
     VALUES (''11111111-1111-1111-1111-0000000003ff'', %L, ''Spoofed Recipe'')',
    :'_a_uid'
  ),
  '42501',
  NULL,
  'chefbyte.recipes: User B cannot INSERT with User A user_id'
);

UPDATE chefbyte.recipes SET name = 'Hacked Recipe'
  WHERE recipe_id = '11111111-1111-1111-1111-000000000003';
SELECT tests.authenticate_as('rls_audit_a');
SELECT is(
  (SELECT name FROM chefbyte.recipes
    WHERE recipe_id = '11111111-1111-1111-1111-000000000003'),
  'Audit Recipe',
  'chefbyte.recipes: User B cannot UPDATE User A rows'
);

-- DELETE cross-user (gap filler)
SELECT tests.authenticate_as('rls_audit_b');
DELETE FROM chefbyte.recipes
  WHERE recipe_id = '11111111-1111-1111-1111-000000000003';
SELECT tests.authenticate_as('rls_audit_a');
SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.recipes
    WHERE recipe_id = '11111111-1111-1111-1111-000000000003'),
  'chefbyte.recipes: User B cannot DELETE User A rows'
);

-- ════════════════════════════════════════════════════════════════════════════
-- 5. chefbyte.recipe_ingredients
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT covered by rls_core.test.sql; INSERT (via row in rls_core already
-- happens implicitly), UPDATE + DELETE cross-user were missing.

-- Need a product for the ingredient FK
INSERT INTO chefbyte.products
  (product_id, user_id, name, servings_per_container,
   calories_per_serving, protein_per_serving, fat_per_serving, carbs_per_serving)
VALUES (
  '11111111-1111-1111-1111-000000000004',
  :'_a_uid'::uuid,
  'Audit Ingredient Product', 1, 100, 10, 5, 20
);

INSERT INTO chefbyte.recipe_ingredients
  (ingredient_id, user_id, recipe_id, product_id, quantity, unit, note)
VALUES (
  '11111111-1111-1111-1111-000000000005',
  :'_a_uid'::uuid,
  '11111111-1111-1111-1111-000000000003',
  '11111111-1111-1111-1111-000000000004',
  2, 'container', 'Original note'
);

SELECT tests.authenticate_as('rls_audit_b');

SELECT is(
  (SELECT count(*)::integer FROM chefbyte.recipe_ingredients
    WHERE ingredient_id = '11111111-1111-1111-1111-000000000005'),
  0,
  'chefbyte.recipe_ingredients: User B cannot SELECT User A rows'
);

SELECT throws_ok(
  format(
    'INSERT INTO chefbyte.recipe_ingredients
       (ingredient_id, user_id, recipe_id, product_id, quantity, unit)
     VALUES (''11111111-1111-1111-1111-0000000005ff'', %L,
             ''11111111-1111-1111-1111-000000000003'',
             ''11111111-1111-1111-1111-000000000004'',
             1, ''serving'')',
    :'_a_uid'
  ),
  '42501',
  NULL,
  'chefbyte.recipe_ingredients: User B cannot INSERT with User A user_id'
);

-- UPDATE cross-user (gap filler)
UPDATE chefbyte.recipe_ingredients SET note = 'Hacked note', quantity = 99
  WHERE ingredient_id = '11111111-1111-1111-1111-000000000005';
SELECT tests.authenticate_as('rls_audit_a');
SELECT is(
  (SELECT note FROM chefbyte.recipe_ingredients
    WHERE ingredient_id = '11111111-1111-1111-1111-000000000005'),
  'Original note',
  'chefbyte.recipe_ingredients: User B cannot UPDATE User A rows'
);

-- DELETE cross-user (gap filler)
SELECT tests.authenticate_as('rls_audit_b');
DELETE FROM chefbyte.recipe_ingredients
  WHERE ingredient_id = '11111111-1111-1111-1111-000000000005';
SELECT tests.authenticate_as('rls_audit_a');
SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.recipe_ingredients
    WHERE ingredient_id = '11111111-1111-1111-1111-000000000005'),
  'chefbyte.recipe_ingredients: User B cannot DELETE User A rows'
);

-- ════════════════════════════════════════════════════════════════════════════
-- Teardown
-- ════════════════════════════════════════════════════════════════════════════
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('rls_audit_a');
SELECT tests.delete_supabase_user('rls_audit_b');

SELECT * FROM finish();
ROLLBACK;
