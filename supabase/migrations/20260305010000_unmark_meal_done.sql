-- Add unmark_meal_done: undo a completed meal by reversing macros and restoring stock.
-- Also fix mark_meal_done to tag food_logs with meal_id for traceability.

------------------------------------------------------------
-- 1. Update mark_meal_done to tag food_logs with meal_id
------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.mark_meal_done(
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
  v_recipe RECORD;
  v_ingredient RECORD;
  v_consume_result JSONB;
  v_logical_date DATE;
  v_meal_product_id UUID;
  v_meal_product_name TEXT;
  v_total_cal NUMERIC(10,3) := 0;
  v_total_carbs NUMERIC(10,3) := 0;
  v_total_protein NUMERIC(10,3) := 0;
  v_total_fat NUMERIC(10,3) := 0;
  v_location_id UUID;
  v_completed_at TIMESTAMPTZ;
  v_scale_factor NUMERIC(10,3);
BEGIN
  -- Fetch meal entry and verify ownership
  SELECT * INTO v_meal
  FROM chefbyte.meal_plan_entries
  WHERE meal_id = p_meal_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Meal not found or not owned by user';
  END IF;

  -- Check if already completed
  IF v_meal.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Meal already completed'
    );
  END IF;

  -- Use the meal's logical_date directly (it's stored on the entry)
  v_logical_date := v_meal.logical_date;

  -- Recipe-based meal
  IF v_meal.recipe_id IS NOT NULL THEN
    -- Fetch recipe for name and base_servings
    SELECT * INTO v_recipe
    FROM chefbyte.recipes
    WHERE recipe_id = v_meal.recipe_id AND user_id = p_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Recipe not found or not owned by user';
    END IF;

    -- Scale factor = meal.servings / recipe.base_servings
    v_scale_factor := v_meal.servings / GREATEST(v_recipe.base_servings, 0.001);

    -- Process each ingredient
    FOR v_ingredient IN
      SELECT ri.product_id, ri.quantity, ri.unit
      FROM chefbyte.recipe_ingredients ri
      WHERE ri.recipe_id = v_meal.recipe_id AND ri.user_id = p_user_id
    LOOP
      v_consume_result := private.consume_product(
        p_user_id,
        v_ingredient.product_id,
        v_ingredient.quantity * v_scale_factor,
        v_ingredient.unit,
        NOT v_meal.meal_prep,
        v_logical_date
      );

      -- Accumulate total macros for meal-prep product creation
      IF v_meal.meal_prep THEN
        v_total_cal := v_total_cal + COALESCE((v_consume_result->'macros'->>'calories')::numeric, 0);
        v_total_carbs := v_total_carbs + COALESCE((v_consume_result->'macros'->>'carbs')::numeric, 0);
        v_total_protein := v_total_protein + COALESCE((v_consume_result->'macros'->>'protein')::numeric, 0);
        v_total_fat := v_total_fat + COALESCE((v_consume_result->'macros'->>'fat')::numeric, 0);
      END IF;
    END LOOP;

    -- Meal prep: create [MEAL] product + stock lot
    IF v_meal.meal_prep THEN
      v_meal_product_name := '[MEAL] ' || v_recipe.name || ' ' || to_char(v_logical_date, 'MM-DD');

      INSERT INTO chefbyte.products (
        user_id, name,
        servings_per_container,
        calories_per_serving,
        carbs_per_serving,
        protein_per_serving,
        fat_per_serving,
        is_placeholder
      ) VALUES (
        p_user_id,
        v_meal_product_name,
        v_meal.servings,
        v_total_cal / GREATEST(v_meal.servings, 0.001),
        v_total_carbs / GREATEST(v_meal.servings, 0.001),
        v_total_protein / GREATEST(v_meal.servings, 0.001),
        v_total_fat / GREATEST(v_meal.servings, 0.001),
        false
      )
      RETURNING product_id INTO v_meal_product_id;

      SELECT location_id INTO v_location_id
      FROM chefbyte.locations
      WHERE user_id = p_user_id
      ORDER BY created_at ASC
      LIMIT 1;

      IF v_location_id IS NULL THEN
        RAISE EXCEPTION 'No storage locations found for user';
      END IF;

      INSERT INTO chefbyte.stock_lots (
        user_id, product_id, location_id,
        qty_containers, expires_on
      ) VALUES (
        p_user_id, v_meal_product_id, v_location_id,
        1, v_logical_date + 7
      )
      ON CONFLICT (user_id, product_id, location_id, COALESCE(expires_on, '9999-12-31'::date))
      DO UPDATE SET qty_containers = chefbyte.stock_lots.qty_containers + 1;
    END IF;

  -- Product-based meal (no recipe)
  ELSIF v_meal.product_id IS NOT NULL THEN
    v_consume_result := private.consume_product(
      p_user_id,
      v_meal.product_id,
      v_meal.servings,
      'serving',
      NOT v_meal.meal_prep,
      v_logical_date
    );

    -- If product-based meal prep, create [MEAL] product + lot
    IF v_meal.meal_prep THEN
      DECLARE
        v_source_product RECORD;
      BEGIN
        SELECT * INTO v_source_product
        FROM chefbyte.products
        WHERE product_id = v_meal.product_id AND user_id = p_user_id;

        v_meal_product_name := '[MEAL] ' || v_source_product.name || ' ' || to_char(v_logical_date, 'MM-DD');

        v_total_cal := COALESCE((v_consume_result->'macros'->>'calories')::numeric, 0);
        v_total_carbs := COALESCE((v_consume_result->'macros'->>'carbs')::numeric, 0);
        v_total_protein := COALESCE((v_consume_result->'macros'->>'protein')::numeric, 0);
        v_total_fat := COALESCE((v_consume_result->'macros'->>'fat')::numeric, 0);

        INSERT INTO chefbyte.products (
          user_id, name,
          servings_per_container,
          calories_per_serving,
          carbs_per_serving,
          protein_per_serving,
          fat_per_serving,
          is_placeholder
        ) VALUES (
          p_user_id,
          v_meal_product_name,
          v_meal.servings,
          v_total_cal / GREATEST(v_meal.servings, 0.001),
          v_total_carbs / GREATEST(v_meal.servings, 0.001),
          v_total_protein / GREATEST(v_meal.servings, 0.001),
          v_total_fat / GREATEST(v_meal.servings, 0.001),
          false
        )
        RETURNING product_id INTO v_meal_product_id;

        SELECT location_id INTO v_location_id
        FROM chefbyte.locations
        WHERE user_id = p_user_id
        ORDER BY created_at ASC
        LIMIT 1;

        IF v_location_id IS NULL THEN
          RAISE EXCEPTION 'No storage locations found for user';
        END IF;

        INSERT INTO chefbyte.stock_lots (
          user_id, product_id, location_id,
          qty_containers, expires_on
        ) VALUES (
          p_user_id, v_meal_product_id, v_location_id,
          1, v_logical_date + 7
        )
        ON CONFLICT (user_id, product_id, location_id, COALESCE(expires_on, '9999-12-31'::date))
        DO UPDATE SET qty_containers = chefbyte.stock_lots.qty_containers + 1;
      END;
    END IF;
  END IF;

  -- Mark meal as completed
  v_completed_at := now();
  UPDATE chefbyte.meal_plan_entries
  SET completed_at = v_completed_at
  WHERE meal_id = p_meal_id;

  -- Tag food_logs created in this transaction with the meal_id
  -- now() is stable within a transaction, so all food_logs inserted
  -- by consume_product in this call share the same created_at.
  UPDATE chefbyte.food_logs
  SET meal_id = p_meal_id
  WHERE user_id = p_user_id
    AND meal_id IS NULL
    AND created_at = now();

  RETURN jsonb_build_object(
    'success', true,
    'completed_at', v_completed_at
  );
END;
$$;

------------------------------------------------------------
-- 2. Create unmark_meal_done (private)
------------------------------------------------------------
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

  -- Restore stock from food_logs tagged with this meal_id
  FOR v_log IN
    SELECT product_id, qty_consumed, unit
    FROM chefbyte.food_logs
    WHERE meal_id = p_meal_id AND user_id = p_user_id
  LOOP
    -- Convert back to containers for stock restoration
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
        v_qty_containers := v_log.qty_consumed;
      END IF;

      -- Restore stock (insert or upsert into existing lot)
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
  -- The [MEAL] product was created with a name pattern and around the same time
  IF v_meal.meal_prep THEN
    DECLARE
      v_meal_name TEXT;
      v_expected_prefix TEXT;
    BEGIN
      -- Get the source recipe/product name
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

        -- Delete stock lots for [MEAL] products first (FK constraint)
        DELETE FROM chefbyte.stock_lots
        WHERE product_id IN (
          SELECT product_id FROM chefbyte.products
          WHERE user_id = p_user_id AND name = v_expected_prefix
        );

        -- Delete the [MEAL] product itself
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

------------------------------------------------------------
-- 3. PostgREST wrapper
------------------------------------------------------------
CREATE OR REPLACE FUNCTION chefbyte.unmark_meal_done(p_meal_id UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.unmark_meal_done(
    (SELECT auth.uid()),
    p_meal_id
  );
$$;

GRANT EXECUTE ON FUNCTION chefbyte.unmark_meal_done(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION chefbyte.unmark_meal_done(UUID) FROM anon;

------------------------------------------------------------
-- 4. Service role wrapper for MCP
------------------------------------------------------------
CREATE OR REPLACE FUNCTION chefbyte.unmark_meal_done_admin(
  p_user_id UUID,
  p_meal_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.unmark_meal_done(p_user_id, p_meal_id);
$$;

GRANT EXECUTE ON FUNCTION chefbyte.unmark_meal_done_admin(UUID, UUID) TO service_role;
REVOKE EXECUTE ON FUNCTION chefbyte.unmark_meal_done_admin(UUID, UUID) FROM PUBLIC;
