-- complete_next_set previously returned a single column (rest_seconds) and
-- could not distinguish "successfully completed the last set" from "no
-- incomplete set was found, nothing was inserted". Both cases yielded
-- rest_seconds = NULL, so the MCP handler returned a false-positive
-- "Set completed" message even when the plan was already finished.
--
-- Add a `completed` boolean to the return so callers can tell the two
-- apart. true = an INSERT happened; false = nothing was inserted because
-- there are no incomplete planned sets.

-- Drop the old signature first — Postgres rejects CREATE OR REPLACE
-- when the return type changes (the wrappers depend on the old shape;
-- they're recreated below).
DROP FUNCTION IF EXISTS coachbyte.complete_next_set(UUID, INTEGER, NUMERIC);
DROP FUNCTION IF EXISTS coachbyte.complete_next_set_admin(UUID, UUID, INTEGER, NUMERIC);
DROP FUNCTION IF EXISTS private.complete_next_set(UUID, UUID, INTEGER, NUMERIC);

CREATE OR REPLACE FUNCTION private.complete_next_set(
  p_user_id UUID,
  p_plan_id UUID,
  p_actual_reps INTEGER,
  p_actual_load NUMERIC
)
RETURNS TABLE(rest_seconds INTEGER, completed BOOLEAN)
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

  -- No more sets to complete — signal so handler can return a real error
  IF NOT FOUND THEN
    rest_seconds := NULL;
    completed := false;
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

  -- Return rest_seconds of the next set (NULL if no more sets), completed=true
  rest_seconds := v_following_set.rest_seconds;
  completed := true;
  RETURN NEXT;
  RETURN;
END;
$$;

-- Recreate admin/public wrappers (already dropped above).
CREATE OR REPLACE FUNCTION coachbyte.complete_next_set(
  p_plan_id UUID,
  p_actual_reps INTEGER,
  p_actual_load NUMERIC
)
RETURNS TABLE(rest_seconds INTEGER, completed BOOLEAN)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM private.complete_next_set(auth.uid(), p_plan_id, p_actual_reps, p_actual_load);
$$;

CREATE OR REPLACE FUNCTION coachbyte.complete_next_set_admin(
  p_user_id UUID,
  p_plan_id UUID,
  p_actual_reps INTEGER,
  p_actual_load NUMERIC
)
RETURNS TABLE(rest_seconds INTEGER, completed BOOLEAN)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM private.complete_next_set(p_user_id, p_plan_id, p_actual_reps, p_actual_load);
$$;

GRANT EXECUTE ON FUNCTION coachbyte.complete_next_set(UUID, INTEGER, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION coachbyte.complete_next_set_admin(UUID, UUID, INTEGER, NUMERIC) TO service_role;
