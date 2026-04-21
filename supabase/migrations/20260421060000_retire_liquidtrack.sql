-- ========================================================================
-- Retire LiquidTrack (2026-04-21)
-- ========================================================================
-- LiquidTrack had zero device rows and zero event rows at retirement time
-- (confirmed via prod audit — see docs/superpowers/plans/2026-04-21-pi-to-cloud-audit.md).
-- The feature was replaced by LiveTrack: live_scale kind under
-- chefbyte.live_shelf_devices + chefbyte.scale_pairings. No data migration
-- was needed because no rows existed.
--
-- This migration:
-- 1. Rebuilds private.get_daily_macros to drop the liquidtrack_events sum
-- 2. Rebuilds private.reset_demo_dates to drop the liquidtrack_events UPDATE
-- 3. Rebuilds private.deactivate_app to drop the liquidtrack_* DELETEs
-- 4. DROPs chefbyte.liquidtrack_events (CASCADE handles RLS policies + index)
-- 5. DROPs chefbyte.liquidtrack_devices (CASCADE handles RLS policies)
-- ========================================================================

------------------------------------------------------------
-- 1. get_daily_macros: no more liquidtrack_events sum
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

  -- Total across both sources
  v_total_cal := v_food_cal + v_temp_cal;
  v_total_carbs := v_food_carbs + v_temp_carbs;
  v_total_protein := v_food_protein + v_temp_protein;
  v_total_fat := v_food_fat + v_temp_fat;

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
-- 2. reset_demo_dates: no more liquidtrack_events UPDATE
------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.reset_demo_dates()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_demo_uid UUID;
  v_tz TEXT;
  v_dsh INTEGER;
  v_today DATE;
  v_now TIMESTAMPTZ := now();
BEGIN
  SELECT id INTO v_demo_uid
  FROM auth.users
  WHERE email = 'demo@lunahub.dev';

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Get user's timezone and day_start_hour for logical date
  SELECT COALESCE(p.timezone, 'America/Chicago'),
         COALESCE(p.day_start_hour, 4)
    INTO v_tz, v_dsh
    FROM hub.profiles p
   WHERE p.user_id = v_demo_uid;

  v_today := private.get_logical_date(v_now, v_tz, v_dsh);

  -- ── ChefByte: stock lot expiration dates ──
  UPDATE chefbyte.stock_lots SET expires_on = v_today + 3
    WHERE user_id = v_demo_uid AND lot_id = 'aaaaaaaa-3001-0000-0000-000000000000';
  UPDATE chefbyte.stock_lots SET expires_on = v_today + 30
    WHERE user_id = v_demo_uid AND lot_id = 'aaaaaaaa-3002-0000-0000-000000000000';
  UPDATE chefbyte.stock_lots SET expires_on = v_today + 14
    WHERE user_id = v_demo_uid AND lot_id = 'aaaaaaaa-3003-0000-0000-000000000000';
  UPDATE chefbyte.stock_lots SET expires_on = v_today + 5
    WHERE user_id = v_demo_uid AND lot_id = 'aaaaaaaa-3004-0000-0000-000000000000';
  UPDATE chefbyte.stock_lots SET expires_on = v_today + 12
    WHERE user_id = v_demo_uid AND lot_id = 'aaaaaaaa-3005-0000-0000-000000000000';
  UPDATE chefbyte.stock_lots SET expires_on = v_today + 7
    WHERE user_id = v_demo_uid AND lot_id = 'aaaaaaaa-3006-0000-0000-000000000000';

  -- ── ChefByte: meal plan entries (16 entries across 7 days) ──
  -- Today: breakfast done, lunch + shake pending
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today, completed_at = v_now - INTERVAL '4 hours'
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5001-0000-0000-000000000000';
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5002-0000-0000-000000000000';
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5003-0000-0000-000000000000';

  -- Today+1: meal prep (4 servings) + regular meal
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today + 1, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5004-0000-0000-000000000000';
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today + 1, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5a01-0000-0000-000000000000';

  -- Today+2: full day (3 meals)
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today + 2, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5b01-0000-0000-000000000000';
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today + 2, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5b02-0000-0000-000000000000';
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today + 2, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5c01-0000-0000-000000000000';

  -- Today+3: 2 meals
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today + 3, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5c02-0000-0000-000000000000';
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today + 3, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5d01-0000-0000-000000000000';

  -- Today+4: meal prep + 2 meals
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today + 4, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5d02-0000-0000-000000000000';
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today + 4, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5d03-0000-0000-000000000000';
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today + 4, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5e01-0000-0000-000000000000';

  -- Today+5: 2 meals
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today + 5, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5e02-0000-0000-000000000000';
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today + 5, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5e03-0000-0000-000000000000';

  -- Today+6: breakfast only
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today + 6, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5f01-0000-0000-000000000000';

  -- ── ChefByte: food logs + temp items ──
  UPDATE chefbyte.food_logs
    SET logical_date = v_today
    WHERE user_id = v_demo_uid;
  UPDATE chefbyte.temp_items
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

------------------------------------------------------------
-- 3. deactivate_app: no more liquidtrack_* DELETEs
------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.deactivate_app(
  p_user_id UUID,
  p_app_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM hub.app_activations
  WHERE user_id = p_user_id AND app_name = p_app_name;

  IF p_app_name = 'coachbyte' THEN
    DELETE FROM coachbyte.timers WHERE user_id = p_user_id;
    DELETE FROM coachbyte.splits WHERE user_id = p_user_id;
    DELETE FROM coachbyte.daily_plans WHERE user_id = p_user_id;
    DELETE FROM coachbyte.user_settings WHERE user_id = p_user_id;
  END IF;

  IF p_app_name = 'chefbyte' THEN
    -- live_shelf: device row cascades to scale_pairings + shelf_event_log
    -- via FK ON DELETE CASCADE, so one DELETE covers all three tables.
    DELETE FROM chefbyte.live_shelf_devices WHERE user_id = p_user_id;
    DELETE FROM chefbyte.food_logs WHERE user_id = p_user_id;
    DELETE FROM chefbyte.temp_items WHERE user_id = p_user_id;
    DELETE FROM chefbyte.shopping_list WHERE user_id = p_user_id;
    DELETE FROM chefbyte.meal_plan_entries WHERE user_id = p_user_id;
    DELETE FROM chefbyte.recipe_ingredients WHERE user_id = p_user_id;
    DELETE FROM chefbyte.recipes WHERE user_id = p_user_id;
    DELETE FROM chefbyte.stock_lots WHERE user_id = p_user_id;
    DELETE FROM chefbyte.products WHERE user_id = p_user_id;
    DELETE FROM chefbyte.locations WHERE user_id = p_user_id;
    DELETE FROM chefbyte.user_config WHERE user_id = p_user_id;
  END IF;
END;
$$;

------------------------------------------------------------
-- 4. Drop LiquidTrack tables. CASCADE handles:
--    - RLS policies on each table
--    - lt_events_user_date_idx index
--    - FK constraints (liquidtrack_events → liquidtrack_devices)
--    - The chefbyte.liquidtrack_events_weight_before_positive and
--      chefbyte.liquidtrack_events_weight_after_positive CHECK constraints
------------------------------------------------------------
DROP TABLE IF EXISTS chefbyte.liquidtrack_events CASCADE;
DROP TABLE IF EXISTS chefbyte.liquidtrack_devices CASCADE;
