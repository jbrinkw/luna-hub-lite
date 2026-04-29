-- recipe_gram_unit: extend chefbyte.recipe_ingredients.unit to support 'gram'
--
-- INTENT:
--   Users want to specify recipe ingredients by weight (e.g. "200g chicken breast").
--   Conversion plumbing already exists via chefbyte.products.net_weight_g (full
--   container mass in grams, added by the live_shelf migration).
--
-- SQL FUNCTIONS WHOSE MATH IS UPDATED IN COMPANION MIGRATIONS:
--   * private.mark_meal_done      (20260429230000_mark_meal_done_gram_unit.sql)
--   * private.unmark_meal_done    (20260429240000_unmark_meal_done_gram_unit.sql)
--
-- The consumer-side (consume_product) is NOT touched: mark_meal_done
-- pre-converts gram quantities to containers before calling consume_product,
-- so consume_product continues to receive only 'container' / 'serving'.

BEGIN;

-- Drop the old 2-value CHECK and re-add with 'gram' included.
ALTER TABLE chefbyte.recipe_ingredients
  DROP CONSTRAINT IF EXISTS recipe_ingredients_unit_check;

ALTER TABLE chefbyte.recipe_ingredients
  ADD CONSTRAINT recipe_ingredients_unit_check
  CHECK (unit IN ('container', 'serving', 'gram'));

COMMIT;
