-- products_display_by_weight: per-product flag to render quantities as weight.
--
-- For by-weight items (ground beef, flour, oats, etc.) the user expects to
-- see "150g" or "5.3oz" instead of "0.5 servings" or "0.125 ctn". Adding
-- a bool toggle on the product itself makes this a one-click signal in
-- the product form.
--
-- The display layer reads this flag plus the user's `hub.profiles.unit_system`
-- preference (added in companion migration 20260430080000_hub_unit_system.sql)
-- to render either grams (metric) or ounces (imperial). Backend math NEVER
-- reads display_by_weight — canonical unit + quantity remain the single
-- source of truth for stock decrements, macro calc, etc.
--
-- Conversion source: existing chefbyte.products.net_weight_g (full container
-- mass in grams). When display_by_weight = true AND net_weight_g IS NULL,
-- the helper falls back to canonical rendering — there's no math to do.
--
-- This is orthogonal to visual_unit_label / visual_units_per_serving.
-- display_by_weight wins precedence: a product flagged display_by_weight=true
-- renders as weight regardless of any visual_unit_label set on the row. The
-- form-side validation should keep these mutually exclusive (visual is for
-- discrete piece-units like "egg" / "slice"; display_by_weight is for bulk
-- weight items).

ALTER TABLE chefbyte.products
  ADD COLUMN display_by_weight BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN chefbyte.products.display_by_weight IS
  'When true and net_weight_g IS NOT NULL, the UI renders this product''s '
  'quantities as weight (grams or ounces, per user preference). Display-only; '
  'backend math reads canonical unit + quantity. Mutually exclusive with '
  'visual_unit_label in the product form (enforced UI-side, not DB-side).';
