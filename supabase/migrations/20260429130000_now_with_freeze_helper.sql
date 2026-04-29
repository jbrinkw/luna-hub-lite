-- Phase-2 audit harness: clock-freeze affordance.
--
-- Provides ``private.now_with_freeze()`` — a thin wrapper around ``now()``
-- that returns the value of the ``app.frozen_now`` GUC when set, or the
-- real ``now()`` when not. The L7 (time-boundary) audit harness uses this
-- via ``SET LOCAL app.frozen_now = '<iso8601>'`` inside a scenario
-- transaction so the same plpgsql can run at UTC-midnight, local-midnight,
-- DST transitions, and leap-day without time-machining the OS clock.
--
-- DO NOT retrofit existing functions to call this yet. The strategy
-- (AUDIT_STRATEGY_MERGED.md §5) explicitly says: "provide the
-- affordance, but don't rewire ``private.get_logical_date()`` here".
-- That migration lands as a separate change once the harness has
-- exercised it end-to-end.
--
-- Idempotent CREATE OR REPLACE — safe to re-run during a ``db reset``.
-- ``SECURITY INVOKER`` is correct: the function only reads a GUC and
-- ``now()``; it has no privileged side-effects, so it must run with the
-- caller's RLS context. Marking it ``STABLE`` lets the planner constant-
-- fold inside a single statement, mirroring the optimization profile of
-- raw ``now()``.

CREATE OR REPLACE FUNCTION private.now_with_freeze()
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.frozen_now', true), '')::timestamptz,
    now()
  );
$$;

COMMENT ON FUNCTION private.now_with_freeze() IS
  'L7 clock-freeze helper. Returns app.frozen_now GUC if set, else now(). '
  'Used by scripts/harness/clock_freeze.py to drive time-boundary scenarios. '
  'Existing get_logical_date() callers are NOT rewired by this migration.';

-- Smoke check: function exists + returns timestamptz under both branches.
DO $$
DECLARE
  v_now_real timestamptz;
  v_now_frozen timestamptz;
BEGIN
  v_now_real := private.now_with_freeze();
  IF v_now_real IS NULL THEN
    RAISE EXCEPTION 'now_with_freeze() returned NULL with no GUC set';
  END IF;

  PERFORM set_config('app.frozen_now', '2024-02-29T00:00:00Z', true);
  v_now_frozen := private.now_with_freeze();
  IF v_now_frozen <> '2024-02-29T00:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'now_with_freeze() did not honor app.frozen_now GUC; got %',
      v_now_frozen;
  END IF;

  -- Reset for the rest of this transaction so subsequent migrations see
  -- real wall-clock.
  PERFORM set_config('app.frozen_now', '', true);
END $$;
