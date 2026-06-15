-- meal_done_tagging: H-14 (mark_meal_done over-tag) regression coverage
--
-- Audit: docs/superpowers/audits/2026-06-03-deep-audit-FINDINGS.md H-14 / theme T6.
--
-- THE BUG (pre-20260515100000):
--   private.mark_meal_done tagged the meal's food_logs with:
--       UPDATE chefbyte.food_logs SET meal_id = p_meal_id
--        WHERE user_id = p_user_id AND meal_id IS NULL
--          AND created_at = now();
--   now() is the transaction-start timestamp. Any UNRELATED food_log
--   inserted in the SAME transaction before mark_meal_done shares that
--   created_at, so its meal_id gets overwritten and it appears in the
--   returned food_log_ids -> corrupted macro attribution.
--
-- THE FIX:
--   mark_meal_done captures the SPECIFIC food_log_id returned from each
--   consume_product call (consume_product now surfaces 'food_log_id' in
--   its return JSONB) and sets meal_id on exactly those ids.
--
-- This test runs entirely inside one pgTAP transaction (so now() is
-- constant for every insert, exactly reproducing the latent condition),
-- inserts an unrelated food_log first, then calls mark_meal_done and
-- asserts the unrelated row is untouched and excluded from food_log_ids.

BEGIN;
SELECT plan(8);

-- ─────────────────────────────────────────────────────────────
-- Setup
-- ─────────────────────────────────────────────────────────────
SELECT tests.create_supabase_user('meal_tagging_tester');
SELECT tests.authenticate_as('meal_tagging_tester');
SELECT hub.activate_app('chefbyte');

SELECT location_id AS fridge_id
  FROM chefbyte.locations
  WHERE user_id = tests.get_supabase_uid('meal_tagging_tester') AND name = 'Fridge' \gset

-- Meal ingredient product.
INSERT INTO chefbyte.products (product_id, user_id, name,
  servings_per_container, calories_per_serving, protein_per_serving,
  fat_per_serving, carbs_per_serving)
VALUES (
  'a1000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('meal_tagging_tester'),
  'TagChicken', 2, 165, 31, 3.6, 0
);

-- An UNRELATED product whose food_log must NOT be swept into the meal.
INSERT INTO chefbyte.products (product_id, user_id, name,
  servings_per_container, calories_per_serving, protein_per_serving,
  fat_per_serving, carbs_per_serving)
VALUES (
  'a1000000-0000-0000-0000-000000000002',
  tests.get_supabase_uid('meal_tagging_tester'),
  'UnrelatedSnack', 1, 50, 1, 0, 12
);

INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
VALUES (
  tests.get_supabase_uid('meal_tagging_tester'),
  'a1000000-0000-0000-0000-000000000001',
  :'fridge_id', 5.0, '2026-07-01'
);

INSERT INTO chefbyte.recipes (recipe_id, user_id, name, base_servings)
VALUES (
  'b1000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('meal_tagging_tester'),
  'TagBowl', 1
);

INSERT INTO chefbyte.recipe_ingredients (user_id, recipe_id, product_id, quantity, unit)
VALUES (
  tests.get_supabase_uid('meal_tagging_tester'),
  'b1000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000001', 1, 'container'
);

INSERT INTO chefbyte.meal_plan_entries (
  meal_id, user_id, recipe_id, logical_date, servings, meal_prep
) VALUES (
  'c1000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('meal_tagging_tester'),
  'b1000000-0000-0000-0000-000000000001',
  '2026-05-21', 1, false
);

-- ─────────────────────────────────────────────────────────────
-- Insert an UNRELATED food_log BEFORE mark_meal_done, in this same txn.
-- Its created_at defaults to now() (txn-start) — identical to the
-- timestamp mark_meal_done used for its old WHERE created_at = now()
-- match. This is the exact latent condition described in H-14.
-- ─────────────────────────────────────────────────────────────
INSERT INTO chefbyte.food_logs (
  log_id, user_id, product_id, logical_date,
  qty_consumed, unit, calories, carbs, protein, fat, meal_id
) VALUES (
  'da000000-0000-0000-0000-0000000000aa',
  tests.get_supabase_uid('meal_tagging_tester'),
  'a1000000-0000-0000-0000-000000000002',
  '2026-05-21', 1, 'serving', 50, 12, 1, 0, NULL
);

-- Sanity: confirm the unrelated log shares now() with the txn (defends
-- the premise — if created_at were not txn-start, the test would be
-- vacuous and could not catch the bug).
SELECT is(
  (SELECT created_at FROM chefbyte.food_logs
     WHERE log_id = 'da000000-0000-0000-0000-0000000000aa'),
  now(),
  'premise: unrelated food_log.created_at = now() (txn-start) — reproduces the over-tag window'
);

-- ─────────────────────────────────────────────────────────────
-- Call mark_meal_done. Capture its return payload.
-- ─────────────────────────────────────────────────────────────
SELECT chefbyte.mark_meal_done('c1000000-0000-0000-0000-000000000001'::uuid) AS mark_result \gset

-- ─────────────────────────────────────────────────────────────
-- T2: the unrelated food_log's meal_id is STILL NULL (not overwritten)
-- ─────────────────────────────────────────────────────────────
SELECT is(
  (SELECT meal_id FROM chefbyte.food_logs
     WHERE log_id = 'da000000-0000-0000-0000-0000000000aa'),
  NULL::uuid,
  'unrelated food_log meal_id stays NULL (not over-tagged by created_at=now())'
);

-- T3: the meal's OWN food_log (TagChicken) IS tagged with the meal_id
SELECT is(
  (SELECT meal_id FROM chefbyte.food_logs
     WHERE user_id = tests.get_supabase_uid('meal_tagging_tester')
       AND product_id = 'a1000000-0000-0000-0000-000000000001'),
  'c1000000-0000-0000-0000-000000000001'::uuid,
  'meal''s own ingredient food_log is tagged with the meal_id'
);

-- T4: exactly ONE food_log is tagged for this meal (only the chicken)
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.food_logs
     WHERE user_id = tests.get_supabase_uid('meal_tagging_tester')
       AND meal_id = 'c1000000-0000-0000-0000-000000000001'),
  1,
  'exactly one food_log tagged to the meal (unrelated snack excluded)'
);

-- T5: the returned food_log_ids array has exactly ONE entry
SELECT is(
  jsonb_array_length((:'mark_result'::jsonb)->'food_log_ids'),
  1,
  'food_log_ids return array contains exactly one id (only the meal''s own log)'
);

-- T6: the unrelated log_id is NOT present in food_log_ids
SELECT ok(
  NOT ((:'mark_result'::jsonb)->'food_log_ids' @> '"da000000-0000-0000-0000-0000000000aa"'::jsonb),
  'unrelated food_log id is NOT in the returned food_log_ids'
);

-- T7: the meal's own chicken log_id IS present in food_log_ids
SELECT ok(
  (:'mark_result'::jsonb)->'food_log_ids' @> to_jsonb(
    (SELECT log_id FROM chefbyte.food_logs
       WHERE user_id = tests.get_supabase_uid('meal_tagging_tester')
         AND product_id = 'a1000000-0000-0000-0000-000000000001')
  ),
  'meal''s own chicken food_log id IS in the returned food_log_ids'
);

-- T8: the unrelated log still has its original macros intact (untouched)
SELECT is(
  (SELECT calories FROM chefbyte.food_logs
     WHERE log_id = 'da000000-0000-0000-0000-0000000000aa'),
  50.000::numeric,
  'unrelated food_log macros untouched (50 cal preserved)'
);

-- ─────────────────────────────────────────────────────────────
-- Teardown
-- ─────────────────────────────────────────────────────────────
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('meal_tagging_tester');

SELECT * FROM finish();
ROLLBACK;
