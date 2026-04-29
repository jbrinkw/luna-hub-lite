-- Timer expiry sweep — fires every 30s to flip running timers past
-- end_time into the 'expired' state.
--
-- Why: the client-side setTimeout that fires `coachbyte.expire_timer()`
-- gets throttled / suspended when the tab is backgrounded or the phone
-- is locked. R1's audio-cue work shipped a useTimerAudio hook driven by
-- the running→expired state edge — but if the tab never sees that edge
-- the cue never fires. This cron is the server-side fallback: it runs
-- regardless of foreground state, transitions every running-but-past-
-- end_time row to expired, and the realtime subscription on
-- coachbyte.timers then propagates the new state to the open tab where
-- the audio + vibration + notification cues fire.
--
-- Why a sweep loop in plpgsql instead of a single UPDATE:
--   - The client-facing `coachbyte.expire_timer()` RPC encodes the
--     `(running, end_time<=now())` guard once; we want one source of
--     truth. The sweep iterates timers eligible for expiry and dispatches
--     the per-row RPC.
--   - private.expire_timer also returns the row so the realtime layer
--     emits a payload identical to the one a client-driven expiry would
--     emit. A bare `UPDATE coachbyte.timers SET state='expired'` would
--     bypass the RPC's audit trail / RAISE NOTICE behaviour.
--
-- Idempotency: re-running this migration unschedules the prior job by
-- name first. On a local stack without pg_cron the schedule call is
-- caught and skipped (mirrors invariant_monitor_cron.sql pattern).

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

-- Helper: sweep every running timer whose end_time has passed and
-- transition it via private.expire_timer(p_user_id). Returns the count
-- of rows transitioned, useful for log inspection.
CREATE OR REPLACE FUNCTION private.expire_timer_sweep()
  RETURNS INTEGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_count   INTEGER := 0;
BEGIN
  FOR v_user_id IN
    SELECT user_id
      FROM coachbyte.timers
     WHERE state = 'running'
       AND end_time IS NOT NULL
       AND end_time <= now()
  LOOP
    BEGIN
      PERFORM private.expire_timer(v_user_id);
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      -- A guard violation here means the timer raced with a pause /
      -- reset between the SELECT and the RPC; the realtime layer will
      -- carry the correct new state. Skip and keep sweeping.
      RAISE NOTICE 'expire_timer_sweep skipped user=%: %', v_user_id, SQLERRM;
    END;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION private.expire_timer_sweep() FROM PUBLIC;

-- Unschedule any prior version of the job (idempotency on re-run).
DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
     FROM cron.job
    WHERE jobname = 'coachbyte-expire-timer-sweep-30s';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- Schedule every 30s. pg_cron 1.5+ supports sub-minute schedules via
-- the '30 seconds' format; the legacy '*/30 * * * * *' six-field cron
-- was rejected on managed Postgres in 15.x. The 30s cadence keeps the
-- worst-case "phone locks → cue fires" lag at ~30s, vs 60s on a per-
-- minute schedule. (Actual lag is end_time→sweep tick, then realtime
-- → cue: typically <1s after the tick.)
DO $$
BEGIN
  PERFORM cron.schedule(
    'coachbyte-expire-timer-sweep-30s',
    '30 seconds',
    $cron$ SELECT private.expire_timer_sweep(); $cron$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'cron.schedule (30s) failed, falling back to 1 minute: %', SQLERRM;
  -- Fallback to standard 5-field cron at 1-minute cadence on stacks
  -- without sub-minute support. Better than nothing; the audio cue is
  -- delayed up to 60s instead of 30s.
  BEGIN
    PERFORM cron.schedule(
      'coachbyte-expire-timer-sweep-30s',
      '* * * * *',
      $cron$ SELECT private.expire_timer_sweep(); $cron$
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'cron.schedule (1min) also failed (local stack?): %', SQLERRM;
  END;
END $$;
