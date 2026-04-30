-- products_visual_unit: lift the display-only "visual unit" feature from
-- chefbyte.recipe_ingredients to chefbyte.products.
--
-- This migration SUPERSEDES the per-ingredient pair added by
-- 20260429250000_recipe_visual_unit.sql. The same fields now live at
-- the product level, so EVERY surface that displays a product quantity
-- (recipe lines, inventory rows, meal-plan rows, food-log rows) renders
-- consistently — e.g. "2 eggs Cage-Free Eggs" instead of "2 svg ..." for
-- one product, regardless of where it appears.
--
-- The companion migration 20260430050000_drop_recipe_visual_unit.sql
-- drops the now-superseded recipe_ingredients columns.
--
-- Semantics:
--   visual_unit_label         — singular noun ("egg", "slice", "scoop").
--                               Display-only; backend math NEVER reads it.
--   visual_units_per_serving  — count of the named unit per ONE serving.
--                               Eggs: 1.000.  Big bagel: 0.500.  Slice
--                               of bread (16-slice loaf where 1 serving =
--                               2 slices): 2.000.
--
--   Both NULL  → product has no visual unit; UI uses canonical "X svg".
--   Both set   → display layer multiplies (servings × units_per_serving)
--                and renders "<n> <label> <product name>".
--
-- SQL function impact: NONE.
-- private.consume_product, private.mark_meal_done,
-- private.unmark_meal_done, all macro/stock math continues to read only
-- canonical `unit` + `quantity` from recipe_ingredients / food_logs.
-- The new columns are pure display metadata.

BEGIN;

ALTER TABLE chefbyte.products
  ADD COLUMN visual_unit_label TEXT,
  ADD COLUMN visual_units_per_serving NUMERIC(10,3),
  ADD CONSTRAINT products_visual_pair_complete CHECK (
    (visual_unit_label IS NULL AND visual_units_per_serving IS NULL)
    OR (
      visual_unit_label IS NOT NULL
      AND visual_units_per_serving IS NOT NULL
      AND visual_units_per_serving > 0
    )
  );

COMMENT ON COLUMN chefbyte.products.visual_unit_label IS
  'Display-only singular noun used in human-readable quantity strings '
  '("egg", "slice", "scoop"). Backend math (consume_product, '
  'mark_meal_done, food_logs, macro calc) never reads this column — '
  'canonical unit + quantity remain the single source of truth.';

COMMENT ON COLUMN chefbyte.products.visual_units_per_serving IS
  'Display-only count: how many of the named visual unit equal one '
  'serving. Eggs: 1.000. Half-bagel-per-serving: 0.500. Must be set '
  'together with visual_unit_label (both NULL or both non-NULL with '
  'qty > 0). Display layer renders (servings * visual_units_per_serving) '
  'as "<n> <label> <product name>". Supersedes the per-ingredient pair '
  'introduced by migration 20260429250000_recipe_visual_unit.sql.';

COMMIT;
