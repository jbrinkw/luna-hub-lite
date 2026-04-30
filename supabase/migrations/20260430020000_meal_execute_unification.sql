-- meal_execute_unification: zero-shorts logic for mark_meal_done
--
-- RATIONALE:
--   User feedback:
--     1. Meal-prep entries should show ONE button ("Execute") not two
--        ("Mark Done" + "Execute Prep") — they are the same action.
--     2. Insufficient stock must not block completion. Instead: take
--        MIN(needed, available) per ingredient, log macros for what was
--        actually consumed, complete the meal unconditionally, and return
--        a `partials` array so the UI can display "milk: 0 of 100 g — out
--        of stock".
--
--   Changes to private.mark_meal_done:
--     * Remove the pre-check RAISE loop entirely.
--     * In the mutation loop, compute v_actual_containers =
--       MIN(v_needed_containers, v_stock_available). Pass that to
--       consume_product (which already floors stock at 0 and uses the
--       clamped quantity). Macros accumulate from actual, not planned.
--     * Append to v_partials whenever actual < needed.
--     * Return payload gains `partials: [{product_id, needed, available}]`.
--     * Legacy fields (success, meal_id, mode, deducted, food_log_ids,
--       completed_at) preserved for backward compat.
--
--   NOTE: consume_product already handles qty > stock gracefully — it
--   drains all lots to 0 and doesn't error. We still clamp at the DB
--   level so macros log the actual, not the over-requested amount.

BEGIN;

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
  v_meal         RECORD;
  v_recipe       RECORD;
  v_ingredient   RECORD;
  v_consume_result JSONB;
  v_logical_date DATE;
  v_meal_product_id   UUID;
  v_meal_product_name TEXT;
  v_total_cal    NUMERIC(10,3) := 0;
  v_total_carbs  NUMERIC(10,3) := 0;
  v_total_protein NUMERIC(10,3) := 0;
  v_total_fat    NUMERIC(10,3) := 0;
  v_location_id  UUID;
  v_completed_at TIMESTAMPTZ;
  v_scale_factor NUMERIC(10,3);
  v_stock_available   NUMERIC(10,3);
  v_needed_containers NUMERIC(10,3);
  v_actual_containers NUMERIC(10,3);
  v_mode         TEXT;
  v_deducted     JSONB := '[]'::jsonb;
  v_partials     JSONB := '[]'::jsonb;
  v_food_log_ids JSONB := '[]'::jsonb;
  v_new_log_ids  UUID[];
  v_product      RECORD;
  v_net_weight_g NUMERIC(10,3);
BEGIN
  -- ------------------------------------------------------------------
  -- Lock + validate the meal_plan_entry row.
  -- ------------------------------------------------------------------
  SELECT * INTO v_meal
  FROM chefbyte.meal_plan_entries
  WHERE meal_id = p_meal_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Meal not found or not owned by user';
  END IF;

  IF v_meal.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Meal already completed';
  END IF;

  v_logical_date := v_meal.logical_date;

  -- ------------------------------------------------------------------
  -- Branch 1: Recipe-based meal
  -- ------------------------------------------------------------------
  IF v_meal.recipe_id IS NOT NULL THEN
    SELECT * INTO v_recipe
    FROM chefbyte.recipes
    WHERE recipe_id = v_meal.recipe_id AND user_id = p_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Recipe not found or not owned by user';
    END IF;

    v_scale_factor := v_meal.servings / GREATEST(v_recipe.base_servings, 0.001);
    v_mode := CASE WHEN v_meal.meal_prep THEN 'meal_prep' ELSE 'recipe' END;

    FOR v_ingredient IN
      SELECT ri.product_id, ri.quantity, ri.unit, p.name AS product_name,
             COALESCE(p.servings_per_container, 1) AS spc,
             p.net_weight_g
      FROM chefbyte.recipe_ingredients ri
      JOIN chefbyte.products p ON p.product_id = ri.product_id
      WHERE ri.recipe_id = v_meal.recipe_id AND ri.user_id = p_user_id
    LOOP
      -- Compute needed in containers.
      IF v_ingredient.unit = 'serving' THEN
        v_needed_containers := (v_ingredient.quantity * v_scale_factor)
                               / GREATEST(v_ingredient.spc, 0.001);
      ELSIF v_ingredient.unit = 'gram' THEN
        IF v_ingredient.net_weight_g IS NULL OR v_ingredient.net_weight_g <= 0 THEN
          RAISE EXCEPTION 'product missing net_weight_g for ingredient %',
            v_ingredient.product_name;
        END IF;
        v_needed_containers := (v_ingredient.quantity * v_scale_factor)
                               / v_ingredient.net_weight_g;
      ELSE
        -- 'container'
        v_needed_containers := v_ingredient.quantity * v_scale_factor;
      END IF;

      -- How much is actually available?
      SELECT COALESCE(SUM(qty_containers), 0) INTO v_stock_available
      FROM chefbyte.stock_lots
      WHERE user_id = p_user_id AND product_id = v_ingredient.product_id;

      -- Zero-shorts: take what is available, log a partial if short.
      v_actual_containers := LEAST(v_needed_containers, v_stock_available);

      IF v_stock_available < v_needed_containers THEN
        v_partials := v_partials || jsonb_build_object(
          'product_id', v_ingredient.product_id,
          'needed',     v_needed_containers,
          'available',  v_stock_available
        );
      END IF;

      -- Only consume if there is anything to take.
      IF v_actual_containers > 0 THEN
        v_consume_result := private.consume_product(
          p_user_id,
          v_ingredient.product_id,
          v_actual_containers,
          'container',
          NOT v_meal.meal_prep,
          v_logical_date,
          TRUE
        );
      ELSE
        -- Nothing in stock: skip consume, macros stay 0 for this ingredient.
        v_consume_result := jsonb_build_object(
          'success', true,
          'qty_consumed', 0,
          'macros', jsonb_build_object('calories',0,'carbs',0,'protein',0,'fat',0),
          'stock_remaining', 0
        );
      END IF;

      v_deducted := v_deducted || jsonb_build_object(
        'product_id', v_ingredient.product_id,
        'qty',        v_actual_containers,
        'unit',       'container'
      );

      IF v_meal.meal_prep THEN
        v_total_cal     := v_total_cal     + COALESCE((v_consume_result->'macros'->>'calories')::numeric, 0);
        v_total_carbs   := v_total_carbs   + COALESCE((v_consume_result->'macros'->>'carbs')::numeric, 0);
        v_total_protein := v_total_protein + COALESCE((v_consume_result->'macros'->>'protein')::numeric, 0);
        v_total_fat     := v_total_fat     + COALESCE((v_consume_result->'macros'->>'fat')::numeric, 0);
      END IF;
    END LOOP;

    IF v_meal.meal_prep THEN
      v_meal_product_name := private.generate_meal_product_name(
        p_user_id, v_recipe.name, v_logical_date
      );

      INSERT INTO chefbyte.products (
        user_id, name,
        servings_per_container,
        calories_per_serving,
        carbs_per_serving,
        protein_per_serving,
        fat_per_serving,
        is_placeholder,
        is_distinct_unit_item,
        default_recipe_unit
      ) VALUES (
        p_user_id,
        v_meal_product_name,
        v_meal.servings,
        v_total_cal     / GREATEST(v_meal.servings, 0.001),
        v_total_carbs   / GREATEST(v_meal.servings, 0.001),
        v_total_protein / GREATEST(v_meal.servings, 0.001),
        v_total_fat     / GREATEST(v_meal.servings, 0.001),
        false,
        true,
        'serving'
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

  -- ------------------------------------------------------------------
  -- Branch 2: Product-based meal (no recipe)
  -- ------------------------------------------------------------------
  ELSIF v_meal.product_id IS NOT NULL THEN
    v_mode := CASE WHEN v_meal.meal_prep THEN 'meal_prep' ELSE 'product' END;

    SELECT * INTO v_product
    FROM chefbyte.products
    WHERE product_id = v_meal.product_id AND user_id = p_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or not owned by user';
    END IF;

    -- Needed in containers (meal.servings is in servings).
    v_needed_containers := v_meal.servings
                           / GREATEST(COALESCE(v_product.servings_per_container, 1), 0.001);

    SELECT COALESCE(SUM(qty_containers), 0) INTO v_stock_available
    FROM chefbyte.stock_lots
    WHERE user_id = p_user_id AND product_id = v_meal.product_id;

    -- Zero-shorts.
    v_actual_containers := LEAST(v_needed_containers, v_stock_available);

    IF v_stock_available < v_needed_containers THEN
      v_partials := v_partials || jsonb_build_object(
        'product_id', v_meal.product_id,
        'needed',     v_needed_containers,
        'available',  v_stock_available
      );
    END IF;

    IF v_actual_containers > 0 THEN
      v_consume_result := private.consume_product(
        p_user_id,
        v_meal.product_id,
        v_actual_containers,
        'container',
        NOT v_meal.meal_prep,
        v_logical_date,
        TRUE
      );
    ELSE
      v_consume_result := jsonb_build_object(
        'success', true,
        'qty_consumed', 0,
        'macros', jsonb_build_object('calories',0,'carbs',0,'protein',0,'fat',0),
        'stock_remaining', 0
      );
    END IF;

    v_deducted := v_deducted || jsonb_build_object(
      'product_id', v_meal.product_id,
      'qty',        v_actual_containers,
      'unit',       'container'
    );

    IF v_meal.meal_prep THEN
      v_meal_product_name := private.generate_meal_product_name(
        p_user_id, v_product.name, v_logical_date
      );

      v_total_cal     := COALESCE((v_consume_result->'macros'->>'calories')::numeric, 0);
      v_total_carbs   := COALESCE((v_consume_result->'macros'->>'carbs')::numeric, 0);
      v_total_protein := COALESCE((v_consume_result->'macros'->>'protein')::numeric, 0);
      v_total_fat     := COALESCE((v_consume_result->'macros'->>'fat')::numeric, 0);

      INSERT INTO chefbyte.products (
        user_id, name,
        servings_per_container,
        calories_per_serving,
        carbs_per_serving,
        protein_per_serving,
        fat_per_serving,
        is_placeholder,
        is_distinct_unit_item,
        default_recipe_unit
      ) VALUES (
        p_user_id,
        v_meal_product_name,
        v_meal.servings,
        v_total_cal     / GREATEST(v_meal.servings, 0.001),
        v_total_carbs   / GREATEST(v_meal.servings, 0.001),
        v_total_protein / GREATEST(v_meal.servings, 0.001),
        v_total_fat     / GREATEST(v_meal.servings, 0.001),
        false,
        true,
        'serving'
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
  END IF;

  -- ------------------------------------------------------------------
  -- Mark meal completed + tag food_logs with meal_id for unmark support.
  -- ------------------------------------------------------------------
  v_completed_at := now();
  UPDATE chefbyte.meal_plan_entries
  SET completed_at = v_completed_at
  WHERE meal_id = p_meal_id;

  UPDATE chefbyte.food_logs
  SET meal_id = p_meal_id
  WHERE user_id = p_user_id
    AND meal_id IS NULL
    AND created_at = now();

  SELECT array_agg(log_id) INTO v_new_log_ids
  FROM chefbyte.food_logs
  WHERE user_id = p_user_id AND meal_id = p_meal_id;

  IF v_new_log_ids IS NOT NULL THEN
    v_food_log_ids := to_jsonb(v_new_log_ids);
  END IF;

  RETURN jsonb_build_object(
    'success',      true,
    'meal_id',      p_meal_id,
    'mode',         v_mode,
    'deducted',     v_deducted,
    'partials',     v_partials,
    'food_log_ids', v_food_log_ids,
    'completed_at', v_completed_at
  );
END;
$$;

COMMIT;
