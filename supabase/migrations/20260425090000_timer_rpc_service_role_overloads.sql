-- Service-role overloads for the timer state-machine RPCs.
--
-- Context: migration 20260425040000_timer_state_machine_rpcs.sql introduced
--   coachbyte.start_timer(p_duration_seconds INTEGER)       -- uses auth.uid()
--   coachbyte.pause_timer()                                  -- uses auth.uid()
--   coachbyte.resume_timer()                                 -- uses auth.uid()
--   coachbyte.expire_timer()                                 -- uses auth.uid()
--   coachbyte.reset_timer()                                  -- uses auth.uid()
--
-- The MCP worker (apps/mcp-worker) dispatches tool calls through the
-- Supabase **service_role** client. Service-role requests do not carry a
-- JWT, so current_setting('request.jwt.claims') is NULL and the
-- auth.uid()-based wrappers reject every call with "no authenticated user".
--
-- This migration adds parameterized overloads that take p_user_id
-- explicitly. They are GRANTed only to service_role — authenticated
-- clients keep using the no-arg wrappers that derive auth.uid() from
-- the JWT (so a browser can never spoof another user's user_id).
--
-- The overloads delegate to the existing private.*_timer SECURITY
-- DEFINER functions — same state-machine guards, same columns written,
-- same error messages.

BEGIN;

------------------------------------------------------------------
-- coachbyte.start_timer(p_user_id, p_duration_seconds)
------------------------------------------------------------------

CREATE OR REPLACE FUNCTION coachbyte.start_timer(
  p_user_id UUID,
  p_duration_seconds INTEGER
)
RETURNS coachbyte.timers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'start_timer: p_user_id is required' USING ERRCODE = '22023';
  END IF;
  RETURN private.start_timer(p_user_id, p_duration_seconds);
END;
$$;

REVOKE ALL ON FUNCTION coachbyte.start_timer(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION coachbyte.start_timer(UUID, INTEGER) TO service_role;

------------------------------------------------------------------
-- coachbyte.pause_timer(p_user_id)
------------------------------------------------------------------

CREATE OR REPLACE FUNCTION coachbyte.pause_timer(p_user_id UUID)
RETURNS coachbyte.timers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'pause_timer: p_user_id is required' USING ERRCODE = '22023';
  END IF;
  RETURN private.pause_timer(p_user_id);
END;
$$;

REVOKE ALL ON FUNCTION coachbyte.pause_timer(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION coachbyte.pause_timer(UUID) TO service_role;

------------------------------------------------------------------
-- coachbyte.resume_timer(p_user_id)
------------------------------------------------------------------

CREATE OR REPLACE FUNCTION coachbyte.resume_timer(p_user_id UUID)
RETURNS coachbyte.timers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'resume_timer: p_user_id is required' USING ERRCODE = '22023';
  END IF;
  RETURN private.resume_timer(p_user_id);
END;
$$;

REVOKE ALL ON FUNCTION coachbyte.resume_timer(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION coachbyte.resume_timer(UUID) TO service_role;

------------------------------------------------------------------
-- coachbyte.expire_timer(p_user_id)
------------------------------------------------------------------

CREATE OR REPLACE FUNCTION coachbyte.expire_timer(p_user_id UUID)
RETURNS coachbyte.timers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'expire_timer: p_user_id is required' USING ERRCODE = '22023';
  END IF;
  RETURN private.expire_timer(p_user_id);
END;
$$;

REVOKE ALL ON FUNCTION coachbyte.expire_timer(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION coachbyte.expire_timer(UUID) TO service_role;

------------------------------------------------------------------
-- coachbyte.reset_timer(p_user_id)
------------------------------------------------------------------

CREATE OR REPLACE FUNCTION coachbyte.reset_timer(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'reset_timer: p_user_id is required' USING ERRCODE = '22023';
  END IF;
  RETURN private.reset_timer(p_user_id);
END;
$$;

REVOKE ALL ON FUNCTION coachbyte.reset_timer(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION coachbyte.reset_timer(UUID) TO service_role;

COMMIT;
