-- CoachByte private functions: ensure_daily_plan, complete_next_set
-- Plus thin RPC wrappers for frontend access

------------------------------------------------------------
-- PRIVATE: ensure_daily_plan
------------------------------------------------------------
-- Idempotent: creates daily plan, copies weekday split, resolves
-- relative loads from derived PRs (Epley: load * (1 + reps/30)).
-- Side effect: deletes previous day's plan if it has 0 completed sets.

CREATE OR REPLACE FUNCTION private.ensure_daily_plan(
  p_user_id UUID,
  p_day DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plan_id UUID;
  v_logical_date DATE;
  v_weekday INTEGER;
  v_profile RECORD;
  v_split RECORD;
  v_template_set JSONB;
  v_exercise_id UUID;
  v_pr_1rm NUMERIC(10,3);
  v_resolved_load NUMERIC(10,3);
  v_set_order INTEGER := 0;
  v_prev_plan_id UUID;
  v_prev_completed INTEGER;
BEGIN
  -- Get user profile for logical date calculation
  SELECT timezone, day_start_hour INTO v_profile
  FROM hub.profiles WHERE user_id = p_user_id;

  -- Compute logical date
  v_logical_date := private.get_logical_date(
    (p_day::text || ' 12:00:00')::timestamptz,
    COALESCE(v_profile.timezone, 'America/New_York'),
    COALESCE(v_profile.day_start_hour, 6)
  );

  -- Determine weekday (0=Sunday, 6=Saturday) from plan_date
  v_weekday := EXTRACT(DOW FROM p_day)::integer;

  -- Idempotent: create or fetch plan
  INSERT INTO coachbyte.daily_plans (user_id, plan_date, logical_date)
  VALUES (p_user_id, p_day, v_logical_date)
  ON CONFLICT (user_id, plan_date) DO NOTHING
  RETURNING plan_id INTO v_plan_id;

  -- If plan already existed, fetch it
  IF v_plan_id IS NULL THEN
    SELECT plan_id INTO v_plan_id
    FROM coachbyte.daily_plans
    WHERE user_id = p_user_id AND plan_date = p_day;

    -- Check if planned sets already exist (already bootstrapped)
    IF EXISTS (
      SELECT 1 FROM coachbyte.planned_sets WHERE plan_id = v_plan_id
    ) THEN
      RETURN jsonb_build_object('plan_id', v_plan_id, 'status', 'existing');
    END IF;
  END IF;

  -- Side effect: delete previous day's plan if it has 0 completed sets
  -- Runs on every call (including no-split days) to keep history clean
  SELECT plan_id INTO v_prev_plan_id
  FROM coachbyte.daily_plans
  WHERE user_id = p_user_id AND plan_date = p_day - 1;

  IF v_prev_plan_id IS NOT NULL THEN
    SELECT count(*)::integer INTO v_prev_completed
    FROM coachbyte.completed_sets
    WHERE plan_id = v_prev_plan_id;

    IF v_prev_completed = 0 THEN
      DELETE FROM coachbyte.daily_plans WHERE plan_id = v_prev_plan_id;
    END IF;
  END IF;

  -- Look up split for this weekday
  SELECT * INTO v_split
  FROM coachbyte.splits
  WHERE user_id = p_user_id AND weekday = v_weekday;

  -- If no split defined, return empty plan
  IF NOT FOUND OR v_split.template_sets IS NULL THEN
    RETURN jsonb_build_object('plan_id', v_plan_id, 'status', 'empty');
  END IF;

  -- Copy split template into planned_sets, resolving relative loads
  FOR v_template_set IN SELECT * FROM jsonb_array_elements(v_split.template_sets)
  LOOP
    v_set_order := v_set_order + 1;
    v_exercise_id := (v_template_set->>'exercise_id')::uuid;
    v_resolved_load := NULL;

    IF v_template_set->>'target_load_percentage' IS NOT NULL THEN
      -- Derive 1RM from completed_sets via Epley: MAX(load * (1 + reps/30))
      -- Exclude 0-rep sets; 1-rep uses actual weight (formula gives same result)
      SELECT MAX(
        actual_load * (1.0 + actual_reps::numeric / 30.0)
      ) INTO v_pr_1rm
      FROM coachbyte.completed_sets
      WHERE user_id = p_user_id
        AND exercise_id = v_exercise_id
        AND actual_reps > 0;

      IF v_pr_1rm IS NOT NULL THEN
        -- Resolve: percentage * 1RM, round to nearest 5
        v_resolved_load := ROUND(
          (v_template_set->>'target_load_percentage')::numeric / 100.0 * v_pr_1rm / 5.0
        ) * 5.0;
      END IF;
      -- If no PR exists, v_resolved_load stays NULL
    ELSE
      -- Absolute load
      v_resolved_load := (v_template_set->>'target_load')::numeric;
    END IF;

    INSERT INTO coachbyte.planned_sets (
      plan_id, user_id, exercise_id, target_reps, target_load,
      target_load_percentage, rest_seconds, "order"
    ) VALUES (
      v_plan_id,
      p_user_id,
      v_exercise_id,
      (v_template_set->>'target_reps')::integer,
      v_resolved_load,
      (v_template_set->>'target_load_percentage')::numeric,
      (v_template_set->>'rest_seconds')::integer,
      v_set_order
    );
  END LOOP;

  RETURN jsonb_build_object('plan_id', v_plan_id, 'status', 'created');
END;
$$;

------------------------------------------------------------
-- PRIVATE: complete_next_set
------------------------------------------------------------
-- Finds lowest-order incomplete planned_set, inserts completed_set,
-- returns rest_seconds of the NEXT planned set after completion.

CREATE OR REPLACE FUNCTION private.complete_next_set(
  p_user_id UUID,
  p_plan_id UUID,
  p_actual_reps INTEGER,
  p_actual_load NUMERIC
)
RETURNS TABLE(rest_seconds INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_next_set RECORD;
  v_logical_date DATE;
  v_following_set RECORD;
BEGIN
  -- Verify plan belongs to user
  IF NOT EXISTS (
    SELECT 1 FROM coachbyte.daily_plans
    WHERE plan_id = p_plan_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Plan not found or not owned by user';
  END IF;

  -- Get logical_date from the plan
  SELECT dp.logical_date INTO v_logical_date
  FROM coachbyte.daily_plans dp
  WHERE dp.plan_id = p_plan_id;

  -- Find lowest-order incomplete planned_set
  SELECT ps.* INTO v_next_set
  FROM coachbyte.planned_sets ps
  LEFT JOIN coachbyte.completed_sets cs
    ON cs.planned_set_id = ps.planned_set_id
  WHERE ps.plan_id = p_plan_id
    AND cs.completed_set_id IS NULL
  ORDER BY ps."order"
  LIMIT 1;

  -- No more sets to complete
  IF NOT FOUND THEN
    rest_seconds := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Insert completed set
  INSERT INTO coachbyte.completed_sets (
    plan_id, planned_set_id, user_id, exercise_id,
    actual_reps, actual_load, logical_date
  ) VALUES (
    p_plan_id,
    v_next_set.planned_set_id,
    p_user_id,
    v_next_set.exercise_id,
    p_actual_reps,
    p_actual_load,
    v_logical_date
  );

  -- Find the FOLLOWING planned set (next incomplete after the one we just completed)
  SELECT ps.rest_seconds INTO v_following_set
  FROM coachbyte.planned_sets ps
  LEFT JOIN coachbyte.completed_sets cs
    ON cs.planned_set_id = ps.planned_set_id
  WHERE ps.plan_id = p_plan_id
    AND cs.completed_set_id IS NULL
  ORDER BY ps."order"
  LIMIT 1;

  -- Return rest_seconds of the next set (NULL if no more sets)
  rest_seconds := v_following_set.rest_seconds;
  RETURN NEXT;
  RETURN;
END;
$$;

------------------------------------------------------------
-- PUBLIC RPC WRAPPERS
------------------------------------------------------------

CREATE OR REPLACE FUNCTION coachbyte.ensure_daily_plan(p_day DATE)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.ensure_daily_plan((SELECT auth.uid()), p_day);
$$;

CREATE OR REPLACE FUNCTION coachbyte.complete_next_set(
  p_plan_id UUID,
  p_reps INTEGER,
  p_load NUMERIC
)
RETURNS TABLE(rest_seconds INTEGER)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM private.complete_next_set((SELECT auth.uid()), p_plan_id, p_reps, p_load);
$$;

GRANT EXECUTE ON FUNCTION coachbyte.ensure_daily_plan(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION coachbyte.complete_next_set(UUID, INTEGER, NUMERIC) TO authenticated;
