-- update_food_log_qty: edit qty on a logged consumed item.
--
-- Audit finding (UX_AUDIT_CHEFBYTE_USE): every consumed item / food_log
-- /temp item is delete-and-re-create. For a disciplined logger this is
-- the friction that decays the habit fastest — "I ate 1.5 servings, not
-- 2" should be a one-tap edit, not a delete + retype.
--
-- This RPC:
--   * Validates the log row exists and belongs to the caller.
--   * Recomputes calories/protein/carbs/fat by scaling the existing row's
--     macros — this preserves any per-row macro overrides (event override
--     migration). Falls back to the product's per-serving macros when
--     the existing qty is 0 (defensive — should never happen since
--     food_logs.qty_consumed has NOT NULL + > 0 invariants).
--
-- Security: SECURITY DEFINER + search_path = '' + explicit owner check.
-- The qty must be > 0 (use the existing DELETE flow to remove a row).

BEGIN;

CREATE OR REPLACE FUNCTION private.update_food_log_qty(
  p_user_id UUID,
  p_log_id UUID,
  p_new_qty NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_log RECORD;
  v_product RECORD;
  v_scale NUMERIC(10,6);
  v_new_cal NUMERIC(10,3);
  v_new_protein NUMERIC(10,3);
  v_new_carbs NUMERIC(10,3);
  v_new_fat NUMERIC(10,3);
BEGIN
  IF p_user_id IS NULL OR p_log_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id and p_log_id required';
  END IF;
  IF p_new_qty IS NULL OR p_new_qty <= 0 THEN
    RAISE EXCEPTION 'p_new_qty must be > 0 (delete the log to remove it)';
  END IF;

  SELECT * INTO v_log
  FROM chefbyte.food_logs
  WHERE log_id = p_log_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Food log not found or not owned by user';
  END IF;

  -- Scale the existing macros. Preserves any per-row overrides (e.g. an
  -- event override that shaved calories on this specific log).
  IF v_log.qty_consumed > 0 THEN
    v_scale := p_new_qty / v_log.qty_consumed;
    v_new_cal     := ROUND(v_log.calories::NUMERIC * v_scale, 3);
    v_new_protein := ROUND(v_log.protein::NUMERIC  * v_scale, 3);
    v_new_carbs   := ROUND(v_log.carbs::NUMERIC    * v_scale, 3);
    v_new_fat     := ROUND(v_log.fat::NUMERIC      * v_scale, 3);
  ELSE
    -- Defensive fallback — recompute from product's per-serving macros.
    SELECT * INTO v_product
    FROM chefbyte.products
    WHERE product_id = v_log.product_id AND user_id = p_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product for this log no longer exists';
    END IF;

    DECLARE
      v_total_servings NUMERIC(10,3);
    BEGIN
      IF v_log.unit = 'serving' THEN
        v_total_servings := p_new_qty;
      ELSE
        v_total_servings := p_new_qty * COALESCE(v_product.servings_per_container, 1);
      END IF;
      v_new_cal     := v_total_servings * COALESCE(v_product.calories_per_serving, 0);
      v_new_protein := v_total_servings * COALESCE(v_product.protein_per_serving, 0);
      v_new_carbs   := v_total_servings * COALESCE(v_product.carbs_per_serving, 0);
      v_new_fat     := v_total_servings * COALESCE(v_product.fat_per_serving, 0);
    END;
  END IF;

  UPDATE chefbyte.food_logs
     SET qty_consumed = p_new_qty,
         calories     = v_new_cal,
         protein      = v_new_protein,
         carbs        = v_new_carbs,
         fat          = v_new_fat
   WHERE log_id = p_log_id AND user_id = p_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'log_id', p_log_id,
    'qty_consumed', p_new_qty,
    'macros', jsonb_build_object(
      'calories', v_new_cal,
      'protein',  v_new_protein,
      'carbs',    v_new_carbs,
      'fat',      v_new_fat
    )
  );
END;
$$;

-- Thin chefbyte-schema wrapper so authenticated users can call via RPC
-- without leaking auth.uid() into the private signature.
CREATE OR REPLACE FUNCTION chefbyte.update_food_log_qty(
  p_log_id UUID,
  p_new_qty NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := (SELECT auth.uid());
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  RETURN private.update_food_log_qty(v_user_id, p_log_id, p_new_qty);
END;
$$;

GRANT EXECUTE ON FUNCTION chefbyte.update_food_log_qty(UUID, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION private.update_food_log_qty(UUID, UUID, NUMERIC) TO service_role;

-- Same shape for temp_items — these don't have a product join so we just
-- scale the existing macros uniformly.
CREATE OR REPLACE FUNCTION private.update_temp_item_qty(
  p_user_id UUID,
  p_temp_id UUID,
  p_scale NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_temp RECORD;
  v_new_cal NUMERIC(10,3);
  v_new_protein NUMERIC(10,3);
  v_new_carbs NUMERIC(10,3);
  v_new_fat NUMERIC(10,3);
BEGIN
  IF p_user_id IS NULL OR p_temp_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id and p_temp_id required';
  END IF;
  IF p_scale IS NULL OR p_scale <= 0 THEN
    RAISE EXCEPTION 'p_scale must be > 0';
  END IF;

  SELECT * INTO v_temp
  FROM chefbyte.temp_items
  WHERE temp_id = p_temp_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Temp item not found or not owned by user';
  END IF;

  v_new_cal     := ROUND(v_temp.calories::NUMERIC * p_scale, 3);
  v_new_protein := ROUND(v_temp.protein::NUMERIC  * p_scale, 3);
  v_new_carbs   := ROUND(v_temp.carbs::NUMERIC    * p_scale, 3);
  v_new_fat     := ROUND(v_temp.fat::NUMERIC      * p_scale, 3);

  UPDATE chefbyte.temp_items
     SET calories = v_new_cal,
         protein  = v_new_protein,
         carbs    = v_new_carbs,
         fat      = v_new_fat
   WHERE temp_id = p_temp_id AND user_id = p_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'temp_id', p_temp_id,
    'macros', jsonb_build_object(
      'calories', v_new_cal,
      'protein',  v_new_protein,
      'carbs',    v_new_carbs,
      'fat',      v_new_fat
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION chefbyte.update_temp_item_qty(
  p_temp_id UUID,
  p_scale NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := (SELECT auth.uid());
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  RETURN private.update_temp_item_qty(v_user_id, p_temp_id, p_scale);
END;
$$;

GRANT EXECUTE ON FUNCTION chefbyte.update_temp_item_qty(UUID, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION private.update_temp_item_qty(UUID, UUID, NUMERIC) TO service_role;

COMMIT;
