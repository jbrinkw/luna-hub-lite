-- Service-role wrappers for MCP Worker
-- These accept explicit user_id (auth.uid() is NULL with service role key)
-- Granted only to service_role, not authenticated

-- CoachByte
CREATE OR REPLACE FUNCTION coachbyte.ensure_daily_plan_admin(
  p_user_id UUID,
  p_day DATE
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.ensure_daily_plan(p_user_id, p_day);
$$;
GRANT EXECUTE ON FUNCTION coachbyte.ensure_daily_plan_admin(UUID, DATE) TO service_role;

CREATE OR REPLACE FUNCTION coachbyte.complete_next_set_admin(
  p_user_id UUID,
  p_plan_id UUID,
  p_actual_reps INTEGER,
  p_actual_load NUMERIC
)
RETURNS TABLE(rest_seconds INTEGER)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM private.complete_next_set(p_user_id, p_plan_id, p_actual_reps, p_actual_load);
$$;
GRANT EXECUTE ON FUNCTION coachbyte.complete_next_set_admin(UUID, UUID, INTEGER, NUMERIC) TO service_role;

-- ChefByte
CREATE OR REPLACE FUNCTION chefbyte.consume_product_admin(
  p_user_id UUID,
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
  SELECT private.consume_product(p_user_id, p_product_id, p_qty, p_unit, p_log_macros, p_logical_date);
$$;
GRANT EXECUTE ON FUNCTION chefbyte.consume_product_admin(UUID, UUID, NUMERIC, TEXT, BOOLEAN, DATE) TO service_role;

CREATE OR REPLACE FUNCTION chefbyte.mark_meal_done_admin(
  p_user_id UUID,
  p_meal_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.mark_meal_done(p_user_id, p_meal_id);
$$;
GRANT EXECUTE ON FUNCTION chefbyte.mark_meal_done_admin(UUID, UUID) TO service_role;

CREATE OR REPLACE FUNCTION chefbyte.get_daily_macros_admin(
  p_user_id UUID,
  p_logical_date DATE
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.get_daily_macros(p_user_id, p_logical_date);
$$;
GRANT EXECUTE ON FUNCTION chefbyte.get_daily_macros_admin(UUID, DATE) TO service_role;
