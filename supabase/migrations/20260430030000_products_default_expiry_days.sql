-- Add default_expiry_days to chefbyte.products.
--
-- Distinct from default_shelf_life_days (which is the typical unopened
-- pantry/fridge life used to auto-populate stock_lots.expires_on on
-- purchase). default_expiry_days is the AI-estimated days-until-expiry
-- for a freshly imported product — a simpler, user-facing "this product
-- expires in N days" default shown in the product settings page.
--
-- Range: 1–730 days (0.5 years max). NULL = non-perishable or unknown.
-- The analyze-product edge function populates this on first import via
-- the Haiku normalization call.

ALTER TABLE chefbyte.products
  ADD COLUMN IF NOT EXISTS default_expiry_days INT
    CHECK (default_expiry_days IS NULL OR default_expiry_days BETWEEN 1 AND 730);

COMMENT ON COLUMN chefbyte.products.default_expiry_days IS
  'AI-estimated days until expiry from import date. Null = non-perishable or uncertain. Range 1–730. Set by analyze-product edge function on first barcode import.';
