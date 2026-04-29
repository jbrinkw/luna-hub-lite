-- unmark_meal_done_gram_unit: document + harden gram-unit restore path
--
-- The restore path in private.unmark_meal_done reads back food_logs rows
-- that were written by consume_product.  Because mark_meal_done (updated in
-- 20260429230000) pre-converts gram quantities to containers before calling
-- consume_product, all food_logs rows are already stored with unit='container'.
-- The existing restore math (container → stock_lots directly) is therefore
-- already correct for gram-origin ingredients.
--
-- This migration re-declares private.unmark_meal_done with an explicit comment
-- documenting that invariant, and adds a GREATEST guard on qty_containers to
-- match the floor-at-0 behavior called out in the spec.

BEGIN;

CREATE OR REPLACE FUNCTION private.unmark_meal_done(
  p_user_id UUID,
  p_meal_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_meal RECORD;
  v_log RECORD;
  v_location_id UUID;
  v_deleted_logs INT := 0;
  v_restored_stock INT := 0;
  v_deleted_meal_product BOOLEAN := false;
BEGIN
  -- Fetch meal entry and verify ownership
  SELECT * INTO v_meal
  FROM chefbyte.meal_plan_entries
  WHERE meal_id = p_meal_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Meal not found or not owned by user';
  END IF;

  -- Must be completed to undo
  IF v_meal.completed_at IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Meal is not completed'
    );
  END IF;

  -- Get default location for stock restoration
  SELECT location_id INTO v_location_id
  FROM chefbyte.locations
  WHERE user_id = p_user_id
  ORDER BY created_at ASC
  LIMIT 1;

  -- Restore stock from food_logs tagged with this meal_id.
  --
  -- Gram-unit ingredients: mark_meal_done converts grams → containers before
  -- calling consume_product, so food_logs.unit is always 'container' or
  -- 'serving' — never 'gram'.  The restore math below handles both correctly
  -- without any gram-specific branch.
  FOR v_log IN
    SELECT product_id, qty_consumed, unit
    FROM chefbyte.food_logs
    WHERE meal_id = p_meal_id AND user_id = p_user_id
  LOOP
    DECLARE
      v_qty_containers NUMERIC(10,3);
      v_spc NUMERIC(10,3);
    BEGIN
      SELECT GREATEST(servings_per_container, 0.001) INTO v_spc
      FROM chefbyte.products
      WHERE product_id = v_log.product_id AND user_id = p_user_id;

      IF v_log.unit = 'serving' THEN
        v_qty_containers := v_log.qty_consumed / COALESCE(v_spc, 1);
      ELSE
        -- 'container' (includes gram-origin rows which were stored as containers)
        v_qty_containers := v_log.qty_consumed;
      END IF;

      -- Floor at 0: don't restore negative stock (defensive guard).
      v_qty_containers := GREATEST(v_qty_containers, 0);

      -- Restore stock (upsert into existing lot with NULL expires_on)
      IF v_location_id IS NOT NULL AND v_qty_containers > 0 THEN
        INSERT INTO chefbyte.stock_lots (
          user_id, product_id, location_id,
          qty_containers, expires_on
        ) VALUES (
          p_user_id, v_log.product_id, v_location_id,
          v_qty_containers, NULL
        )
        ON CONFLICT (user_id, product_id, location_id, COALESCE(expires_on, '9999-12-31'::date))
        DO UPDATE SET qty_containers = chefbyte.stock_lots.qty_containers + v_qty_containers;

        v_restored_stock := v_restored_stock + 1;
      END IF;
    END;
  END LOOP;

  -- Delete food_logs for this meal
  DELETE FROM chefbyte.food_logs
  WHERE meal_id = p_meal_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_deleted_logs = ROW_COUNT;

  -- For meal prep: delete the [MEAL] product created by this meal
  IF v_meal.meal_prep THEN
    DECLARE
      v_meal_name TEXT;
      v_expected_prefix TEXT;
    BEGIN
      IF v_meal.recipe_id IS NOT NULL THEN
        SELECT name INTO v_meal_name
        FROM chefbyte.recipes
        WHERE recipe_id = v_meal.recipe_id AND user_id = p_user_id;
      ELSIF v_meal.product_id IS NOT NULL THEN
        SELECT name INTO v_meal_name
        FROM chefbyte.products
        WHERE product_id = v_meal.product_id AND user_id = p_user_id;
      END IF;

      IF v_meal_name IS NOT NULL THEN
        v_expected_prefix := '[MEAL] ' || v_meal_name || ' ' || to_char(v_meal.logical_date, 'MM-DD');

        DELETE FROM chefbyte.stock_lots
        WHERE product_id IN (
          SELECT product_id FROM chefbyte.products
          WHERE user_id = p_user_id AND name = v_expected_prefix
        );

        DELETE FROM chefbyte.products
        WHERE user_id = p_user_id AND name = v_expected_prefix;

        v_deleted_meal_product := true;
      END IF;
    END;
  END IF;

  -- Clear completed_at
  UPDATE chefbyte.meal_plan_entries
  SET completed_at = NULL
  WHERE meal_id = p_meal_id;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_logs', v_deleted_logs,
    'restored_stock', v_restored_stock,
    'deleted_meal_product', v_deleted_meal_product
  );
END;
$$;

COMMIT;
