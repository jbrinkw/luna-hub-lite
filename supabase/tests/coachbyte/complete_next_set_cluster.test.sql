-- ════════════════════════════════════════════════════════════════════════════
-- complete_next_set cluster — H-2 (PR-DEAD), H-3 (SET-DOUBLE), H-23 (validation)
-- ════════════════════════════════════════════════════════════════════════════
-- Deep-audit findings 2026-06-03: H-2, H-3, H-23.
--
--   H-2  : private.complete_next_set must RETURN the inserted completed_set_id
--          so the web PR self-exclusion + undo toast stop being dead code.
--   H-3  : a planned_set must end with EXACTLY ONE completed row even under a
--          double-complete race — enforced by a partial unique index, with the
--          function catching unique_violation and returning gracefully (success,
--          not an error) because the set IS completed (by the racing writer).
--          Ad-hoc sets (planned_set_id IS NULL) must still allow many rows.
--   H-23 : completed_sets must reject absurd reps/load (PR poisoning) at the DB
--          layer for ALL write paths, while STILL allowing reps=0 (failed sets).
--
-- RED (pre-migration): the completed_set_id assertions fail (column absent from
-- the RETURNS TABLE), the duplicate-planned_set INSERT succeeds (no unique
-- index), and reps=51 / load=2001 inserts succeed (no upper bound).
-- GREEN (post-migration): all pass.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT plan(12);

-- ─────────────────────────────────────────────────────────────
-- Setup
-- ─────────────────────────────────────────────────────────────

SELECT tests.create_supabase_user('cluster_user');
SELECT tests.authenticate_as('cluster_user');
SELECT hub.activate_app('coachbyte');

SELECT tests.get_supabase_uid('cluster_user') AS _uid \gset

INSERT INTO coachbyte.daily_plans (plan_id, user_id, plan_date, logical_date, summary)
VALUES (
  '11111111-0000-0000-0000-000000000001',
  :'_uid'::uuid,
  CURRENT_DATE,
  CURRENT_DATE,
  'Cluster test plan'
);

DO $$
DECLARE
  v_squat_id UUID;
  v_bench_id UUID;
  v_uid      UUID;
BEGIN
  v_uid := tests.get_supabase_uid('cluster_user');

  SELECT exercise_id INTO v_squat_id
  FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Squat' LIMIT 1;
  SELECT exercise_id INTO v_bench_id
  FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Bench Press' LIMIT 1;

  INSERT INTO coachbyte.planned_sets
    (planned_set_id, plan_id, user_id, exercise_id, "order", target_reps, target_load, rest_seconds)
  VALUES
    ('11111111-0000-0000-0000-000000000011',
     '11111111-0000-0000-0000-000000000001', v_uid, v_squat_id, 1, 5, 100.0, 90),
    ('11111111-0000-0000-0000-000000000012',
     '11111111-0000-0000-0000-000000000001', v_uid, v_bench_id, 2, 8,  60.0, 60);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- H-2 — complete_next_set returns a non-null completed_set_id
-- ═══════════════════════════════════════════════════════════════════════════

-- (1) completed_set_id returned is the row actually inserted.
-- Call in a standalone statement first (capturing the returned id) so the
-- INSERT done by the volatile function is committed-visible to the verifying
-- SELECT — a single SELECT is(fn(), (SELECT ...)) would evaluate the sibling
-- subquery against the pre-INSERT statement snapshot.
SELECT completed_set_id AS _returned_id
FROM coachbyte.complete_next_set('11111111-0000-0000-0000-000000000001', 5, 100.0) \gset

SELECT is(
  :'_returned_id'::uuid,
  (SELECT cs.completed_set_id
   FROM coachbyte.completed_sets cs
   WHERE cs.planned_set_id = '11111111-0000-0000-0000-000000000011'),
  'complete_next_set returns the completed_set_id of the row it just inserted'
);

-- (2) That returned id is non-null.
SELECT isnt(
  (SELECT cs.completed_set_id
   FROM coachbyte.completed_sets cs
   WHERE cs.planned_set_id = '11111111-0000-0000-0000-000000000011'),
  NULL,
  'the inserted completed_set row has a non-null completed_set_id (sanity)'
);

-- (3) rest_seconds + completed still returned correctly alongside the new column.
SELECT is(
  (SELECT cns.completed
   FROM coachbyte.complete_next_set(
     '11111111-0000-0000-0000-000000000001', 8, 60.0
   ) cns),
  true,
  'completed=true still returned on a successful completion (order 2)'
);

-- (4) Admin wrapper passes the new column straight through (T2 lockdown shape).
INSERT INTO coachbyte.daily_plans (plan_id, user_id, plan_date, logical_date, summary)
VALUES (
  '11111111-0000-0000-0000-000000000002',
  :'_uid'::uuid, CURRENT_DATE + 1, CURRENT_DATE + 1, 'admin-wrapper plan'
);
DO $$
DECLARE v_squat UUID; v_uid UUID;
BEGIN
  v_uid := tests.get_supabase_uid('cluster_user');
  SELECT exercise_id INTO v_squat FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Squat' LIMIT 1;
  INSERT INTO coachbyte.planned_sets
    (planned_set_id, plan_id, user_id, exercise_id, "order", target_reps, target_load, rest_seconds)
  VALUES ('11111111-0000-0000-0000-000000000021',
    '11111111-0000-0000-0000-000000000002', v_uid, v_squat, 1, 5, 135.0, 90);
END $$;

-- Call via the legit MCP/edge identity: service_role with no JWT claims, so
-- auth.uid() is NULL and the T2 in-body guard is skipped (REVOKE still leaves
-- service_role with EXECUTE). This is the ONLY identity allowed to pass an
-- arbitrary p_user_id — mirrors the lockdown test's CONTROL.
SET LOCAL role = service_role;
SELECT completed_set_id AS _admin_returned_id
FROM coachbyte.complete_next_set_admin(:'_uid'::uuid, '11111111-0000-0000-0000-000000000002', 5, 135.0) \gset
RESET role;

SELECT is(
  :'_admin_returned_id'::uuid,
  (SELECT cs.completed_set_id
   FROM coachbyte.completed_sets cs
   WHERE cs.planned_set_id = '11111111-0000-0000-0000-000000000021'),
  'complete_next_set_admin (service_role) forwards completed_set_id (T2 wrapper RETURNS TABLE updated)'
);
-- Re-establish the authenticated test identity for the remaining assertions.
SELECT tests.authenticate_as('cluster_user');

-- ═══════════════════════════════════════════════════════════════════════════
-- H-3 — exactly ONE completed row per planned_set (double-complete race)
-- ═══════════════════════════════════════════════════════════════════════════

-- Fresh plan with one planned set already completed once (above: order-1 of
-- plan ...0001 is done). A duplicate INSERT into the SAME planned_set slot —
-- the exact outcome of two interleaved txns both reading it incomplete — must
-- be rejected by the partial unique index.
SELECT throws_ok(
  $$
    INSERT INTO coachbyte.completed_sets
      (plan_id, planned_set_id, user_id, exercise_id, actual_reps, actual_load, logical_date)
    SELECT cs.plan_id, cs.planned_set_id, cs.user_id, cs.exercise_id, 1, 1, cs.logical_date
    FROM coachbyte.completed_sets cs
    WHERE cs.planned_set_id = '11111111-0000-0000-0000-000000000011'
  $$,
  '23505',
  NULL,
  'a second completed_set for an already-completed planned_set is rejected (unique_violation)'
);

-- Ad-hoc sets (planned_set_id IS NULL) must STILL allow many rows — the partial
-- index excludes NULLs. Insert two ad-hoc rows for the same exercise.
SELECT lives_ok(
  $$
    INSERT INTO coachbyte.completed_sets
      (plan_id, planned_set_id, user_id, exercise_id, actual_reps, actual_load, logical_date)
    SELECT '11111111-0000-0000-0000-000000000001', NULL,
           tests.get_supabase_uid('cluster_user'),
           (SELECT exercise_id FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Squat' LIMIT 1),
           5, 95, CURRENT_DATE
    FROM generate_series(1, 2)
  $$,
  'two ad-hoc completed_sets (planned_set_id NULL) for the same exercise are allowed (partial index excludes NULL)'
);

-- The function-level conflict catch: a fresh plan whose only set is ALREADY
-- completed (simulating the racing writer having committed first). Calling
-- complete_next_set finds no incomplete set → returns completed=false WITHOUT
-- raising — it must never error the user with a unique_violation.
INSERT INTO coachbyte.daily_plans (plan_id, user_id, plan_date, logical_date, summary)
VALUES ('11111111-0000-0000-0000-000000000003',
  :'_uid'::uuid, CURRENT_DATE + 2, CURRENT_DATE + 2, 'race plan');
DO $$
DECLARE v_squat UUID; v_uid UUID;
BEGIN
  v_uid := tests.get_supabase_uid('cluster_user');
  SELECT exercise_id INTO v_squat FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Squat' LIMIT 1;
  INSERT INTO coachbyte.planned_sets
    (planned_set_id, plan_id, user_id, exercise_id, "order", target_reps, target_load, rest_seconds)
  VALUES ('11111111-0000-0000-0000-000000000031',
    '11111111-0000-0000-0000-000000000003', v_uid, v_squat, 1, 5, 100.0, 90);
  -- racing writer already inserted the completed row:
  INSERT INTO coachbyte.completed_sets
    (plan_id, planned_set_id, user_id, exercise_id, actual_reps, actual_load, logical_date)
  VALUES ('11111111-0000-0000-0000-000000000003',
    '11111111-0000-0000-0000-000000000031', v_uid, v_squat, 5, 100.0, CURRENT_DATE + 2);
END $$;

SELECT is(
  (SELECT cns.completed
   FROM coachbyte.complete_next_set(
     '11111111-0000-0000-0000-000000000003', 5, 100.0
   ) cns),
  false,
  'complete_next_set on a fully-completed plan returns completed=false, never a unique_violation error'
);

SELECT is(
  (SELECT COUNT(*)::INTEGER
   FROM coachbyte.completed_sets
   WHERE planned_set_id = '11111111-0000-0000-0000-000000000031'),
  1,
  'the racing planned_set still has exactly ONE completed row after the second call'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- H-23 — reps/load upper bounds (PR poisoning), reps=0 still allowed
-- ═══════════════════════════════════════════════════════════════════════════

-- reps = 51 rejected
SELECT throws_ok(
  $$
    INSERT INTO coachbyte.completed_sets
      (plan_id, planned_set_id, user_id, exercise_id, actual_reps, actual_load, logical_date)
    VALUES ('11111111-0000-0000-0000-000000000001', NULL,
      tests.get_supabase_uid('cluster_user'),
      (SELECT exercise_id FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Squat' LIMIT 1),
      51, 100, CURRENT_DATE)
  $$,
  '23514',
  NULL,
  'actual_reps = 51 is rejected by the upper-bound CHECK (PR poisoning blocked)'
);

-- load = 2001 rejected
SELECT throws_ok(
  $$
    INSERT INTO coachbyte.completed_sets
      (plan_id, planned_set_id, user_id, exercise_id, actual_reps, actual_load, logical_date)
    VALUES ('11111111-0000-0000-0000-000000000001', NULL,
      tests.get_supabase_uid('cluster_user'),
      (SELECT exercise_id FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Squat' LIMIT 1),
      5, 2001, CURRENT_DATE)
  $$,
  '23514',
  NULL,
  'actual_load = 2001 is rejected by the upper-bound CHECK (PR poisoning blocked)'
);

-- reps = 0 (failed set) STILL allowed — must not regress failed-set logging.
SELECT lives_ok(
  $$
    INSERT INTO coachbyte.completed_sets
      (plan_id, planned_set_id, user_id, exercise_id, actual_reps, actual_load, logical_date)
    VALUES ('11111111-0000-0000-0000-000000000001', NULL,
      tests.get_supabase_uid('cluster_user'),
      (SELECT exercise_id FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Squat' LIMIT 1),
      0, 100, CURRENT_DATE)
  $$,
  'actual_reps = 0 (failed set) is still ACCEPTED (lower bound preserved)'
);

-- reps = 50 and load = 2000 (the ceilings themselves) accepted.
SELECT lives_ok(
  $$
    INSERT INTO coachbyte.completed_sets
      (plan_id, planned_set_id, user_id, exercise_id, actual_reps, actual_load, logical_date)
    VALUES ('11111111-0000-0000-0000-000000000001', NULL,
      tests.get_supabase_uid('cluster_user'),
      (SELECT exercise_id FROM coachbyte.exercises WHERE user_id IS NULL AND name = 'Squat' LIMIT 1),
      50, 2000, CURRENT_DATE)
  $$,
  'boundary reps=50 / load=2000 accepted (inclusive ceilings)'
);

-- ─────────────────────────────────────────────────────────────
-- Teardown
-- ─────────────────────────────────────────────────────────────

SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('cluster_user');

SELECT * FROM finish();

ROLLBACK;
