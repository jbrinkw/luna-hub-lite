-- Fix: normalize unit to 'container' when not 'serving' in consume_product
-- Prevents CHECK constraint violation on food_logs.unit when caller passes
-- an unrecognized unit like 'box'. The function already treats non-'serving'
-- units as containers for quantity conversion; this just aligns the stored value.

CREATE OR REPLACE FUNCTION private.consume_product(
  p_user_id UUID,
  p_product_id UUID,
  p_qty NUMERIC,
  p_unit TEXT,
  p_log_macros BOOLEAN,
  p_logical_date DATE
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
BEGIN
  -- Validate positive quantity
  IF p_qty <= 0 THEN
    RAISE EXCEPTION 'Quantity must be positive, got %', p_qty;
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
