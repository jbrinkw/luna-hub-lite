-- Timer state machine RPCs — moves the transition guards from the
-- TypeScript client layer (TodayPage + app-tools handlers) down to the
-- database so that:
--
--   1. A single source of truth enforces the state machine (UI, MCP, and
--      any future caller all go through the same gate).
--   2. The pgTAP test `timer_states.test.sql` can exercise real guards
--      by calling these RPCs, rather than repeating the WHERE-clause
--      guards inside the test SQL (a tautology).
--   3. A future refactor that accidentally drops the guard in the client
--      cannot corrupt DB state: the RPC rejects the transition.
--
-- State machine (see also coachbyte.timers.state CHECK constraint):
--
--          ┌──── set_timer ────┐  (upsert, any state → running)
--          ▼                   │
--        running ── pause ─► paused
--          │                   │
--          │                   └── resume ─► running
--          │
--          └── expire ─► expired (only if end_time <= now())
--
--        reset_timer (DELETE): any state → (no row)
--
-- Guards are encoded inside the RPC body. If the guard condition fails
-- the RPC raises an exception with SQLSTATE 'P0001' and a human-
-- readable message.
--
-- Design notes:
--   * All RPCs live in `private` and are exposed through thin
--     `coachbyte.*_admin` SQL wrappers granted to `authenticated`. This
--     mirrors the pattern in 20260424010000_api_key_lifecycle.sql.
--   * The RPCs write the same columns the client used to write directly,
--     so realtime postgres_changes subscribers see the same payloads.
--   * set_timer upserts so a user with any prior timer (paused,
--     expired, running) can start a fresh one with one call — matches
--     the TodayPage "Start" button behavior.

BEGIN;

------------------------------------------------------------------
-- private.start_timer(duration_seconds)
------------------------------------------------------------------
-- Creates or replaces the caller's timer in the running state.
-- Returns the full timer row.

CREATE OR REPLACE FUNCTION private.start_timer(
  p_user_id UUID,
  p_duration_seconds INTEGER
)
RETURNS coachbyte.timers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row coachbyte.timers;
BEGIN
  IF p_duration_seconds IS NULL OR p_duration_seconds <= 0 THEN
    RAISE EXCEPTION 'start_timer: duration_seconds must be positive (got %)', p_duration_seconds
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO coachbyte.timers (
    user_id, state, end_time, paused_at,
    duration_seconds, elapsed_before_pause
  ) VALUES (
    p_user_id,
    'running',
    now() + make_interval(secs => p_duration_seconds),
    NULL,
    p_duration_seconds,
    0
  )
  ON CONFLICT (user_id) DO UPDATE SET
    state = 'running',
    end_time = now() + make_interval(secs => p_duration_seconds),
    paused_at = NULL,
    duration_seconds = p_duration_seconds,
    elapsed_before_pause = 0
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION private.start_timer(UUID, INTEGER) FROM PUBLIC;

CREATE OR REPLACE FUNCTION coachbyte.start_timer(p_duration_seconds INTEGER)
RETURNS coachbyte.timers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'start_timer: no authenticated user' USING ERRCODE = '42501';
  END IF;
  RETURN private.start_timer(v_uid, p_duration_seconds);
END;
$$;

GRANT EXECUTE ON FUNCTION coachbyte.start_timer(INTEGER) TO authenticated, service_role;

------------------------------------------------------------------
-- private.pause_timer
------------------------------------------------------------------
-- Transitions a running timer to paused. Rejects if state != 'running'.
-- Computes elapsed_before_pause from end_time + duration_seconds so the
-- resume step can compute the remaining window. Clears end_time so
-- resume can mint a fresh one relative to now().

CREATE OR REPLACE FUNCTION private.pause_timer(p_user_id UUID)
RETURNS coachbyte.timers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row coachbyte.timers;
  v_elapsed INTEGER;
BEGIN
  SELECT * INTO v_row FROM coachbyte.timers WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pause_timer: no active timer' USING ERRCODE = 'P0001';
  END IF;

  IF v_row.state <> 'running' THEN
    RAISE EXCEPTION 'pause_timer: cannot pause timer in state % (must be running)', v_row.state
      USING ERRCODE = 'P0001';
  END IF;

  -- elapsed = duration - remaining; floor at 0
  v_elapsed := GREATEST(
    0,
    v_row.duration_seconds
      - EXTRACT(EPOCH FROM (v_row.end_time - now()))::INTEGER
  );

  UPDATE coachbyte.timers
     SET state = 'paused',
         paused_at = now(),
         elapsed_before_pause = v_elapsed,
         end_time = NULL
   WHERE user_id = p_user_id
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION private.pause_timer(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION coachbyte.pause_timer()
RETURNS coachbyte.timers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'pause_timer: no authenticated user' USING ERRCODE = '42501';
  END IF;
  RETURN private.pause_timer(v_uid);
END;
$$;

GRANT EXECUTE ON FUNCTION coachbyte.pause_timer() TO authenticated, service_role;

------------------------------------------------------------------
-- private.resume_timer
------------------------------------------------------------------
-- Transitions a paused timer to running with a fresh end_time. Rejects
-- if state != 'paused' or remaining <= 0.

CREATE OR REPLACE FUNCTION private.resume_timer(p_user_id UUID)
RETURNS coachbyte.timers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row coachbyte.timers;
  v_remaining INTEGER;
BEGIN
  SELECT * INTO v_row FROM coachbyte.timers WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resume_timer: no active timer' USING ERRCODE = 'P0001';
  END IF;

  IF v_row.state <> 'paused' THEN
    RAISE EXCEPTION 'resume_timer: cannot resume timer in state % (must be paused)', v_row.state
      USING ERRCODE = 'P0001';
  END IF;

  v_remaining := v_row.duration_seconds - COALESCE(v_row.elapsed_before_pause, 0);
  IF v_remaining <= 0 THEN
    RAISE EXCEPTION 'resume_timer: no remaining time'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE coachbyte.timers
     SET state = 'running',
         end_time = now() + make_interval(secs => v_remaining),
         paused_at = NULL
   WHERE user_id = p_user_id
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION private.resume_timer(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION coachbyte.resume_timer()
RETURNS coachbyte.timers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'resume_timer: no authenticated user' USING ERRCODE = '42501';
  END IF;
  RETURN private.resume_timer(v_uid);
END;
$$;

GRANT EXECUTE ON FUNCTION coachbyte.resume_timer() TO authenticated, service_role;

------------------------------------------------------------------
-- private.expire_timer
------------------------------------------------------------------
-- Transitions a running timer to expired. Rejects if state != 'running'
-- or end_time > now() (the UI-side timer fires this precisely at
-- expiration, but a misbehaving client that tried to expire a running-
-- but-not-yet-done timer would desync the display; guard it).

CREATE OR REPLACE FUNCTION private.expire_timer(p_user_id UUID)
RETURNS coachbyte.timers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row coachbyte.timers;
BEGIN
  SELECT * INTO v_row FROM coachbyte.timers WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'expire_timer: no active timer' USING ERRCODE = 'P0001';
  END IF;

  IF v_row.state <> 'running' THEN
    RAISE EXCEPTION 'expire_timer: cannot expire timer in state % (must be running)', v_row.state
      USING ERRCODE = 'P0001';
  END IF;

  IF v_row.end_time IS NULL OR v_row.end_time > now() THEN
    RAISE EXCEPTION 'expire_timer: timer has not reached end_time yet'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE coachbyte.timers
     SET state = 'expired'
   WHERE user_id = p_user_id
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION private.expire_timer(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION coachbyte.expire_timer()
RETURNS coachbyte.timers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'expire_timer: no authenticated user' USING ERRCODE = '42501';
  END IF;
  RETURN private.expire_timer(v_uid);
END;
$$;

GRANT EXECUTE ON FUNCTION coachbyte.expire_timer() TO authenticated, service_role;

------------------------------------------------------------------
-- private.reset_timer
------------------------------------------------------------------
-- Deletes the caller's timer — used by TodayPage "Reset" button and
-- the MCP reset-timer tool. No state guard: reset is valid from any
-- state (including non-existent: count = 0 is a soft-noop).

CREATE OR REPLACE FUNCTION private.reset_timer(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM coachbyte.timers WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION private.reset_timer(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION coachbyte.reset_timer()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'reset_timer: no authenticated user' USING ERRCODE = '42501';
  END IF;
  RETURN private.reset_timer(v_uid);
END;
$$;

GRANT EXECUTE ON FUNCTION coachbyte.reset_timer() TO authenticated, service_role;

COMMIT;
