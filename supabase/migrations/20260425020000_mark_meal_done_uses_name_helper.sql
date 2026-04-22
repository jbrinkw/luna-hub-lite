-- Wire private.mark_meal_done to private.generate_meal_product_name
--
-- Agent A (migration 20260424090000_invariant_batch) created
--   private.generate_meal_product_name(p_user_id, p_base_name, p_logical_date)
-- which returns a collision-free name by appending HH:MM or HH:MM:SS when
-- the base `[MEAL] <name> MM-DD` already exists. The intent: marking the
-- same recipe as meal_prep twice on the same day should produce two
-- distinct [MEAL] products rather than failing on name UNIQUE.
--
-- Agent 1 (migration 20260424070000_mark_meal_done_atomic) landed the
-- atomic mark_meal_done with the OLD inline string concat
--   v_meal_product_name := '[MEAL] ' || v_recipe.name || ' ' ||
--                          to_char(v_logical_date, 'MM-DD')
-- at two call sites (recipe branch + product branch).
--
-- This migration replaces the full mark_meal_done body with the ONE change:
-- both naming call sites now use the helper. Everything else verbatim.
--
-- The helper's TODO note in 20260424090000 is discharged by this migration.

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
  v_stock_available NUMERIC(10,3);
  v_needed_containers NUMERIC(10,3);
  v_mode TEXT;
  v_deducted JSONB := '[]'::jsonb;
  v_food_log_ids JSONB := '[]'::jsonb;
  v_new_log_ids UUID[];
  v_product RECORD;
BEGIN
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
             COALESCE(p.servings_per_container, 1) AS spc
      FROM chefbyte.recipe_ingredients ri
      JOIN chefbyte.products p ON p.product_id = ri.product_id
      WHERE ri.recipe_id = v_meal.recipe_id AND ri.user_id = p_user_id
    LOOP
      IF v_ingredient.unit = 'serving' THEN
        v_needed_containers := (v_ingredient.quantity * v_scale_factor)
                               / GREATEST(v_ingredient.spc, 0.001);
      ELSE
        v_needed_containers := v_ingredient.quantity * v_scale_factor;
      END IF;

      SELECT COALESCE(SUM(qty_containers), 0) INTO v_stock_available
      FROM chefbyte.stock_lots
      WHERE user_id = p_user_id AND product_id = v_ingredient.product_id;

      IF v_stock_available < v_needed_containers THEN
        RAISE EXCEPTION
          'Insufficient stock for %: need % containers, have %',
          v_ingredient.product_name, v_needed_containers, v_stock_available;
      END IF;
    END LOOP;

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
        v_logical_date,
        TRUE
      );

      v_deducted := v_deducted || jsonb_build_object(
        'product_id', v_ingredient.product_id,
        'qty', v_ingredient.quantity * v_scale_factor,
        'unit', v_ingredient.unit
      );

      IF v_meal.meal_prep THEN
        v_total_cal := v_total_cal + COALESCE((v_consume_result->'macros'->>'calories')::numeric, 0);
        v_total_carbs := v_total_carbs + COALESCE((v_consume_result->'macros'->>'carbs')::numeric, 0);
        v_total_protein := v_total_protein + COALESCE((v_consume_result->'macros'->>'protein')::numeric, 0);
        v_total_fat := v_total_fat + COALESCE((v_consume_result->'macros'->>'fat')::numeric, 0);
      END IF;
    END LOOP;

    IF v_meal.meal_prep THEN
      -- CHANGED: use the helper so a second meal_prep of the same recipe
      -- on the same day doesn't hit products (user_id, name) UNIQUE.
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

  ELSIF v_meal.product_id IS NOT NULL THEN
    v_mode := CASE WHEN v_meal.meal_prep THEN 'meal_prep' ELSE 'product' END;

    SELECT * INTO v_product
    FROM chefbyte.products
    WHERE product_id = v_meal.product_id AND user_id = p_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or not owned by user';
    END IF;

    v_needed_containers := v_meal.servings
                           / GREATEST(COALESCE(v_product.servings_per_container, 1), 0.001);

    SELECT COALESCE(SUM(qty_containers), 0) INTO v_stock_available
    FROM chefbyte.stock_lots
    WHERE user_id = p_user_id AND product_id = v_meal.product_id;

    IF v_stock_available < v_needed_containers THEN
      RAISE EXCEPTION
        'Insufficient stock for %: need % containers, have %',
        v_product.name, v_needed_containers, v_stock_available;
    END IF;

    v_consume_result := private.consume_product(
      p_user_id,
      v_meal.product_id,
      v_meal.servings,
      'serving',
      NOT v_meal.meal_prep,
      v_logical_date,
      TRUE
    );

    v_deducted := v_deducted || jsonb_build_object(
      'product_id', v_meal.product_id,
      'qty', v_meal.servings,
      'unit', 'serving'
    );

    IF v_meal.meal_prep THEN
      -- CHANGED: helper, same reason.
      v_meal_product_name := private.generate_meal_product_name(
        p_user_id, v_product.name, v_logical_date
      );

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
    END IF;
  END IF;

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
    'success', true,
    'meal_id', p_meal_id,
    'mode', v_mode,
    'deducted', v_deducted,
    'food_log_ids', v_food_log_ids,
    'completed_at', v_completed_at
  );
END;
$$;

COMMIT;
