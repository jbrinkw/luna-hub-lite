-- Demo account date reset function
--
-- Shifts all date-relative demo data to be relative to CURRENT_DATE.
-- Called on every demo login so data always looks fresh.
-- Only works for the fixed demo user (11111111-...).

CREATE OR REPLACE FUNCTION private.reset_demo_dates(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_demo_uid UUID := '11111111-1111-1111-1111-111111111111';
  v_today DATE := CURRENT_DATE;
  v_now TIMESTAMPTZ := now();
BEGIN
  -- Only allow for the demo user
  IF p_user_id != v_demo_uid THEN
    RETURN;
  END IF;

  -- ── ChefByte: stock lot expiration dates ──
  -- Shift relative to today: Fridge chicken +3d, Freezer chicken +30d,
  -- Salmon +14d, Eggs +5d/+12d, Yogurt +7d
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

  -- ── ChefByte: meal plan entries ──
  -- 3 meals today, 1 meal prep tomorrow
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today,
        completed_at = v_now - INTERVAL '4 hours'
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5001-0000-0000-000000000000';
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5002-0000-0000-000000000000';
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5003-0000-0000-000000000000';
  UPDATE chefbyte.meal_plan_entries
    SET logical_date = v_today + 1, completed_at = NULL
    WHERE user_id = v_demo_uid AND meal_id = 'aaaaaaaa-5004-0000-0000-000000000000';

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
            + (("order" - 1) * INTERVAL '3 minutes')
    FROM coachbyte.planned_sets ps
    WHERE coachbyte.completed_sets.planned_set_id = ps.planned_set_id
      AND coachbyte.completed_sets.user_id = v_demo_uid
      AND coachbyte.completed_sets.plan_id = 'aaaaaaaa-a001-0000-0000-000000000000';
END;
$$;

-- Hub-schema wrapper: uses auth.uid() so the authenticated demo user can call it
CREATE OR REPLACE FUNCTION hub.reset_demo_dates()
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.reset_demo_dates((SELECT auth.uid()));
$$;

GRANT EXECUTE ON FUNCTION hub.reset_demo_dates() TO authenticated;
