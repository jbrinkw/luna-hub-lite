-- chefbyte.food_logs.product_id — change FK ON DELETE behavior
--
-- Historical state (from 20260303040000_chefbyte_tables.sql):
--   product_id UUID NOT NULL
--     REFERENCES chefbyte.products(product_id) ON DELETE CASCADE
--
-- Problem: a hard DELETE on a product wipes every food_logs row that
-- referenced it, destroying the user's macro history. Soft-delete
-- (20260423040000_products_soft_delete.sql) makes hard deletes via the
-- UI / MCP a non-issue, but the FK still allows CASCADE if anything in
-- the stack ever hard-deletes a row (schema migrations, manual admin
-- ops, backup/restore replaying an old snapshot, etc.). Defense in depth:
-- make the FK forgive.
--
-- Fix:
--   • product_id becomes NULLABLE — a food_log row can survive the
--     product disappearing.
--   • ON DELETE SET NULL — hard deletes now null out the reference
--     instead of cascading.
--   • food_logs already stores denormalized macros (calories, carbs,
--     protein, fat) so macro roll-ups (get_daily_macros) still work
--     without the product link.
--   • UI joins that read product name will see null — MacroPage renders
--     a blank/"(deleted product)" label; explicitly handled by the
--     optional chaining already present in the component.

BEGIN;

-- Drop old CASCADE FK
ALTER TABLE chefbyte.food_logs
  DROP CONSTRAINT IF EXISTS food_logs_product_id_fkey;

-- Make column nullable
ALTER TABLE chefbyte.food_logs
  ALTER COLUMN product_id DROP NOT NULL;

-- Re-add with ON DELETE SET NULL
ALTER TABLE chefbyte.food_logs
  ADD CONSTRAINT food_logs_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES chefbyte.products(product_id)
  ON DELETE SET NULL;

COMMIT;
