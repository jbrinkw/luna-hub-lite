-- ════════════════════════════════════════════════════════════════════════════
-- A3-03 — Shopping-list hidden-row sibling (deep audit 2026-06-03).
-- ════════════════════════════════════════════════════════════════════════════
-- SAME hidden-row class as the stock_lots ghost bug, DIFFERENT table.
-- chefbyte.shopping_list carries an `imported_at` column: NULL = active in the
-- To-Buy cart, non-NULL = already imported into inventory (hidden; the UI cart
-- filters WHERE imported_at IS NULL — see 20260425010000). The stock_lots
-- revive trigger (20260515030000) does NOT touch this table.
--
-- BUG: chefbyte.add_to_shopping_admin (the CHEFBYTE_add_to_shopping MCP tool's
-- RPC) upserts a quantity ON CONFLICT (user_id, product_id) but only bumps
-- qty_containers — it leaves `imported_at` (and `purchased`) untouched. So when
-- the conflicting row was already imported, the added quantity lands on the
-- HIDDEN row: it never re-appears in the active cart. The user adds an item to
-- their shopping list and it silently vanishes.
--
-- FIX (mirrors the TS writers below-min-stock.ts + HomePage.syncMealPlanToCart,
-- which set imported_at:null + purchased:false on their upserts): when a deficit
-- is added onto an existing row, reset imported_at = NULL and purchased = false
-- so the row re-enters the active, not-yet-bought cart. Adding to a cart means
-- "I still need to buy this", which is exactly imported_at IS NULL + purchased
-- = false.
--
-- Everything else about the function — the auth.uid() guard, ownership check,
-- positive-qty check, RETURNS TABLE shape, SECURITY DEFINER, search_path, the
-- REVOKE/GRANT — is preserved verbatim from 20260515020000 (T2 lockdown). Only
-- the ON CONFLICT SET list changes.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION chefbyte.add_to_shopping_admin(
  p_user_id uuid, p_product_id uuid, p_qty numeric
)
RETURNS TABLE(out_cart_item_id uuid, out_product_id uuid, out_qty_containers numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL
     AND p_user_id IS DISTINCT FROM (SELECT auth.uid())
  THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must equal auth.uid()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

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
    SET qty_containers = sl.qty_containers + EXCLUDED.qty_containers,
        -- A3-03: a deficit added onto an already-imported row must re-surface
        -- in the active cart (WHERE imported_at IS NULL) and be un-bought.
        imported_at    = NULL,
        purchased      = false
  RETURNING sl.cart_item_id, sl.product_id, sl.qty_containers;
END;
$function$;

REVOKE EXECUTE ON FUNCTION chefbyte.add_to_shopping_admin(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.add_to_shopping_admin(uuid, uuid, numeric) TO service_role;

COMMENT ON FUNCTION chefbyte.add_to_shopping_admin(uuid, uuid, numeric) IS
  'Adds p_user_id''s product to their shopping list (MCP wrapper). On conflict '
  'bumps qty AND resets imported_at=NULL + purchased=false so a re-add resurfaces '
  'in the active cart (A3-03 hidden-row fix). service_role only; auth.uid() guard '
  '+ REVOKE block authenticated/anon. [T2 lockdown + A3-03]';

COMMIT;
