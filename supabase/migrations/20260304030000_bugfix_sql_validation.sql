-- Fix SQL bugs: consume_product validation, get_daily_macros defaults,
-- completed_sets CHECK constraints, reset_demo_dates qualified column

------------------------------------------------------------
-- 1. consume_product: validate positive quantity
------------------------------------------------------------
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

  -- Convert quantity to containers
  IF p_unit = 'serving' THEN
    v_qty_containers := p_qty / GREATEST(v_product.servings_per_container, 0.001);
  ELSE
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
      p_qty, p_unit, v_cal, v_carbs, v_protein, v_fat
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

------------------------------------------------------------
-- 2. get_daily_macros: server-side default goals (2000/150/250/65)
------------------------------------------------------------
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

  -- Fetch goals from user_config with server-side defaults
  SELECT COALESCE(value::numeric, 2000) INTO v_goal_cal
  FROM chefbyte.user_config
  WHERE user_id = p_user_id AND key = 'goal_calories';
  v_goal_cal := COALESCE(v_goal_cal, 2000);

  SELECT COALESCE(value::numeric, 250) INTO v_goal_carbs
  FROM chefbyte.user_config
  WHERE user_id = p_user_id AND key = 'goal_carbs';
  v_goal_carbs := COALESCE(v_goal_carbs, 250);

  SELECT COALESCE(value::numeric, 150) INTO v_goal_protein
  FROM chefbyte.user_config
  WHERE user_id = p_user_id AND key = 'goal_protein';
  v_goal_protein := COALESCE(v_goal_protein, 150);

  SELECT COALESCE(value::numeric, 65) INTO v_goal_fat
  FROM chefbyte.user_config
  WHERE user_id = p_user_id AND key = 'goal_fat';
  v_goal_fat := COALESCE(v_goal_fat, 65);

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
-- 3. CHECK constraints on completed_sets
------------------------------------------------------------
ALTER TABLE coachbyte.completed_sets
  ADD CONSTRAINT completed_sets_reps_positive CHECK (actual_reps > 0),
  ADD CONSTRAINT completed_sets_load_nonnegative CHECK (actual_load >= 0);

------------------------------------------------------------
-- 4. reset_demo_dates: qualify "order" column with ps alias
------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.reset_demo_dates()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_demo_uid UUID;
  v_today DATE;
  v_now TIMESTAMPTZ;
BEGIN
  SELECT id INTO v_demo_uid
  FROM auth.users
  WHERE email = 'demo@lunahub.dev';

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_today := CURRENT_DATE;
  v_now := NOW();

  -- ── ChefByte: all date-sensitive rows → today ──
  UPDATE chefbyte.food_logs
    SET logical_date = v_today
    WHERE user_id = v_demo_uid;

  UPDATE chefbyte.temp_items
    SET logical_date = v_today
    WHERE user_id = v_demo_uid;

  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today
    WHERE user_id = v_demo_uid;

  UPDATE chefbyte.liquidtrack_events
    SET logical_date = v_today
    WHERE user_id = v_demo_uid;

  -- ── CoachByte: daily plan → yesterday ──
  UPDATE coachbyte.daily_plans
    SET plan_date = v_today - 1, logical_date = v_today - 1
    WHERE user_id = v_demo_uid AND plan_id = 'aaaaaaaa-a001-0000-0000-000000000000';

  -- ── CoachByte: completed sets → yesterday with staggered times ──
  UPDATE coachbyte.completed_sets
    SET logical_date = v_today - 1,
        completed_at = v_now - INTERVAL '25 hours'
            + ((ps."order" - 1) * INTERVAL '3 minutes')
    FROM coachbyte.planned_sets ps
    WHERE coachbyte.completed_sets.planned_set_id = ps.planned_set_id
      AND coachbyte.completed_sets.user_id = v_demo_uid
      AND coachbyte.completed_sets.plan_id = 'aaaaaaaa-a001-0000-0000-000000000000';
END;
$$;

-- Recreate the hub wrapper
CREATE OR REPLACE FUNCTION hub.reset_demo_dates()
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.reset_demo_dates();
$$;

GRANT EXECUTE ON FUNCTION hub.reset_demo_dates() TO authenticated;
