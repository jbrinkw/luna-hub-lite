-- Feature X — Shopping auto-clear on import
--
-- Problem
-- -------
-- Before this migration, CHEFBYTE_import_shopping_to_inventory (MCP tool)
-- and the web "Import to Inventory" button both did their own ad-hoc
-- multi-step client-side loop (insert/merge stock_lots, then delete the
-- shopping_list rows). Because the delete step silently failed in some
-- paths — or because users just kept reading the shopping list after
-- successful imports — items could be imported twice, minting duplicate
-- lots.
--
-- Fix
-- ---
-- 1. Add `imported_at TIMESTAMPTZ NULL` to chefbyte.shopping_list.
--    NULL  = still active in the cart.
--    != NULL = already imported at the recorded time.
--    Default filter in the UI: WHERE imported_at IS NULL.
-- 2. Replace the client-side loop with a plpgsql SECURITY DEFINER RPC
--    `chefbyte.import_shopping_to_inventory(p_location_id UUID)`. The
--    RPC atomically:
--       a. Resolves location_id (first location if NULL).
--       b. For each purchased, not-yet-imported row: merge-or-insert
--          a stock_lot (same product+location+NULL expires_on).
--       c. Marks ALL processed rows with imported_at = now().
--    This runs in a single plpgsql function, so either the whole batch
--    succeeds and imported_at is set for every processed row, or the
--    transaction rolls back (so nothing gets hidden from the UI while
--    the stock lots fail to insert).
-- 3. A second call is idempotent: already-imported rows are filtered
--    out of the initial SELECT, so the second call returns 0 items
--    processed and creates no new lots.

BEGIN;

-- ---------------------------------------------------------------------------
-- Column
-- ---------------------------------------------------------------------------
ALTER TABLE chefbyte.shopping_list
  ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ NULL;

-- Partial index: active cart queries (the UI default) filter by
-- imported_at IS NULL. Keeps that path fast even as imported history grows.
CREATE INDEX IF NOT EXISTS shopping_list_active_idx
  ON chefbyte.shopping_list (user_id)
  WHERE imported_at IS NULL;

-- ---------------------------------------------------------------------------
-- PRIVATE: import_shopping_to_inventory
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.import_shopping_to_inventory(
  p_user_id UUID,
  p_location_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_location_id UUID;
  v_now TIMESTAMPTZ := now();
  v_row RECORD;
  v_existing_lot_id UUID;
  v_existing_qty NUMERIC(10,3);
  v_lots_processed INT := 0;
BEGIN
  -- Resolve location (first by created_at if caller did not supply one)
  IF p_location_id IS NULL THEN
    SELECT location_id INTO v_location_id
    FROM chefbyte.locations
    WHERE user_id = p_user_id
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_location_id IS NULL THEN
      RAISE EXCEPTION 'No storage locations found for user';
    END IF;
  ELSE
    -- Validate caller-supplied location belongs to the user
    SELECT location_id INTO v_location_id
    FROM chefbyte.locations
    WHERE location_id = p_location_id AND user_id = p_user_id;

    IF v_location_id IS NULL THEN
      RAISE EXCEPTION 'Location not found or not owned by user';
    END IF;
  END IF;

  -- Iterate every purchased, not-yet-imported row for this user.
  -- Doing the merge inside the loop keeps the per-lot math simple and
  -- preserves the legacy "merge into an existing NULL-expiry lot"
  -- semantic. Ordered by created_at so deterministic for tests.
  FOR v_row IN
    SELECT cart_item_id, product_id, qty_containers
      FROM chefbyte.shopping_list
     WHERE user_id = p_user_id
       AND purchased = true
       AND imported_at IS NULL
     ORDER BY created_at ASC
  LOOP
    -- Try to merge into an existing lot (same product, same location,
    -- NULL expires_on — matches the legacy UI behavior).
    SELECT lot_id, qty_containers
      INTO v_existing_lot_id, v_existing_qty
      FROM chefbyte.stock_lots
     WHERE user_id = p_user_id
       AND product_id = v_row.product_id
       AND location_id = v_location_id
       AND expires_on IS NULL
     LIMIT 1;

    IF v_existing_lot_id IS NOT NULL THEN
      UPDATE chefbyte.stock_lots
         SET qty_containers = v_existing_qty + v_row.qty_containers
       WHERE lot_id = v_existing_lot_id;
    ELSE
      INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers)
      VALUES (p_user_id, v_row.product_id, v_location_id, v_row.qty_containers);
    END IF;

    -- Mark the source row as imported. The UI's default filter
    -- (imported_at IS NULL) hides this row from now on; a "Show
    -- imported" toggle surfaces it for audit.
    UPDATE chefbyte.shopping_list
       SET imported_at = v_now
     WHERE cart_item_id = v_row.cart_item_id;

    v_lots_processed := v_lots_processed + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'lots_processed', v_lots_processed,
    'imported_at', v_now
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- PUBLIC RPC WRAPPER
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION chefbyte.import_shopping_to_inventory(
  p_location_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.import_shopping_to_inventory(
    (SELECT auth.uid()), p_location_id
  );
$$;

GRANT EXECUTE ON FUNCTION chefbyte.import_shopping_to_inventory(UUID) TO authenticated;

COMMIT;
