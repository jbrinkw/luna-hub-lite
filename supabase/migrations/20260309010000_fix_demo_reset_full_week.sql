-- Fix demo reset: use user's logical date (not UTC CURRENT_DATE)
-- and handle all 16 meal plan entries spread across the week.
-- Replaces the no-arg overload (called by hub.reset_demo_dates wrapper).

-- Drop the unused p_user_id overload from the original migration
DROP FUNCTION IF EXISTS private.reset_demo_dates(UUID);

-- Replace the no-arg version that hub.reset_demo_dates() calls
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
