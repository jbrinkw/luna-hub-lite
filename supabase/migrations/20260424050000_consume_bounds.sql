-- Consume-more-than-stock footgun: bound unreasonable qty
--
-- Incident: MCP agent logged 1,999,800 calories in a single CHEFBYTE_consume
-- call. No DB-level sanity check; no per-call confirmation gate.
--
-- Two-layer defense:
--   1. Hard upper bound on qty (HARD_QTY_CEILING) — anything above this
--      is rejected as a bug. Containers > 10,000 is not a legitimate
--      consumption input regardless of confirm flag.
--   2. Soft-gate on calorie-load (SOFT_CAL_CEILING) — if the computed
--      total calories exceeds the ceiling AND the caller did NOT pass
--      p_confirm_large_amount=TRUE, reject with a descriptive error.
--      Human UI paths (scanner) pass TRUE implicitly because the scan
--      already confirmed the product; MCP agent defaults to FALSE and
--      must re-invoke with the confirm flag to proceed.
--
-- The RPC signature is extended via CREATE OR REPLACE with a new trailing
-- parameter and a DEFAULT, so existing callers (web scanner, prior
-- migrations' service_role wrapper) keep working without a breaking
-- change. The wrapper signature is refreshed to expose the new parameter.

BEGIN;

-- Drop old 6-arg overload so the new 7-arg version with DEFAULT is the
-- only candidate for existing 6-arg call sites.
DROP FUNCTION IF EXISTS private.consume_product(UUID, UUID, NUMERIC, TEXT, BOOLEAN, DATE);

CREATE OR REPLACE FUNCTION private.consume_product(
  p_user_id UUID,
  p_product_id UUID,
  p_qty NUMERIC,
  p_unit TEXT,
  p_log_macros BOOLEAN,
  p_logical_date DATE,
  p_confirm_large_amount BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_product RECORD;
  v_qty_containers NUMERIC(10,3);
  v_total_servings NUMERIC(10,3);
  v_cal NUMERIC(10,3);
  v_carbs NUMERIC(10,3);
  v_protein NUMERIC(10,3);
  v_fat NUMERIC(10,3);
  v_remaining NUMERIC(10,3);
  v_lot RECORD;
  v_stock_remaining NUMERIC(10,3);
  v_stored_unit TEXT;

  -- Hard ceiling: qty above this is treated as a bug regardless of flag.
  -- 10,000 servings ≈ several decades of consumption of any single product.
  HARD_QTY_CEILING CONSTANT NUMERIC := 10000;
  -- Soft ceiling on computed calorie load: above this the caller must
  -- explicitly opt in via p_confirm_large_amount.
  SOFT_CAL_CEILING CONSTANT NUMERIC := 10000;
BEGIN
  -- Validate positive quantity
  IF p_qty <= 0 THEN
    RAISE EXCEPTION 'Quantity must be positive, got %', p_qty;
  END IF;

  -- Hard ceiling: qty clearly nonsensical
  IF p_qty > HARD_QTY_CEILING THEN
    RAISE EXCEPTION 'Quantity % exceeds hard ceiling of %. Value is outside any plausible consumption.', p_qty, HARD_QTY_CEILING;
  END IF;

  -- Look up product
  SELECT * INTO v_product
  FROM chefbyte.products
  WHERE product_id = p_product_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found or not owned by user';
  END IF;

  -- Normalize unit: only 'serving' is special; everything else is 'container'
  IF p_unit = 'serving' THEN
    v_stored_unit := 'serving';
    v_qty_containers := p_qty / GREATEST(v_product.servings_per_container, 0.001);
  ELSE
    v_stored_unit := 'container';
    v_qty_containers := p_qty;
  END IF;

  -- Calculate macros for the FULL requested amount
  v_total_servings := v_qty_containers * COALESCE(v_product.servings_per_container, 1);
  v_cal := v_total_servings * COALESCE(v_product.calories_per_serving, 0);
  v_carbs := v_total_servings * COALESCE(v_product.carbs_per_serving, 0);
  v_protein := v_total_servings * COALESCE(v_product.protein_per_serving, 0);
  v_fat := v_total_servings * COALESCE(v_product.fat_per_serving, 0);

  -- Soft gate: suspiciously high calorie load requires explicit confirm
  IF v_cal > SOFT_CAL_CEILING AND COALESCE(p_confirm_large_amount, FALSE) IS NOT TRUE THEN
    RAISE EXCEPTION
      'Suspicious amount: qty % % would log % calories (threshold %). Pass confirm_large_amount=true to proceed if intentional.',
      p_qty, p_unit, v_cal, SOFT_CAL_CEILING;
  END IF;

  -- Deplete stock lots in FIFO order (nearest expiration first)
  v_remaining := v_qty_containers;

  FOR v_lot IN
    SELECT lot_id, qty_containers
    FROM chefbyte.stock_lots
    WHERE user_id = p_user_id AND product_id = p_product_id
    ORDER BY expires_on ASC NULLS LAST
  LOOP
    EXIT WHEN v_remaining <= 0;

    IF v_lot.qty_containers <= v_remaining THEN
      v_remaining := v_remaining - v_lot.qty_containers;
      DELETE FROM chefbyte.stock_lots WHERE lot_id = v_lot.lot_id;
    ELSE
      UPDATE chefbyte.stock_lots
      SET qty_containers = qty_containers - v_remaining
      WHERE lot_id = v_lot.lot_id;
      v_remaining := 0;
    END IF;
  END LOOP;

  -- Log macros if requested
  IF p_log_macros THEN
    INSERT INTO chefbyte.food_logs (
      user_id, product_id, logical_date,
      qty_consumed, unit, calories, carbs, protein, fat
    ) VALUES (
      p_user_id, p_product_id, p_logical_date,
      p_qty, v_stored_unit, v_cal, v_carbs, v_protein, v_fat
    );
  END IF;

  SELECT COALESCE(SUM(qty_containers), 0) INTO v_stock_remaining
  FROM chefbyte.stock_lots
  WHERE user_id = p_user_id AND product_id = p_product_id;

  RETURN jsonb_build_object(
    'success', true,
    'qty_consumed', p_qty,
    'macros', jsonb_build_object(
      'calories', v_cal,
      'carbs', v_carbs,
      'protein', v_protein,
      'fat', v_fat
    ),
    'stock_remaining', v_stock_remaining
  );
END;
$$;

-- Refresh the authenticated (RLS-path) wrapper too, so the web UI can
-- opt into the confirm flag when needed (batch meal-prep scanner flows).
-- Old 5-arg call sites still work via the DEFAULT FALSE.
DROP FUNCTION IF EXISTS chefbyte.consume_product(UUID, NUMERIC, TEXT, BOOLEAN, DATE);

CREATE OR REPLACE FUNCTION chefbyte.consume_product(
  p_product_id UUID,
  p_qty NUMERIC,
  p_unit TEXT,
  p_log_macros BOOLEAN,
  p_logical_date DATE,
  p_confirm_large_amount BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.consume_product(
    (SELECT auth.uid()), p_product_id, p_qty, p_unit, p_log_macros, p_logical_date, p_confirm_large_amount
  );
$$;
GRANT EXECUTE ON FUNCTION chefbyte.consume_product(UUID, NUMERIC, TEXT, BOOLEAN, DATE, BOOLEAN) TO authenticated;

-- Refresh admin wrapper to expose the new parameter. The old 6-arg
-- overload is dropped to avoid ambiguous resolution — any caller that
-- provided only 6 args automatically binds to the new 7-arg function
-- via its DEFAULT FALSE on p_confirm_large_amount.
DROP FUNCTION IF EXISTS chefbyte.consume_product_admin(UUID, UUID, NUMERIC, TEXT, BOOLEAN, DATE);

CREATE OR REPLACE FUNCTION chefbyte.consume_product_admin(
  p_user_id UUID,
  p_product_id UUID,
  p_qty NUMERIC,
  p_unit TEXT,
  p_log_macros BOOLEAN,
  p_logical_date DATE,
  p_confirm_large_amount BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.consume_product(
    p_user_id, p_product_id, p_qty, p_unit, p_log_macros, p_logical_date, p_confirm_large_amount
  );
$$;
GRANT EXECUTE ON FUNCTION chefbyte.consume_product_admin(UUID, UUID, NUMERIC, TEXT, BOOLEAN, DATE, BOOLEAN) TO service_role;

COMMIT;
