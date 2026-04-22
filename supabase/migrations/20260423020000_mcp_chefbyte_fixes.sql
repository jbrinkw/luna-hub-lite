-- MCP ChefByte fixes from 2026-04-22 E2E audit:
--   * add_to_shopping must be ADDITIVE (sum qty on conflict) not REPLACE.
--
-- The previous client-side upsert used
--   INSERT ... ON CONFLICT (user_id, product_id) DO UPDATE SET qty = EXCLUDED.qty
-- implicitly via PostgREST. This replaced the existing qty, violating the
-- "additive upsert" spec from docs/apps/chefbyte.md. A read-then-write path
-- from the handler would be racy under concurrency, so we do it in one
-- statement server-side.
--
-- NOTE: this initial definition had RETURNS TABLE column names that shadowed
-- the underlying shopping_list columns, producing "column reference 'product_id'
-- is ambiguous" at runtime. The repair is in the immediately following
-- migration (20260423030000_fix_add_to_shopping_admin_ambiguous.sql) which
-- DROPs + re-CREATEs the function with `out_*` column aliases. This file is
-- kept as-is so that environments that have already applied it see the
-- repair migration advance the schema consistently.

CREATE OR REPLACE FUNCTION chefbyte.add_to_shopping_admin(
  p_user_id UUID,
  p_product_id UUID,
  p_qty NUMERIC
)
RETURNS TABLE (
  cart_item_id UUID,
  product_id UUID,
  qty_containers NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM chefbyte.products p
    WHERE p.product_id = p_product_id
      AND p.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Product not found or not owned by user';
  END IF;

  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'qty_containers must be a positive finite number';
  END IF;

  RETURN QUERY
  INSERT INTO chefbyte.shopping_list AS sl (user_id, product_id, qty_containers)
  VALUES (p_user_id, p_product_id, p_qty)
  ON CONFLICT (user_id, product_id) DO UPDATE
    SET qty_containers = sl.qty_containers + EXCLUDED.qty_containers
  RETURNING sl.cart_item_id, sl.product_id, sl.qty_containers;
END;
$$;

GRANT EXECUTE ON FUNCTION chefbyte.add_to_shopping_admin(UUID, UUID, NUMERIC) TO service_role;
