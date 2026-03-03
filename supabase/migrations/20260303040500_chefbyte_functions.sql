-- ChefByte private functions: consume_product, mark_meal_done, get_daily_macros
-- Plus thin RPC wrappers for frontend access

------------------------------------------------------------
-- PRIVATE: consume_product
------------------------------------------------------------
-- Consumes a product by deducting from stock lots (FIFO by expiration),
-- optionally logs macros. Macros are ALWAYS calculated for the full
-- requested amount regardless of available stock. Stock floors at 0.

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
BEGIN
  -- Look up product
  SELECT * INTO v_product
  FROM chefbyte.products
  WHERE product_id = p_product_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found or not owned by user';
  END IF;

  -- Convert quantity to containers
  IF p_unit = 'serving' THEN
    v_qty_containers := p_qty / GREATEST(v_product.servings_per_container, 0.001);
  ELSE
    -- 'container' or any other unit treated as containers
    v_qty_containers := p_qty;
  END IF;

  -- Calculate macros for the FULL requested amount (not just available stock)
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
      -- This lot is fully consumed; delete it
      v_remaining := v_remaining - v_lot.qty_containers;
      DELETE FROM chefbyte.stock_lots WHERE lot_id = v_lot.lot_id;
    ELSE
      -- Partially consume this lot
      UPDATE chefbyte.stock_lots
      SET qty_containers = qty_containers - v_remaining
      WHERE lot_id = v_lot.lot_id;
      v_remaining := 0;
    END IF;
  END LOOP;
  -- v_remaining > 0 means stock was insufficient — that's OK, stock floors at 0

  -- Log macros if requested
  IF p_log_macros THEN
    INSERT INTO chefbyte.food_logs (
      user_id, product_id, logical_date,
      qty_consumed, unit, calories, carbs, protein, fat
    ) VALUES (
      p_user_id, p_product_id, p_logical_date,
      p_qty, p_unit, v_cal, v_carbs, v_protein, v_fat
    );
  END IF;

  -- Calculate total remaining stock for this product
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

------------------------------------------------------------
-- PRIVATE: mark_meal_done
------------------------------------------------------------
-- Marks a meal plan entry as completed. For recipe-based meals,
-- consumes each ingredient. For meal-prep meals, creates a [MEAL]
-- product + stock lot instead of logging macros.

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
    -- Fetch recipe for name (used in meal-prep product naming)
    SELECT * INTO v_recipe
    FROM chefbyte.recipes
    WHERE recipe_id = v_meal.recipe_id AND user_id = p_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Recipe not found or not owned by user';
    END IF;

    -- Process each ingredient
    FOR v_ingredient IN
      SELECT ri.product_id, ri.quantity, ri.unit
      FROM chefbyte.recipe_ingredients ri
      WHERE ri.recipe_id = v_meal.recipe_id AND ri.user_id = p_user_id
    LOOP
      -- Consume: qty = ingredient.quantity * meal.servings
      -- log_macros = NOT meal_prep (regular meals log, meal prep doesn't)
      v_consume_result := private.consume_product(
        p_user_id,
        v_ingredient.product_id,
        v_ingredient.quantity * v_meal.servings,
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

      -- Create or update the [MEAL] product
      -- servings_per_container = meal.servings so each serving has correct per-serving macros
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

      -- Get user's first location for the stock lot
      SELECT location_id INTO v_location_id
      FROM chefbyte.locations
      WHERE user_id = p_user_id
      ORDER BY created_at ASC
      LIMIT 1;

      IF v_location_id IS NULL THEN
        RAISE EXCEPTION 'No storage locations found for user';
      END IF;

      -- Create stock lot: 1 container, expires in 7 days
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
      'container',
      NOT v_meal.meal_prep,
      v_logical_date
    );

    -- If product-based meal prep, create [MEAL] product + lot
    IF v_meal.meal_prep THEN
      -- Get product info for naming
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

  RETURN jsonb_build_object(
    'success', true,
    'completed_at', v_completed_at
  );
END;
$$;

------------------------------------------------------------
-- PRIVATE: get_daily_macros
------------------------------------------------------------
-- Aggregates macro totals from food_logs, temp_items, and
-- liquidtrack_events for a given logical_date. Compares
-- against user goals from chefbyte.user_config.

CREATE OR REPLACE FUNCTION private.get_daily_macros(
  p_user_id UUID,
  p_logical_date DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_food_cal NUMERIC(10,3);
  v_food_carbs NUMERIC(10,3);
  v_food_protein NUMERIC(10,3);
  v_food_fat NUMERIC(10,3);
  v_temp_cal NUMERIC(10,3);
  v_temp_carbs NUMERIC(10,3);
  v_temp_protein NUMERIC(10,3);
  v_temp_fat NUMERIC(10,3);
  v_lt_cal NUMERIC(10,3);
  v_lt_carbs NUMERIC(10,3);
  v_lt_protein NUMERIC(10,3);
  v_lt_fat NUMERIC(10,3);
  v_total_cal NUMERIC(10,3);
  v_total_carbs NUMERIC(10,3);
  v_total_protein NUMERIC(10,3);
  v_total_fat NUMERIC(10,3);
  v_goal_cal NUMERIC(10,3);
  v_goal_carbs NUMERIC(10,3);
  v_goal_protein NUMERIC(10,3);
  v_goal_fat NUMERIC(10,3);
BEGIN
  -- Sum from food_logs
  SELECT
    COALESCE(SUM(calories), 0),
    COALESCE(SUM(carbs), 0),
    COALESCE(SUM(protein), 0),
    COALESCE(SUM(fat), 0)
  INTO v_food_cal, v_food_carbs, v_food_protein, v_food_fat
  FROM chefbyte.food_logs
  WHERE user_id = p_user_id AND logical_date = p_logical_date;

  -- Sum from temp_items
  SELECT
    COALESCE(SUM(calories), 0),
    COALESCE(SUM(carbs), 0),
    COALESCE(SUM(protein), 0),
    COALESCE(SUM(fat), 0)
  INTO v_temp_cal, v_temp_carbs, v_temp_protein, v_temp_fat
  FROM chefbyte.temp_items
  WHERE user_id = p_user_id AND logical_date = p_logical_date;

  -- Sum from liquidtrack_events
  SELECT
    COALESCE(SUM(calories), 0),
    COALESCE(SUM(carbs), 0),
    COALESCE(SUM(protein), 0),
    COALESCE(SUM(fat), 0)
  INTO v_lt_cal, v_lt_carbs, v_lt_protein, v_lt_fat
  FROM chefbyte.liquidtrack_events
  WHERE user_id = p_user_id AND logical_date = p_logical_date;

  -- Total across all sources
  v_total_cal := v_food_cal + v_temp_cal + v_lt_cal;
  v_total_carbs := v_food_carbs + v_temp_carbs + v_lt_carbs;
  v_total_protein := v_food_protein + v_temp_protein + v_lt_protein;
  v_total_fat := v_food_fat + v_temp_fat + v_lt_fat;

  -- Fetch goals from user_config (key-value store)
  SELECT COALESCE(value::numeric, 0) INTO v_goal_cal
  FROM chefbyte.user_config
  WHERE user_id = p_user_id AND key = 'goal_calories';
  v_goal_cal := COALESCE(v_goal_cal, 0);

  SELECT COALESCE(value::numeric, 0) INTO v_goal_carbs
  FROM chefbyte.user_config
  WHERE user_id = p_user_id AND key = 'goal_carbs';
  v_goal_carbs := COALESCE(v_goal_carbs, 0);

  SELECT COALESCE(value::numeric, 0) INTO v_goal_protein
  FROM chefbyte.user_config
  WHERE user_id = p_user_id AND key = 'goal_protein';
  v_goal_protein := COALESCE(v_goal_protein, 0);

  SELECT COALESCE(value::numeric, 0) INTO v_goal_fat
  FROM chefbyte.user_config
  WHERE user_id = p_user_id AND key = 'goal_fats';
  v_goal_fat := COALESCE(v_goal_fat, 0);

  RETURN jsonb_build_object(
    'calories', jsonb_build_object(
      'consumed', v_total_cal,
      'goal', v_goal_cal,
      'remaining', v_goal_cal - v_total_cal
    ),
    'carbs', jsonb_build_object(
      'consumed', v_total_carbs,
      'goal', v_goal_carbs,
      'remaining', v_goal_carbs - v_total_carbs
    ),
    'protein', jsonb_build_object(
      'consumed', v_total_protein,
      'goal', v_goal_protein,
      'remaining', v_goal_protein - v_total_protein
    ),
    'fat', jsonb_build_object(
      'consumed', v_total_fat,
      'goal', v_goal_fat,
      'remaining', v_goal_fat - v_total_fat
    )
  );
END;
$$;

------------------------------------------------------------
-- PUBLIC RPC WRAPPERS
------------------------------------------------------------

CREATE OR REPLACE FUNCTION chefbyte.consume_product(
  p_product_id UUID,
  p_qty NUMERIC,
  p_unit TEXT,
  p_log_macros BOOLEAN,
  p_logical_date DATE
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.consume_product(
    (SELECT auth.uid()), p_product_id, p_qty, p_unit, p_log_macros, p_logical_date
  );
$$;

CREATE OR REPLACE FUNCTION chefbyte.mark_meal_done(p_meal_id UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.mark_meal_done((SELECT auth.uid()), p_meal_id);
$$;

CREATE OR REPLACE FUNCTION chefbyte.get_daily_macros(p_logical_date DATE)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.get_daily_macros((SELECT auth.uid()), p_logical_date);
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION chefbyte.consume_product(UUID, NUMERIC, TEXT, BOOLEAN, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.mark_meal_done(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.get_daily_macros(DATE) TO authenticated;
