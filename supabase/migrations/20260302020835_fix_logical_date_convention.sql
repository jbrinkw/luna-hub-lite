-- Fix get_logical_date to follow project convention:
-- All private schema functions use SECURITY DEFINER + SET search_path = ''
CREATE OR REPLACE FUNCTION private.get_logical_date(
  ts TIMESTAMPTZ,
  tz TEXT,
  day_start_hour INTEGER
) RETURNS DATE
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN (ts AT TIME ZONE tz - (day_start_hour || ' hours')::INTERVAL)::DATE;
END;
$$;
