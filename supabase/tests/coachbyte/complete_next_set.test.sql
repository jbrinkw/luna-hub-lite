BEGIN;

SELECT plan(18);

-- ─────────────────────────────────────────────────────────────
-- Setup
-- ─────────────────────────────────────────────────────────────

SELECT tests.create_supabase_user('coach_user');
SELECT tests.authenticate_as('coach_user');

-- Activate coachbyte for the test user (needed for RLS on completed_sets)
SELECT hub.activate_app('coachbyte');

-- Create a daily plan
INSERT INTO coachbyte.daily_plans (plan_id, user_id, plan_date, logical_date, summary)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    tests.get_supabase_uid('coach_user'),
    CURRENT_DATE,
    CURRENT_DATE,
    'Test plan'
);

-- Grab global exercise IDs and insert planned sets
DO $$
DECLARE
    v_squat_id      UUID;
    v_bench_id      UUID;
    v_deadlift_id   UUID;
    v_uid           UUID;
BEGIN
    v_uid := tests.get_supabase_uid('coach_user');

    SELECT exercise_id INTO v_squat_id
    FROM coachbyte.exercises
    WHERE user_id IS NULL AND name = 'Squat'
    LIMIT 1;

    SELECT exercise_id INTO v_bench_id
    FROM coachbyte.exercises
    WHERE user_id IS NULL AND name = 'Bench Press'
    LIMIT 1;

    SELECT exercise_id INTO v_deadlift_id
    FROM coachbyte.exercises
    WHERE user_id IS NULL AND name = 'Deadlift'
    LIMIT 1;

    -- Insert 3 planned sets with distinct orders and rest_seconds
    INSERT INTO coachbyte.planned_sets
        (planned_set_id, plan_id, user_id, exercise_id, "order", target_reps, target_load, rest_seconds)
    VALUES
        ('00000000-0000-0000-0000-000000000011',
         '00000000-0000-0000-0000-000000000001',
         v_uid, v_squat_id,    1, 5, 100.0, 90),
        ('00000000-0000-0000-0000-000000000012',
         '00000000-0000-0000-0000-000000000001',
         v_uid, v_bench_id,   2, 8,  60.0, 60),
        ('00000000-0000-0000-0000-000000000013',
         '00000000-0000-0000-0000-000000000001',
         v_uid, v_deadlift_id, 3, 3, 140.0, 120);
END $$;

-- ─────────────────────────────────────────────────────────────
-- Test 1: Complete first set → completed_set row created
-- ─────────────────────────────────────────────────────────────

SELECT is(
    (SELECT rest_seconds
     FROM coachbyte.complete_next_set(
         '00000000-0000-0000-0000-000000000001',
         5,
         100.0
     )),
    60,
    'completing order 1 returns rest_seconds of order 2 (Bench = 60s)'
);

SELECT is(
    (SELECT COUNT(*)::INTEGER
     FROM coachbyte.completed_sets
     WHERE plan_id = '00000000-0000-0000-0000-000000000001'),
    1,
    'exactly one completed_set row exists after first completion'
);

SELECT is(
    (SELECT planned_set_id
     FROM coachbyte.completed_sets
     WHERE plan_id = '00000000-0000-0000-0000-000000000001'
     ORDER BY completed_at ASC
     LIMIT 1),
    '00000000-0000-0000-0000-000000000011'::UUID,
    'completed_set is linked to planned_set with order 1 (Squat)'
);

SELECT is(
    (SELECT cs.exercise_id
     FROM coachbyte.completed_sets cs
     JOIN coachbyte.planned_sets ps ON ps.planned_set_id = cs.planned_set_id
     WHERE cs.plan_id = '00000000-0000-0000-0000-000000000001'
     ORDER BY cs.completed_at ASC
     LIMIT 1),
    (SELECT ps.exercise_id
     FROM coachbyte.planned_sets ps
     WHERE ps.planned_set_id = '00000000-0000-0000-0000-000000000011'),
    'completed_set exercise_id matches the planned_set exercise (Squat)'
);

-- ─────────────────────────────────────────────────────────────
-- Test: logical_date on completed_set matches the plan's logical_date
-- ─────────────────────────────────────────────────────────────

SELECT is(
    (SELECT cs.logical_date
     FROM coachbyte.completed_sets cs
     WHERE cs.plan_id = '00000000-0000-0000-0000-000000000001'
     ORDER BY cs.completed_at ASC
     LIMIT 1),
    (SELECT dp.logical_date
     FROM coachbyte.daily_plans dp
     WHERE dp.plan_id = '00000000-0000-0000-0000-000000000001'),
    'completed_set logical_date matches the plan logical_date'
);

-- ─────────────────────────────────────────────────────────────
-- Test 2: Returns rest_seconds of the NEXT planned set
-- ─────────────────────────────────────────────────────────────

-- Complete order 2 (Bench). Order 3 has rest_seconds=120, so return 120.
SELECT is(
    (SELECT rest_seconds
     FROM coachbyte.complete_next_set(
         '00000000-0000-0000-0000-000000000001',
         8,
         60.0
     )),
    120,
    'completing order 2 returns rest_seconds of the next set (order 3 = 120s)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 3: Sequential completion — order 2 was just completed
-- ─────────────────────────────────────────────────────────────

SELECT is(
    (SELECT COUNT(*)::INTEGER
     FROM coachbyte.completed_sets
     WHERE plan_id = '00000000-0000-0000-0000-000000000001'),
    2,
    'two completed_set rows exist after second completion'
);

SELECT is(
    (SELECT planned_set_id
     FROM coachbyte.completed_sets
     WHERE plan_id = '00000000-0000-0000-0000-000000000001'
     ORDER BY completed_at ASC
     OFFSET 1 LIMIT 1),
    '00000000-0000-0000-0000-000000000012'::UUID,
    'second completed_set is linked to planned_set with order 2 (Bench Press)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 4: Override reps/load stored correctly in completed_set
-- ─────────────────────────────────────────────────────────────

-- Now complete order 3 (Deadlift) with overridden values
SELECT coachbyte.complete_next_set(
    '00000000-0000-0000-0000-000000000001',
    4,
    150.0
);

SELECT is(
    (SELECT actual_reps
     FROM coachbyte.completed_sets
     WHERE plan_id = '00000000-0000-0000-0000-000000000001'
       AND planned_set_id = '00000000-0000-0000-0000-000000000013'),
    4,
    'overridden reps (4) stored in completed_set for order 3'
);

SELECT is(
    (SELECT actual_load
     FROM coachbyte.completed_sets
     WHERE plan_id = '00000000-0000-0000-0000-000000000001'
       AND planned_set_id = '00000000-0000-0000-0000-000000000013'),
    150.0::NUMERIC,
    'overridden load (150.0) stored in completed_set for order 3'
);

-- ─────────────────────────────────────────────────────────────
-- Test 5: All sets complete → next call returns NULL rest_seconds
-- ─────────────────────────────────────────────────────────────

SELECT is(
    (SELECT rest_seconds
     FROM coachbyte.complete_next_set(
         '00000000-0000-0000-0000-000000000001',
         5,
         100.0
     )),
    NULL::INTEGER,
    'returns NULL rest_seconds when no more planned sets remain'
);

SELECT is(
    (SELECT COUNT(*)::INTEGER
     FROM coachbyte.completed_sets
     WHERE plan_id = '00000000-0000-0000-0000-000000000001'),
    3,
    'completed_sets count is still 3 after calling complete_next_set with no remaining sets'
);

-- ─────────────────────────────────────────────────────────────
-- Test 6: Failed set (0 reps) → completed_set created and tracked
-- ─────────────────────────────────────────────────────────────

-- Set up a fresh plan for failure and edge-case tests
INSERT INTO coachbyte.daily_plans (plan_id, user_id, plan_date, logical_date, summary)
VALUES (
    '00000000-0000-0000-0000-000000000002',
    tests.get_supabase_uid('coach_user'),
    CURRENT_DATE + 1,
    CURRENT_DATE + 1,
    'Edge case plan'
);

DO $$
DECLARE
    v_squat_id UUID;
    v_bench_id UUID;
    v_uid      UUID;
BEGIN
    v_uid := tests.get_supabase_uid('coach_user');

    SELECT exercise_id INTO v_squat_id
    FROM coachbyte.exercises
    WHERE user_id IS NULL AND name = 'Squat'
    LIMIT 1;

    SELECT exercise_id INTO v_bench_id
    FROM coachbyte.exercises
    WHERE user_id IS NULL AND name = 'Bench Press'
    LIMIT 1;

    INSERT INTO coachbyte.planned_sets
        (planned_set_id, plan_id, user_id, exercise_id, "order", target_reps, target_load, rest_seconds)
    VALUES
        ('00000000-0000-0000-0000-000000000021',
         '00000000-0000-0000-0000-000000000002',
         v_uid, v_squat_id, 1, 5, 100.0, 60),
        ('00000000-0000-0000-0000-000000000022',
         '00000000-0000-0000-0000-000000000002',
         v_uid, v_bench_id, 2, 1, 80.0, 90);
END $$;

-- Complete with 0 reps (failed set) — next set (order 2) has rest_seconds=90
SELECT is(
    (SELECT rest_seconds
     FROM coachbyte.complete_next_set(
         '00000000-0000-0000-0000-000000000002',
         0,
         100.0
     )),
    90,
    'completing failed set (0 reps) returns rest_seconds of next set (order 2 = 90s)'
);

SELECT is(
    (SELECT actual_reps
     FROM coachbyte.completed_sets
     WHERE plan_id = '00000000-0000-0000-0000-000000000002'
       AND planned_set_id = '00000000-0000-0000-0000-000000000021'),
    0,
    'failed set (0 reps) is stored in completed_sets'
);

-- ─────────────────────────────────────────────────────────────
-- Test 7: 1-rep set stored correctly
-- ─────────────────────────────────────────────────────────────

-- Complete the 1-rep planned set (order 2) with exactly 1 rep
SELECT coachbyte.complete_next_set(
    '00000000-0000-0000-0000-000000000002',
    1,
    80.0
);

SELECT is(
    (SELECT actual_reps
     FROM coachbyte.completed_sets
     WHERE plan_id = '00000000-0000-0000-0000-000000000002'
       AND planned_set_id = '00000000-0000-0000-0000-000000000022'),
    1,
    '1-rep set is stored correctly in completed_sets'
);

-- ─────────────────────────────────────────────────────────────
-- Test 8: First completion on a fresh plan returns rest_seconds
--         of the SECOND planned set (i.e., the next one)
-- ─────────────────────────────────────────────────────────────

INSERT INTO coachbyte.daily_plans (plan_id, user_id, plan_date, logical_date, summary)
VALUES (
    '00000000-0000-0000-0000-000000000003',
    tests.get_supabase_uid('coach_user'),
    CURRENT_DATE + 2,
    CURRENT_DATE + 2,
    'rest_seconds return value plan'
);

DO $$
DECLARE
    v_squat_id    UUID;
    v_bench_id    UUID;
    v_deadlift_id UUID;
    v_uid         UUID;
BEGIN
    v_uid := tests.get_supabase_uid('coach_user');

    SELECT exercise_id INTO v_squat_id
    FROM coachbyte.exercises
    WHERE user_id IS NULL AND name = 'Squat'
    LIMIT 1;

    SELECT exercise_id INTO v_bench_id
    FROM coachbyte.exercises
    WHERE user_id IS NULL AND name = 'Bench Press'
    LIMIT 1;

    SELECT exercise_id INTO v_deadlift_id
    FROM coachbyte.exercises
    WHERE user_id IS NULL AND name = 'Deadlift'
    LIMIT 1;

    INSERT INTO coachbyte.planned_sets
        (planned_set_id, plan_id, user_id, exercise_id, "order", target_reps, target_load, rest_seconds)
    VALUES
        ('00000000-0000-0000-0000-000000000031',
         '00000000-0000-0000-0000-000000000003',
         v_uid, v_squat_id,    1, 5, 100.0, 45),
        ('00000000-0000-0000-0000-000000000032',
         '00000000-0000-0000-0000-000000000003',
         v_uid, v_bench_id,   2, 8,  60.0, 75),
        ('00000000-0000-0000-0000-000000000033',
         '00000000-0000-0000-0000-000000000003',
         v_uid, v_deadlift_id, 3, 3, 140.0, 180);
END $$;

SELECT is(
    (SELECT rest_seconds
     FROM coachbyte.complete_next_set(
         '00000000-0000-0000-0000-000000000003',
         5,
         100.0
     )),
    75,
    'completing order 1 returns rest_seconds of order 2 (75s)'
);

-- ─────────────────────────────────────────────────────────────
-- Test 9: Cross-user isolation — User B cannot complete User A's plan
-- ─────────────────────────────────────────────────────────────

SELECT tests.create_supabase_user('coach_intruder');
SELECT tests.authenticate_as('coach_intruder');
SELECT hub.activate_app('coachbyte');

SELECT throws_ok(
    $$
        SELECT rest_seconds
        FROM coachbyte.complete_next_set(
            '00000000-0000-0000-0000-000000000003',
            5,
            100.0
        )
    $$,
    'Plan not found or not owned by user',
    'User B calling complete_next_set on User A''s plan raises ownership error'
);

-- ─────────────────────────────────────────────────────────────
-- Test 10: Non-existent plan_id raises error
-- ─────────────────────────────────────────────────────────────

SELECT throws_ok(
    $$
        SELECT rest_seconds
        FROM coachbyte.complete_next_set(
            '00000000-0000-0000-FFFF-FFFFFFFFFFFF',
            5,
            100.0
        )
    $$,
    'Plan not found or not owned by user',
    'complete_next_set with non-existent plan_id raises ownership error'
);

-- ─────────────────────────────────────────────────────────────
-- Teardown
-- ─────────────────────────────────────────────────────────────

SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('coach_user');
SELECT tests.delete_supabase_user('coach_intruder');

SELECT * FROM finish();

ROLLBACK;
