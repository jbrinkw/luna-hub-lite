-- drop_recipe_visual_unit: remove the per-ingredient visual-unit pair
-- (visual_unit_label + visual_quantity) from chefbyte.recipe_ingredients.
--
-- Superseded by the product-level visual_unit_label +
-- visual_units_per_serving introduced in companion migration
-- 20260430040000_products_visual_unit.sql. Display semantics now live on
-- the product so the same human-readable rendering ("2 eggs Cage-Free
-- Eggs") works across recipe lines, inventory rows, meal-plan rows and
-- food-log rows without per-recipe duplication.
--
-- The constraint name `visual_pair_complete` was added in
-- 20260429250000_recipe_visual_unit.sql.
--
-- save_recipe_ingredients RPC reverts to its no-visual signature in
-- companion migration 20260430060000_save_recipe_ingredients_no_visual.sql.

BEGIN;

ALTER TABLE chefbyte.recipe_ingredients
  DROP CONSTRAINT IF EXISTS visual_pair_complete,
  DROP COLUMN     IF EXISTS visual_unit_label,
  DROP COLUMN     IF EXISTS visual_quantity;

COMMIT;
