-- mark_meal_done: tighten atomicity + stock-precheck semantics
--
-- RATIONALE:
--   The MCP handler (CHEFBYTE_mark_done) used to drive the recipe
--   ingredient loop client-side via multiple Supabase RPC calls.
--   Mid-sequence failures left partial state (stock deducted, meal not
--   yet flipped to completed); user retries double-deducted. That
--   orchestration has since moved into private.mark_meal_done — but
--   the function still had two atomicity gaps:
--
--     1. No FOR UPDATE lock on the meal row — concurrent invocations
--        (e.g. Home page + Meal Plan page racing to mark the same meal)
--        could both pass the completed_at IS NULL check and run the
--        ingredient loop twice.
--
--     2. consume_product silently floors stock at 0 and logs macros
--        anyway when stock is insufficient. This is the right behavior
--        for direct user consume flows (the user did eat the food even
--        if the Pi didn't track it), but it's WRONG for mark_meal_done
--        where "you don't have enough of ingredient X" means the meal
--        as planned cannot actually be consumed and the user needs to
--        know. Silent flooring + partial macro logging would corrupt
--        the day's totals.
--
--   This migration:
--     * Acquires a FOR UPDATE lock on the meal_plan_entry row early
--       so a concurrent call blocks until the first one commits,
--       then sees completed_at IS NOT NULL and raises.
--     * Pre-checks ingredient stock BEFORE any mutation. Raises
--       'insufficient stock for <product>' if any ingredient is short,
--       which rolls back the implicit plpgsql transaction and leaves
--       every lot untouched — the atomicity the spec requires.
--     * Returns a richer JSONB result: { success, meal_id, mode,
--       deducted: [{product_id, qty_containers}], food_log_ids }.
--       Keeps the legacy 'success' + 'completed_at' fields for
--       backward compat with any callers reading those.
--
--   Error modes all RAISE so partial state never persists:
--     - Meal not found / not owned by user
--     - Meal already completed (formerly returned success=false; now raises)
--     - Recipe not found / not owned
--     - Insufficient stock on any ingredient (recipe branch) or on the
--       product itself (product branch)
--     - User has no storage locations (meal-prep branch only)

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
  v_ingredient_spc NUMERIC(10,3);
  v_mode TEXT;
  v_deducted JSONB := '[]'::jsonb;
  v_food_log_ids JSONB := '[]'::jsonb;
  v_new_log_ids UUID[];
  v_product RECORD;
BEGIN
  -- ------------------------------------------------------------------
  -- Lock + validate the meal_plan_entry row.
  -- ------------------------------------------------------------------
  -- FOR UPDATE serializes concurrent mark_meal_done attempts on the
  -- same meal. The second caller blocks until the first commits, then
  -- sees completed_at IS NOT NULL and raises.
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

    -- Pre-check stock for every ingredient BEFORE mutating anything.
    -- Any shortfall raises and rolls back with zero side effects.
    FOR v_ingredient IN
      SELECT ri.product_id, ri.quantity, ri.unit, p.name AS product_name,
             COALESCE(p.servings_per_container, 1) AS spc
      FROM chefbyte.recipe_ingredients ri
      JOIN chefbyte.products p ON p.product_id = ri.product_id
      WHERE ri.recipe_id = v_meal.recipe_id AND ri.user_id = p_user_id
    LOOP
      -- Needed containers = ingredient.quantity * scale_factor (in the
      -- ingredient's stored unit, converted to containers).
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

    -- All ingredients validated; now mutate.
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
        TRUE  -- confirm_large_amount: mark_meal_done is the user-gated path
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

    -- Pre-check: meal.servings (in servings) converted to containers vs. stock.
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
      v_meal_product_name := '[MEAL] ' || v_product.name || ' ' || to_char(v_logical_date, 'MM-DD');

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

  -- Collect food_log_ids for return payload.
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
