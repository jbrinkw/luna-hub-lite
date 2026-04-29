-- products_distinct_unit: add is_distinct_unit_item + default_recipe_unit to chefbyte.products
--
-- is_distinct_unit_item: true when the product is sold as discrete countable
--   pieces users naturally count by piece (eggs, buns, bread slices, tortillas,
--   protein bars, packets). For distinct items, servings_per_container = number
--   of physical pieces in the package — "1 serving" reads as "1 piece".
--   False for bulk items measured by mass/volume (yogurt, milk, sugar, flour, oil).
--
-- default_recipe_unit: drives the recipe form's initial unit dropdown selection
--   when this product is added to a recipe.
--   'gram'      → bulk items; requires net_weight_g > 0 (enforced by app code, not DB).
--   'serving'   → distinct items; 1 serving = 1 physical piece.
--   'container' → rarely used; only when neither gram nor serving makes sense.
--   NULL        → no preference (recipe form falls back: gram if net_weight_g > 0, else serving).
--
-- DB allows NULL net_weight_g for backward compat with existing products
-- that were created before net_weight_g was added. App code must check
-- net_weight_g > 0 before honoring default_recipe_unit = 'gram'.

BEGIN;

ALTER TABLE chefbyte.products
  ADD COLUMN IF NOT EXISTS is_distinct_unit_item BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_recipe_unit TEXT;

ALTER TABLE chefbyte.products
  DROP CONSTRAINT IF EXISTS products_default_recipe_unit_check;

ALTER TABLE chefbyte.products
  ADD CONSTRAINT products_default_recipe_unit_check
    CHECK (default_recipe_unit IS NULL OR default_recipe_unit IN ('gram', 'serving', 'container'));

COMMIT;
