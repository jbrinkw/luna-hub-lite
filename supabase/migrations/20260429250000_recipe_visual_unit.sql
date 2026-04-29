-- recipe_visual_unit: add display-only visual unit fields to recipe_ingredients
--
-- visual_unit_label is display-only ("slice", "scoop", "tbsp"). It does NOT
-- affect macro calculation, stock deduction, or any business logic.
-- macro/stock math always uses canonical `unit`+`quantity` only.
--
-- SQL function impact: NONE.
-- private.mark_meal_done, private.unmark_meal_done, and chefbyte.consume_product
-- all read canonical `unit`+`quantity` from recipe_ingredients and do NOT read
-- visual_unit_label or visual_quantity. Those functions are intentionally NOT
-- touched by this migration.

ALTER TABLE chefbyte.recipe_ingredients
  ADD COLUMN visual_unit_label TEXT,
  ADD COLUMN visual_quantity   NUMERIC(10,3),
  ADD CONSTRAINT visual_pair_complete CHECK (
    (visual_unit_label IS NULL AND visual_quantity IS NULL)
    OR (visual_unit_label IS NOT NULL AND visual_quantity IS NOT NULL AND visual_quantity > 0)
  );

COMMENT ON COLUMN chefbyte.recipe_ingredients.visual_unit_label IS
  'Display-only label shown to the user (e.g. "slice", "scoop", "tbsp"). '
  'Macro and stock math always uses the canonical unit + quantity columns.';

COMMENT ON COLUMN chefbyte.recipe_ingredients.visual_quantity IS
  'Display-only quantity paired with visual_unit_label. '
  'Must be set together with visual_unit_label (both NULL or both non-NULL with qty > 0).';
