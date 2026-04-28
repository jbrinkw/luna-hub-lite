-- Catch-all delta-capture TTL reaper.
--
-- CONTEXT (2026-04-28):
--   Catch-all in-flight state lives on cloud chefbyte.stock_lots
--   (in_flight_kind='catch_all'), populated by the
--   catch_all_first_measurement apply branch (migration
--   20260427130000). Unlike live_shelf in-flight (whose Pi-local
--   reaper zeros qty + writes food_logs for the presumed-consumed
--   pickup mass), catch-all in-flight that times out should ONLY
--   clear the markers — qty stays at the first-event measured weight
--   and NO food_logs are written.
--
--   Why: a catch-all session that never gets a second measurement
--   means the user weighed an item but didn't put it back. The qty
--   we set on the first event already reflects what's currently in
--   the container (= measured weight / net_weight_g). The user
--   walking away doesn't imply they consumed it; they just didn't
--   complete the delta-capture cycle. Stamping the qty to 0 here
--   would orphan real inventory.
--
-- DESIGN:
--   1. ``private.reap_catch_all_in_flight(ttl_seconds INTEGER, limit INTEGER)``
--      — SECURITY DEFINER plpgsql function that clears
--      in_flight_since / in_flight_kind / pickup_event_id /
--      pickup_weight_g on every catch-all in-flight row whose
--      ``in_flight_since`` is older than ``ttl_seconds``. Returns the
--      reap count.
--   2. ``cron.schedule`` registers it to run every 30 minutes with
--      a 6-hour TTL — same default the Pi reaper uses for live_shelf.
--   3. Local-stack defensiveness: the migration body wraps the
--      cron.schedule call in a NOTICE-on-fail block so a stack
--      without pg_cron (local development) still applies cleanly.
--      The function itself is unconditional.
--
-- NON-GOALS:
--   * Does NOT touch live_shelf in-flight rows. Those are the Pi
--     reaper's responsibility (and Pi-local lots, not cloud_lots).
--   * Does NOT write food_logs (per the design rationale above).
--   * Does NOT bump last_update_ts — the reap is a state cleanup,
--     not a stock mutation; preserving last_update_ts means the
--     "last time the user actually interacted with this lot" is
--     still meaningful for downstream consumers.

BEGIN;

------------------------------------------------------------
-- 1. Reaper function
------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.reap_catch_all_in_flight(
  p_ttl_seconds INTEGER DEFAULT 21600,  -- 6 hours
  p_limit       INTEGER DEFAULT 500
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reaped INTEGER;
BEGIN
  IF p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 THEN
    RETURN 0;
  END IF;

  WITH expired AS (
    SELECT lot_id
      FROM chefbyte.stock_lots
     WHERE in_flight_kind = 'catch_all'
       AND in_flight_since IS NOT NULL
       AND in_flight_since < (now() - make_interval(secs => p_ttl_seconds))
     ORDER BY in_flight_since ASC
     LIMIT p_limit
  ),
  cleared AS (
    UPDATE chefbyte.stock_lots
       SET in_flight_since = NULL,
           in_flight_kind  = NULL,
           pickup_event_id = NULL,
           pickup_weight_g = NULL
     WHERE lot_id IN (SELECT lot_id FROM expired)
       AND in_flight_kind = 'catch_all'
    RETURNING lot_id
  )
  SELECT count(*) INTO v_reaped FROM cleared;

  RETURN COALESCE(v_reaped, 0);
END;
$$;

REVOKE ALL ON FUNCTION private.reap_catch_all_in_flight(INTEGER, INTEGER)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.reap_catch_all_in_flight(INTEGER, INTEGER)
  TO service_role;

COMMENT ON FUNCTION private.reap_catch_all_in_flight(INTEGER, INTEGER) IS
  'Clears in_flight_kind/in_flight_since/pickup_event_id/pickup_weight_g '
  'on catch-all in-flight stock_lots whose in_flight_since is older than '
  'p_ttl_seconds (default 6h). Does NOT change qty_containers and does '
  'NOT write food_logs — a TTL-expired catch-all session means the user '
  'weighed an item but did not complete the delta-capture cycle, not '
  'that they consumed it. Bounded by p_limit (default 500) so a backlog '
  'cannot monopolize the apply path. Returns the reap count.';

------------------------------------------------------------
-- 2. Cron schedule (best effort; local stack lacks pg_cron)
------------------------------------------------------------

DO $$
BEGIN
  PERFORM 1 FROM pg_extension WHERE extname = 'pg_cron';
  IF NOT FOUND THEN
    -- pg_cron not installed (local stack). Ship the function only;
    -- the cloud apply (where pg_cron IS available) will register it.
    RAISE NOTICE 'pg_cron not installed; skipping reap_catch_all_in_flight schedule';
    RETURN;
  END IF;

  -- Idempotent: drop the prior schedule if any, then add a fresh one.
  -- cron.unschedule raises when the job doesn't exist, so swallow.
  BEGIN
    PERFORM cron.unschedule('catch_all_in_flight_reaper');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  PERFORM cron.schedule(
    'catch_all_in_flight_reaper',
    '*/30 * * * *',
    $job$ SELECT private.reap_catch_all_in_flight(); $job$
  );
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'cron.schedule lacked privilege; reaper function created '
               'but not scheduled (cloud apply will retry)';
WHEN OTHERS THEN
  RAISE NOTICE 'cron.schedule failed: %; reaper function created '
               'but not scheduled', SQLERRM;
END;
$$;

COMMIT;
