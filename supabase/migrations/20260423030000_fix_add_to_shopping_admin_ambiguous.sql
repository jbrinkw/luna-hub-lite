-- Repair: the previous migration 20260423020000_mcp_chefbyte_fixes.sql defined
-- chefbyte.add_to_shopping_admin with RETURNS TABLE columns named the same as
-- the underlying shopping_list columns (`product_id`, `qty_containers`, etc).
-- In plpgsql the RETURNS TABLE names shadow column refs inside RETURNING and
-- Postgres raises "column reference 'product_id' is ambiguous" at runtime.
--
-- Rename the output columns so they no longer collide.

DROP FUNCTION IF EXISTS chefbyte.add_to_shopping_admin(UUID, UUID, NUMERIC);

CREATE FUNCTION chefbyte.add_to_shopping_admin(
  p_user_id UUID,
  p_product_id UUID,
  p_qty NUMERIC
)
RETURNS TABLE (
  out_cart_item_id UUID,
  out_product_id UUID,
  out_qty_containers NUMERIC
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
