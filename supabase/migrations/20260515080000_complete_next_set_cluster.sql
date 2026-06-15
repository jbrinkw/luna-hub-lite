-- ════════════════════════════════════════════════════════════════════════════
-- complete_next_set cluster — H-2 (PR-DEAD), H-3 (SET-DOUBLE), H-23 (validation)
-- ════════════════════════════════════════════════════════════════════════════
-- Deep-audit findings 2026-06-03 (docs/superpowers/audits/2026-06-03-deep-audit-
-- FINDINGS.md). Three defects all centered on private.complete_next_set /
-- coachbyte.completed_sets:
--
--   H-2  PR-DEAD : private.complete_next_set RETURNS TABLE(rest_seconds, completed)
--                  but TodayPage reads result[0].completed_set_id → always
--                  undefined → the PR self-exclusion guard is a no-op AND the undo
--                  toast (gated on `if (completedSetId)`) never mounts. Two
--                  user-facing features silently dead. Fix: add completed_set_id
--                  to the RETURNS TABLE + RETURN it (the inserted row's id). The
--                  T2-lockdown plpgsql passthrough complete_next_set_admin
--                  (20260515020000) must have its OWN RETURNS TABLE widened to
--                  match, preserving its REVOKE + auth.uid() guard verbatim.
--
--   H-3  SET-DOUBLE : the function finds the next incomplete planned set via
--                  LEFT JOIN then INSERTs with no FOR UPDATE / no ON CONFLICT, and
--                  completed_sets has no unique on planned_set_id. Two overlapping
--                  txns (two tabs, or tab + MCP) both read the slot incomplete and
--                  both insert → a planned_set ends with 2 completed rows
--                  (verified live). Fix: a PARTIAL unique index
--                  UNIQUE (planned_set_id) WHERE planned_set_id IS NOT NULL — it is
--                  declarative (guards ALL current + future writers, not just this
--                  function) and ad-hoc sets (NULL planned_set_id) still allow many
--                  rows. The function CATCHES unique_violation and returns
--                  gracefully (the set IS completed — by the racing writer — so the
--                  user must see success, not an error): it re-reads the existing
--                  completed_set_id for that slot and the now-next rest_seconds.
--
--   H-23 validation : completed_sets CHECKs were actual_reps >= 0 + actual_load >= 0
--                  with NO upper bound, so reps=20/load=5000 → e1RM ~8333 becomes
--                  the permanent max PR. Fix: bound the upper end at the DB layer so
--                  EVERY write path (web complete_next_set, MCP admin, raw inserts)
--                  is protected. Ceilings mirror the existing log_set TS handler
--                  (reps <= 50, load <= 2000 lbs). CRITICAL: the LOWER bound stays
--                  0 — failed sets are logged with actual_reps = 0 (deliberately
--                  allowed since 20260304040002 replaced the old `> 0`) and are
--                  excluded from PR by get_prs. So: reps BETWEEN 0 AND 50,
--                  load BETWEEN 0 AND 2000.
-- ════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- H-3 (part 1) + H-23 — table-level guards on completed_sets
-- ─────────────────────────────────────────────────────────────────────────────

-- Partial unique index: exactly one completed row per planned_set, while ad-hoc
-- sets (planned_set_id IS NULL) remain unconstrained (many allowed).
CREATE UNIQUE INDEX IF NOT EXISTS completed_sets_planned_set_unique
  ON coachbyte.completed_sets (planned_set_id)
  WHERE planned_set_id IS NOT NULL;

-- Upper-bound CHECKs. Replace the existing unbounded constraints
-- (completed_sets_reps_nonnegative from 20260304040002,
--  completed_sets_load_nonnegative from 20260304030000) with bounded variants.
-- Lower bound stays 0 so failed-set logging (actual_reps = 0) keeps working.
ALTER TABLE coachbyte.completed_sets
  DROP CONSTRAINT IF EXISTS completed_sets_reps_nonnegative,
  DROP CONSTRAINT IF EXISTS completed_sets_reps_positive,
  DROP CONSTRAINT IF EXISTS completed_sets_load_nonnegative;

ALTER TABLE coachbyte.completed_sets
  ADD CONSTRAINT completed_sets_reps_bounded
    CHECK (actual_reps >= 0 AND actual_reps <= 50),
  ADD CONSTRAINT completed_sets_load_bounded
    CHECK (actual_load >= 0 AND actual_load <= 2000);

-- ─────────────────────────────────────────────────────────────────────────────
-- H-2 + H-3 (part 2) — private.complete_next_set: return completed_set_id,
--                       perf-scope the PR-check is web-side; here we add the id +
--                       the unique_violation graceful catch.
-- ─────────────────────────────────────────────────────────────────────────────

-- The return type changes (new column) → must DROP before CREATE. Drop the
-- dependent wrappers first (recreated below). private last.
DROP FUNCTION IF EXISTS coachbyte.complete_next_set(UUID, INTEGER, NUMERIC);
DROP FUNCTION IF EXISTS coachbyte.complete_next_set_admin(UUID, UUID, INTEGER, NUMERIC);
DROP FUNCTION IF EXISTS private.complete_next_set(UUID, UUID, INTEGER, NUMERIC);

CREATE OR REPLACE FUNCTION private.complete_next_set(
  p_user_id UUID,
  p_plan_id UUID,
  p_actual_reps INTEGER,
  p_actual_load NUMERIC
)
RETURNS TABLE(rest_seconds INTEGER, completed BOOLEAN, completed_set_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_next_set RECORD;
  v_logical_date DATE;
  v_following_set RECORD;
  v_completed_set_id UUID;
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
    completed_set_id := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Insert completed set. Under a double-complete race (two overlapping txns
  -- both read this slot as incomplete above), the loser's INSERT trips the
  -- partial unique index completed_sets_planned_set_unique. Catch it: the set
  -- IS completed (by the racing winner), so we return success — never error the
  -- user — using the winner's existing completed_set_id.
  BEGIN
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
    )
    RETURNING completed_sets.completed_set_id INTO v_completed_set_id;
  EXCEPTION
    WHEN unique_violation THEN
      -- The racing writer already completed this exact planned_set. Adopt its
      -- row id and fall through to return the next set's rest_seconds.
      SELECT cs.completed_set_id INTO v_completed_set_id
      FROM coachbyte.completed_sets cs
      WHERE cs.planned_set_id = v_next_set.planned_set_id;
  END;

  -- Find the FOLLOWING planned set (next incomplete after the one just completed)
  SELECT ps.rest_seconds INTO v_following_set
  FROM coachbyte.planned_sets ps
  LEFT JOIN coachbyte.completed_sets cs
    ON cs.planned_set_id = ps.planned_set_id
  WHERE ps.plan_id = p_plan_id
    AND cs.completed_set_id IS NULL
  ORDER BY ps."order"
  LIMIT 1;

  -- Return rest_seconds of the next set (NULL if no more sets), completed=true,
  -- and the id of the completed_sets row (newly inserted, or the race winner's).
  rest_seconds := v_following_set.rest_seconds;
  completed := true;
  complete_next_set.completed_set_id := v_completed_set_id;
  RETURN NEXT;
  RETURN;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Public wrapper (authenticated, self) — recreate with widened RETURNS TABLE.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION coachbyte.complete_next_set(
  p_plan_id UUID,
  p_actual_reps INTEGER,
  p_actual_load NUMERIC
)
RETURNS TABLE(rest_seconds INTEGER, completed BOOLEAN, completed_set_id UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM private.complete_next_set(auth.uid(), p_plan_id, p_actual_reps, p_actual_load);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Admin wrapper — PRESERVES the T2 privilege-escalation lockdown
-- (20260515020000 finding H-4): plpgsql, REVOKE FROM PUBLIC/anon/authenticated,
-- in-body auth.uid() self-guard, GRANT service_role. Only the RETURNS TABLE is
-- widened to forward the new completed_set_id column (still SELECT *).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION coachbyte.complete_next_set_admin(
  p_user_id uuid, p_plan_id uuid, p_actual_reps integer, p_actual_load numeric
)
RETURNS TABLE(rest_seconds integer, completed boolean, completed_set_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL
     AND p_user_id IS DISTINCT FROM (SELECT auth.uid())
  THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must equal auth.uid()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT * FROM private.complete_next_set(p_user_id, p_plan_id, p_actual_reps, p_actual_load);
END;
$function$;

REVOKE EXECUTE ON FUNCTION coachbyte.complete_next_set_admin(uuid, uuid, integer, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION coachbyte.complete_next_set_admin(uuid, uuid, integer, numeric) TO service_role;

COMMENT ON FUNCTION coachbyte.complete_next_set_admin(uuid, uuid, integer, numeric) IS
  'Completes p_user_id''s next planned set (MCP wrapper for private.complete_next_set). service_role only; auth.uid() guard + REVOKE block authenticated/anon. [T2 lockdown] RETURNS completed_set_id [H-2].';

GRANT EXECUTE ON FUNCTION coachbyte.complete_next_set(UUID, INTEGER, NUMERIC) TO authenticated;
