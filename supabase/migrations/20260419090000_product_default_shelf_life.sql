-- Add default_shelf_life_days to chefbyte.products so the scanner can
-- auto-populate stock_lots.expires_on on purchase. Populated by the
-- analyze-product edge function during first import (LLM suggestion
-- based on food category). NULL = non-perishable / unknown; scanner
-- falls back to leaving expires_on unset for those.
--
-- Range bound: 1–3650 days (10 years). The LLM prompt constrains
-- suggestions to reasonable ranges but the CHECK is a hard backstop
-- against prompt-injection or parse mistakes.

ALTER TABLE chefbyte.products
  ADD COLUMN IF NOT EXISTS default_shelf_life_days INT
    CHECK (default_shelf_life_days IS NULL OR default_shelf_life_days BETWEEN 1 AND 3650);

COMMENT ON COLUMN chefbyte.products.default_shelf_life_days IS
  'LLM-suggested typical shelf life in days from purchase. Null = non-perishable / uncertain. Scanner computes stock_lots.expires_on = purchase_date + this on each purchase.';
