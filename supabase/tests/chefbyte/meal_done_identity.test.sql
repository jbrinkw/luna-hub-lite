-- meal_done_identity: H-10 (UNMARK-WRONG) regression coverage
--
-- Audit: docs/superpowers/audits/2026-06-03-deep-audit-FINDINGS.md H-10 / theme T8.
--
-- THE BUG (pre-20260515100000):
--   private.unmark_meal_done reconstructed the BARE [MEAL] product name
--   ('[MEAL] '||name||' '||MM-DD) and deleted products WHERE name = that
--   bare string. But generate_meal_product_name appends an HH:MM time
--   suffix when a same-name product already exists. So the 2nd meal-prep
--   of the SAME recipe on the SAME logical_date creates a *suffixed*
--   product, while unmark only ever matches the *bare* name -> unmarking
--   the 2nd meal destroyed the 1st meal's product+lot and orphaned the
--   2nd's. No UNIQUE on products.name; collision avoidance was advisory.
--
-- THE FIX:
--   mark_meal_done persists the [MEAL] product_id it created onto
--   chefbyte.meal_plan_entries.meal_product_id; unmark_meal_done deletes
--   BY that stored id (falling back to the legacy name-match only when the
--   stored id is NULL, i.e. pre-fix backfill rows).
--
-- This test marks TWO meal-prep entries of the SAME recipe on the SAME
-- logical_date (forcing a suffixed 2nd product), then unmarks the 2nd and
-- asserts ONLY the 2nd's product+lot are gone while the 1st's survive and
-- the completed_at flags are correct.

BEGIN;
SELECT plan(13);

-- ─────────────────────────────────────────────────────────────
-- Setup
-- ─────────────────────────────────────────────────────────────
SELECT tests.create_supabase_user('meal_identity_tester');
SELECT tests.authenticate_as('meal_identity_tester');
SELECT hub.activate_app('chefbyte');

SELECT location_id AS fridge_id
  FROM chefbyte.locations
  WHERE user_id = tests.get_supabase_uid('meal_identity_tester') AND name = 'Fridge' \gset

-- Single-ingredient recipe so the meal-prep math is simple.
-- Beef: 1 spc, 200cal/25p/10f/0c per serving.
INSERT INTO chefbyte.products (product_id, user_id, name,
  servings_per_container, calories_per_serving, protein_per_serving,
  fat_per_serving, carbs_per_serving)
VALUES (
  'd0000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('meal_identity_tester'),
  'IdentityBeef', 1, 200, 25, 10, 0
);

-- Plenty of stock for two preps (need 1 container each).
INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
VALUES (
  tests.get_supabase_uid('meal_identity_tester'),
  'd0000000-0000-0000-0000-000000000001',
  :'fridge_id', 10.0, '2026-07-01'
);

INSERT INTO chefbyte.recipes (recipe_id, user_id, name, base_servings)
VALUES (
  'e0000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('meal_identity_tester'),
  'IdentityBowl', 1
);

INSERT INTO chefbyte.recipe_ingredients (user_id, recipe_id, product_id, quantity, unit)
VALUES (
  tests.get_supabase_uid('meal_identity_tester'),
  'e0000000-0000-0000-0000-000000000001',
  'd0000000-0000-0000-0000-000000000001', 1, 'container'
);

-- Two meal-prep entries, SAME recipe, SAME logical_date 2026-05-20.
INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
) VALUES
  ('f0000000-0000-0000-0000-000000000001',
   tests.get_supabase_uid('meal_identity_tester'),
   'e0000000-0000-0000-0000-000000000001', '2026-05-20', 1, true),
  ('f0000000-0000-0000-0000-000000000002',
   tests.get_supabase_uid('meal_identity_tester'),
   'e0000000-0000-0000-0000-000000000001', '2026-05-20', 1, true);

-- ─────────────────────────────────────────────────────────────
-- Mark BOTH meal-prep entries. The 2nd gets a time-suffixed product
-- name because the bare name is already taken by the 1st.
-- ─────────────────────────────────────────────────────────────
SELECT chefbyte.mark_meal_done('f0000000-0000-0000-0000-000000000001'::uuid);
SELECT chefbyte.mark_meal_done('f0000000-0000-0000-0000-000000000002'::uuid);

-- ─────────────────────────────────────────────────────────────
-- T1: TWO distinct [MEAL] products exist (bare + suffixed)
-- ─────────────────────────────────────────────────────────────
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.products
     WHERE user_id = tests.get_supabase_uid('meal_identity_tester')
       AND name LIKE '[MEAL] IdentityBowl 05-20%'),
  2,
  'two distinct [MEAL] products exist after marking two same-recipe/date preps'
);

-- T2: the 1st meal stored a meal_product_id (the fix persists it)
SELECT isnt(
  (SELECT meal_product_id FROM chefbyte.meal_plan_entries
     WHERE meal_id = 'f0000000-0000-0000-0000-000000000001'),
  NULL::uuid,
  'meal 1 has meal_product_id persisted by mark_meal_done'
);

-- T3: the 2nd meal stored a DIFFERENT meal_product_id
SELECT isnt(
  (SELECT meal_product_id FROM chefbyte.meal_plan_entries
     WHERE meal_id = 'f0000000-0000-0000-0000-000000000002'),
  (SELECT meal_product_id FROM chefbyte.meal_plan_entries
     WHERE meal_id = 'f0000000-0000-0000-0000-000000000001'),
  'meal 2 stored a different meal_product_id than meal 1'
);

-- Capture the two stored ids for later assertions.
SELECT meal_product_id AS meal1_pid
  FROM chefbyte.meal_plan_entries
  WHERE meal_id = 'f0000000-0000-0000-0000-000000000001' \gset
SELECT meal_product_id AS meal2_pid
  FROM chefbyte.meal_plan_entries
  WHERE meal_id = 'f0000000-0000-0000-0000-000000000002' \gset

-- ─────────────────────────────────────────────────────────────
-- Unmark the 2nd meal ONLY.
-- ─────────────────────────────────────────────────────────────
SELECT is(
  (SELECT (chefbyte.unmark_meal_done('f0000000-0000-0000-0000-000000000002'::uuid))->>'success'),
  'true',
  'unmark of meal 2 returns success=true'
);

-- ─────────────────────────────────────────────────────────────
-- T5: meal 1's product SURVIVES (this is the core regression — the old
--     code deleted the bare-named product, which belonged to meal 1).
-- ─────────────────────────────────────────────────────────────
SELECT ok(
  EXISTS (
    SELECT 1 FROM chefbyte.products
     WHERE product_id = :'meal1_pid'
       AND user_id = tests.get_supabase_uid('meal_identity_tester')
  ),
  'meal 1 [MEAL] product survives unmark of meal 2 (NOT wrongly deleted)'
);

-- T6: meal 2's product is GONE (its own product was deleted by id)
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM chefbyte.products
     WHERE product_id = :'meal2_pid'
       AND user_id = tests.get_supabase_uid('meal_identity_tester')
  ),
  'meal 2 [MEAL] product deleted by id on its own unmark'
);

-- T7: exactly ONE [MEAL] product remains (meal 1's), no orphan
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.products
     WHERE user_id = tests.get_supabase_uid('meal_identity_tester')
       AND name LIKE '[MEAL] IdentityBowl 05-20%'),
  1,
  'exactly one [MEAL] product remains after unmark of meal 2 (no orphan)'
);

-- T8: meal 1's [MEAL] stock lot survives (1 container)
SELECT is(
  (SELECT COALESCE(SUM(qty_containers), 0::numeric)
     FROM chefbyte.stock_lots
     WHERE product_id = :'meal1_pid'
       AND deleted_at IS NULL),
  1.000::numeric,
  'meal 1 [MEAL] stock lot survives (1 spendable container)'
);

-- T9: meal 2's [MEAL] stock lot is gone (no spendable stock)
SELECT is(
  (SELECT COALESCE(SUM(qty_containers), 0::numeric)
     FROM chefbyte.stock_lots
     WHERE product_id = :'meal2_pid'
       AND deleted_at IS NULL),
  0.000::numeric,
  'meal 2 [MEAL] stock lot removed after unmark'
);

-- ─────────────────────────────────────────────────────────────
-- completed_at flags must NOT be crossed.
-- ─────────────────────────────────────────────────────────────
-- T10: meal 1 stays completed
SELECT isnt(
  (SELECT completed_at FROM chefbyte.meal_plan_entries
     WHERE meal_id = 'f0000000-0000-0000-0000-000000000001'),
  NULL::timestamptz,
  'meal 1 remains completed after unmark of meal 2'
);

-- T11: meal 2 is now uncompleted
SELECT is(
  (SELECT completed_at FROM chefbyte.meal_plan_entries
     WHERE meal_id = 'f0000000-0000-0000-0000-000000000002'),
  NULL::timestamptz,
  'meal 2 is uncompleted after its unmark'
);

-- T12: meal 1's stored meal_product_id is untouched
SELECT is(
  (SELECT meal_product_id FROM chefbyte.meal_plan_entries
     WHERE meal_id = 'f0000000-0000-0000-0000-000000000001'),
  :'meal1_pid'::uuid,
  'meal 1 meal_product_id pointer unchanged'
);

-- T13: meal 2's stored meal_product_id is cleared on unmark
SELECT is(
  (SELECT meal_product_id FROM chefbyte.meal_plan_entries
     WHERE meal_id = 'f0000000-0000-0000-0000-000000000002'),
  NULL::uuid,
  'meal 2 meal_product_id cleared on unmark'
);

-- ─────────────────────────────────────────────────────────────
-- Teardown
-- ─────────────────────────────────────────────────────────────
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('meal_identity_tester');

SELECT * FROM finish();
ROLLBACK;
