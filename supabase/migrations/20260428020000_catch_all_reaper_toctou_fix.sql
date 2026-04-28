-- Catch-all TTL reaper — TOCTOU race fix.
--
-- CONTEXT (Codex finding HIGH-4 against 20260428000000):
--   The original reaper expressed the TTL predicate ONLY in the CTE
--   ``expired`` selector. The downstream UPDATE rechecked
--   ``in_flight_kind = 'catch_all'`` but did NOT re-assert the age. A
--   concurrent FIRST-measurement that touched the lot between the
--   selector and the UPDATE could refresh ``in_flight_since`` to NOW,
--   yet the lot would still appear in ``expired``'s row set and have
--   its markers wiped because the kind check still passed.
--
--   Concrete race window:
--     T+0:    catch_all_first_measurement bumps in_flight_since=now
--             on lot L (same in_flight_kind='catch_all').
--     T+0+ε:  reaper's CTE was selected at T+0-δ; it has L's lot_id.
--     T+0+ε:  reaper's UPDATE matches WHERE lot_id IN (..) AND
--             in_flight_kind='catch_all'. The fresh row matches both
--             predicates — markers get cleared even though the lot
--             was just refreshed and is NOT actually expired.
--   Result:  the just-started catch-all session loses its in-flight
--             markers; the next event (the SECOND measurement) routes
--             as a FIRST measurement instead, breaking the delta-
--             capture state machine.
--
-- FIX:
--   1. Capture both ``lot_id`` AND the original ``in_flight_since`` in
--      the CTE so the UPDATE can re-assert the SAME age predicate
--      against the SAME timestamp it was selected against. A concurrent
--      refresh bumps ``in_flight_since`` to a value that fails the
--      ``stock_lots.in_flight_since = expired.original_since`` check, so
--      the row is skipped.
--   2. ``FOR UPDATE SKIP LOCKED`` on the CTE so the reaper doesn't
--      contend with another reaper instance or with the apply path's
--      stamping UPDATE. Skipping a row that someone else has locked
--      means we leave it alone for the next reap cycle, which is the
--      exact desired semantics.
--
-- Idempotent: this migration replaces the function in place. The cron
-- schedule from 20260428000000 still references the same name and
-- continues to fire on the new body. No migration of cron config
-- needed.

BEGIN;

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
    -- Snapshot lot_id + the in_flight_since value AT THE TIME the row
    -- was deemed expired. The UPDATE below re-asserts both the kind
    -- AND that original timestamp. A concurrent refresh that bumps
    -- in_flight_since to a newer value (e.g. a fresh
    -- catch_all_first_measurement) makes the UPDATE skip the row —
    -- the user's just-started session is preserved.
    --
    -- FOR UPDATE SKIP LOCKED so a concurrent apply path that already
    -- holds the row's lock is left alone for the next reap cycle.
    SELECT lot_id, in_flight_since AS original_since
      FROM chefbyte.stock_lots
     WHERE in_flight_kind = 'catch_all'
       AND in_flight_since IS NOT NULL
       AND in_flight_since < (now() - make_interval(secs => p_ttl_seconds))
     ORDER BY in_flight_since ASC
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  ),
  cleared AS (
    UPDATE chefbyte.stock_lots sl
       SET in_flight_since = NULL,
           in_flight_kind  = NULL,
           pickup_event_id = NULL,
           pickup_weight_g = NULL
      FROM expired
     WHERE sl.lot_id = expired.lot_id
       AND sl.in_flight_kind = 'catch_all'
       -- TOCTOU guard: only clear if in_flight_since hasn't moved
       -- since we selected it. A concurrent stamp bumps the column
       -- to a newer value and falls out of this predicate.
       AND sl.in_flight_since = expired.original_since
       AND sl.in_flight_since IS NOT NULL
       AND sl.in_flight_since < (now() - make_interval(secs => p_ttl_seconds))
    RETURNING sl.lot_id
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
  'p_ttl_seconds (default 6h). TOCTOU-safe via the original_since predicate '
  'and FOR UPDATE SKIP LOCKED on the CTE selector — a concurrent '
  'catch_all_first_measurement that refreshes in_flight_since cannot '
  'have its markers wiped by an in-flight reap pass. Does NOT change '
  'qty_containers and does NOT write food_logs (a TTL-expired catch-all '
  'session means the user weighed an item but did not complete the '
  'delta-capture cycle, not that they consumed it). Bounded by p_limit '
  '(default 500). Returns the reap count.';

COMMIT;
