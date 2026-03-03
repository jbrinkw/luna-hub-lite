-- pgTAP tests for coachbyte.timers state machine
-- Tests all valid and invalid state transitions enforced via WHERE guards on UPDATE

BEGIN;

SELECT plan(31);

-- ============================================================
-- Setup: create test users
-- ============================================================

SELECT tests.create_supabase_user('timer_user');
SELECT tests.create_supabase_user('timer_user2');

-- ============================================================
-- 1. Insert timer with state=running is valid, end_time set
-- ============================================================

SELECT tests.authenticate_as('timer_user');

INSERT INTO coachbyte.timers (
    timer_id,
    user_id,
    state,
    end_time,
    duration_seconds,
    elapsed_before_pause
) VALUES (
    '00000000-0000-0000-0000-000000000001',
    tests.get_supabase_uid('timer_user'),
    'running',
    now() + interval '60 seconds',
    60,
    0
);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM coachbyte.timers
        WHERE timer_id = '00000000-0000-0000-0000-000000000001'
          AND state = 'running'
          AND end_time IS NOT NULL
    ),
    'Insert timer with state=running succeeds and end_time is set'
);

-- ============================================================
-- 2. running → paused: succeeds, paused_at set, elapsed_before_pause calculated
-- ============================================================

-- Pause the running timer using WHERE state='running' guard
-- elapsed_before_pause = EXTRACT(EPOCH FROM (now() - (end_time - duration_seconds * interval '1 second')))
UPDATE coachbyte.timers
SET
    state = 'paused',
    paused_at = now(),
    elapsed_before_pause = EXTRACT(EPOCH FROM (
        now() - (end_time - (duration_seconds * interval '1 second'))
    ))::INTEGER
WHERE timer_id = '00000000-0000-0000-0000-000000000001'
  AND state = 'running';

SELECT is(
    (SELECT count(*)::INTEGER FROM coachbyte.timers
     WHERE timer_id = '00000000-0000-0000-0000-000000000001' AND state = 'paused'),
    1,
    'running → paused transition succeeds'
);

SELECT ok(
    (SELECT paused_at IS NOT NULL
     FROM coachbyte.timers
     WHERE timer_id = '00000000-0000-0000-0000-000000000001'),
    'paused_at is set after running → paused transition'
);

SELECT ok(
    (SELECT elapsed_before_pause >= 0
     FROM coachbyte.timers
     WHERE timer_id = '00000000-0000-0000-0000-000000000001'),
    'elapsed_before_pause is non-negative after pause'
);

-- ============================================================
-- 3. paused → running: succeeds, new end_time set
-- ============================================================

-- Resume from paused: remaining = duration_seconds - elapsed_before_pause
UPDATE coachbyte.timers
SET
    state = 'running',
    end_time = now() + ((duration_seconds - elapsed_before_pause) * interval '1 second'),
    paused_at = NULL
WHERE timer_id = '00000000-0000-0000-0000-000000000001'
  AND state = 'paused';

SELECT is(
    (SELECT count(*)::INTEGER FROM coachbyte.timers
     WHERE timer_id = '00000000-0000-0000-0000-000000000001' AND state = 'running'),
    1,
    'paused → running transition succeeds'
);

SELECT ok(
    (SELECT end_time > now()
     FROM coachbyte.timers
     WHERE timer_id = '00000000-0000-0000-0000-000000000001'),
    'new end_time is set in the future after paused → running transition'
);

SELECT ok(
    (SELECT paused_at IS NULL
     FROM coachbyte.timers
     WHERE timer_id = '00000000-0000-0000-0000-000000000001'),
    'paused_at is cleared after paused → running transition'
);

-- ============================================================
-- 4. running → expired (WHERE end_time <= NOW()): succeeds
-- ============================================================

-- Set end_time to the past to simulate expiration
UPDATE coachbyte.timers
SET end_time = now() - interval '5 seconds'
WHERE timer_id = '00000000-0000-0000-0000-000000000001';

-- Now transition to expired using the WHERE guard
UPDATE coachbyte.timers
SET state = 'expired'
WHERE timer_id = '00000000-0000-0000-0000-000000000001'
  AND state = 'running'
  AND end_time <= now();

SELECT is(
    (SELECT count(*)::INTEGER FROM coachbyte.timers
     WHERE timer_id = '00000000-0000-0000-0000-000000000001' AND state = 'expired'),
    1,
    'running → expired succeeds when end_time <= now()'
);

-- ============================================================
-- DESIGN NOTE: Tests 5-8 verify application-level state transition guards.
--
-- The timer state machine is enforced at the APPLICATION layer, not the DB.
-- The DB has no trigger or CHECK constraint preventing arbitrary state
-- transitions. The WHERE clauses in these UPDATE statements simulate
-- the guards the frontend/RPC layer applies. Tests 5-8 prove the
-- application-level pattern works (0 rows updated when guard fails).
-- Tests 5b-8b (below) prove the DB itself allows free state updates,
-- making this architectural choice explicit and tested.
-- ============================================================

-- ============================================================
-- 5. paused → paused: no-op (0 rows updated, WHERE guard)
-- ============================================================

-- Insert a fresh paused timer for this test
INSERT INTO coachbyte.timers (
    timer_id,
    user_id,
    state,
    end_time,
    paused_at,
    duration_seconds,
    elapsed_before_pause
) VALUES (
    '00000000-0000-0000-0000-000000000002',
    tests.get_supabase_uid('timer_user'),
    'paused',
    now() + interval '30 seconds',
    now(),
    60,
    30
) ON CONFLICT (user_id) DO UPDATE
    SET timer_id = EXCLUDED.timer_id,
        state = EXCLUDED.state,
        end_time = EXCLUDED.end_time,
        paused_at = EXCLUDED.paused_at,
        duration_seconds = EXCLUDED.duration_seconds,
        elapsed_before_pause = EXCLUDED.elapsed_before_pause;

-- Attempt paused → paused (invalid self-transition via WHERE guard requiring state = 'running')
-- The WHERE guard for pausing requires state = 'running', so this should match 0 rows
WITH update_result AS (
    UPDATE coachbyte.timers
    SET
        state = 'paused',
        paused_at = now()
    WHERE timer_id = '00000000-0000-0000-0000-000000000002'
      AND state = 'running'  -- guard: can only pause if running
    RETURNING timer_id
)
SELECT is(
    (SELECT count(*)::INTEGER FROM update_result),
    0,
    'paused → paused is a no-op (0 rows updated, WHERE guard requires state=running)'
);

-- ============================================================
-- 6. expired → running: rejected (0 rows updated)
-- ============================================================

-- Insert a fresh expired timer for this test (use a new user to avoid UNIQUE conflict)
SELECT tests.authenticate_as('timer_user2');

INSERT INTO coachbyte.timers (
    timer_id,
    user_id,
    state,
    end_time,
    duration_seconds,
    elapsed_before_pause
) VALUES (
    '00000000-0000-0000-0000-000000000003',
    tests.get_supabase_uid('timer_user2'),
    'expired',
    now() - interval '10 seconds',
    60,
    60
);

WITH update_result AS (
    UPDATE coachbyte.timers
    SET
        state = 'running',
        end_time = now() + interval '60 seconds'
    WHERE timer_id = '00000000-0000-0000-0000-000000000003'
      AND state = 'paused'  -- guard: can only resume if paused
    RETURNING timer_id
)
SELECT is(
    (SELECT count(*)::INTEGER FROM update_result),
    0,
    'expired → running is rejected (0 rows updated, WHERE guard requires state=paused)'
);

SELECT is(
    (SELECT state FROM coachbyte.timers WHERE timer_id = '00000000-0000-0000-0000-000000000003'),
    'expired',
    'timer remains expired after rejected expired → running attempt'
);

-- ============================================================
-- 7. expired → paused: rejected (0 rows updated)
-- ============================================================

WITH update_result AS (
    UPDATE coachbyte.timers
    SET
        state = 'paused',
        paused_at = now()
    WHERE timer_id = '00000000-0000-0000-0000-000000000003'
      AND state = 'running'  -- guard: can only pause if running
    RETURNING timer_id
)
SELECT is(
    (SELECT count(*)::INTEGER FROM update_result),
    0,
    'expired → paused is rejected (0 rows updated, WHERE guard requires state=running)'
);

SELECT is(
    (SELECT state FROM coachbyte.timers WHERE timer_id = '00000000-0000-0000-0000-000000000003'),
    'expired',
    'timer remains expired after rejected expired → paused attempt'
);

-- ============================================================
-- 8. paused → expired: rejected (end_time not relevant when paused)
-- ============================================================

-- The timer at 000...002 is in paused state
SELECT tests.authenticate_as('timer_user');

WITH update_result AS (
    UPDATE coachbyte.timers
    SET state = 'expired'
    WHERE timer_id = '00000000-0000-0000-0000-000000000002'
      AND state = 'running'       -- guard: can only expire from running
      AND end_time <= now()
    RETURNING timer_id
)
SELECT is(
    (SELECT count(*)::INTEGER FROM update_result),
    0,
    'paused → expired is rejected (0 rows updated, WHERE guard requires state=running)'
);

SELECT is(
    (SELECT state FROM coachbyte.timers WHERE timer_id = '00000000-0000-0000-0000-000000000002'),
    'paused',
    'timer remains paused after rejected paused → expired attempt'
);

-- ============================================================
-- 5b-8b. POSITIVE: DB allows free state updates without guards
-- Proves the state machine is NOT enforced at DB level (by design).
-- ============================================================

-- 5b. DB allows paused → paused (no WHERE guard)
UPDATE coachbyte.timers
SET state = 'paused', paused_at = now()
WHERE timer_id = '00000000-0000-0000-0000-000000000002';

SELECT is(
    (SELECT state FROM coachbyte.timers
     WHERE timer_id = '00000000-0000-0000-0000-000000000002'),
    'paused',
    'DB allows paused → paused without guards (state machine is app-level)'
);

-- 6b. DB allows expired → running (no WHERE guard)
SELECT tests.authenticate_as('timer_user2');

UPDATE coachbyte.timers
SET state = 'running', end_time = now() + interval '60 seconds'
WHERE timer_id = '00000000-0000-0000-0000-000000000003';

SELECT is(
    (SELECT state FROM coachbyte.timers
     WHERE timer_id = '00000000-0000-0000-0000-000000000003'),
    'running',
    'DB allows expired → running without guards (state machine is app-level)'
);

-- 7b. DB allows running → expired even when end_time is in the future (no WHERE guard)
UPDATE coachbyte.timers
SET state = 'expired'
WHERE timer_id = '00000000-0000-0000-0000-000000000003';

SELECT is(
    (SELECT state FROM coachbyte.timers
     WHERE timer_id = '00000000-0000-0000-0000-000000000003'),
    'expired',
    'DB allows running → expired without end_time check (state machine is app-level)'
);

-- 8b. DB allows expired → paused (no WHERE guard)
UPDATE coachbyte.timers
SET state = 'paused', paused_at = now()
WHERE timer_id = '00000000-0000-0000-0000-000000000003';

SELECT is(
    (SELECT state FROM coachbyte.timers
     WHERE timer_id = '00000000-0000-0000-0000-000000000003'),
    'paused',
    'DB allows expired → paused without guards (state machine is app-level)'
);

-- ============================================================
-- DELETE: owner can delete their own timer
-- ============================================================

SELECT tests.authenticate_as('timer_user2');

DELETE FROM coachbyte.timers
WHERE timer_id = '00000000-0000-0000-0000-000000000003';

SELECT is(
    (SELECT count(*)::INTEGER FROM coachbyte.timers
     WHERE timer_id = '00000000-0000-0000-0000-000000000003'),
    0,
    'Owner can DELETE their own timer'
);

-- Re-insert timer_user2's timer so the UNIQUE constraint test still works
INSERT INTO coachbyte.timers (
    timer_id, user_id, state, end_time, duration_seconds, elapsed_before_pause
) VALUES (
    '00000000-0000-0000-0000-000000000003',
    tests.get_supabase_uid('timer_user2'),
    'expired',
    now() - interval '10 seconds',
    60, 60
);

SELECT tests.authenticate_as('timer_user');

-- ============================================================
-- 9. Only one timer per user (UNIQUE constraint)
-- ============================================================

-- Attempt to insert a second timer for timer_user (who already has one)
-- This should raise an exception due to UNIQUE(user_id)
SELECT throws_ok(
    $$
        INSERT INTO coachbyte.timers (
            timer_id,
            user_id,
            state,
            end_time,
            duration_seconds,
            elapsed_before_pause
        ) VALUES (
            '00000000-0000-0000-0000-000000000099',
            tests.get_supabase_uid('timer_user'),
            'running',
            now() + interval '60 seconds',
            60,
            0
        )
    $$,
    '23505',  -- unique_violation
    NULL,
    'Inserting a second timer for the same user raises a unique_violation'
);

-- ============================================================
-- 10. Starting new timer replaces existing (INSERT ON CONFLICT replaces)
-- ============================================================

-- Capture the existing timer_id for timer_user before replacement
-- (timer_id = 00000000-0000-0000-0000-000000000002 after the UNIQUE conflict redirect earlier)

-- Use INSERT ON CONFLICT (user_id) DO UPDATE to replace the existing timer
INSERT INTO coachbyte.timers (
    timer_id,
    user_id,
    state,
    end_time,
    duration_seconds,
    elapsed_before_pause
) VALUES (
    '00000000-0000-0000-0000-000000000004',
    tests.get_supabase_uid('timer_user'),
    'running',
    now() + interval '90 seconds',
    90,
    0
) ON CONFLICT (user_id) DO UPDATE
    SET timer_id              = EXCLUDED.timer_id,
        state                 = EXCLUDED.state,
        end_time              = EXCLUDED.end_time,
        paused_at             = NULL,
        duration_seconds      = EXCLUDED.duration_seconds,
        elapsed_before_pause  = EXCLUDED.elapsed_before_pause;

-- There must still be exactly one timer for this user
SELECT is(
    (SELECT count(*)::INTEGER FROM coachbyte.timers
     WHERE user_id = tests.get_supabase_uid('timer_user')),
    1,
    'INSERT ON CONFLICT replaces existing timer — still only one timer per user'
);

-- The replacement timer has the new values
SELECT is(
    (SELECT state FROM coachbyte.timers
     WHERE user_id = tests.get_supabase_uid('timer_user')),
    'running',
    'Replacement timer is in running state'
);

SELECT is(
    (SELECT duration_seconds FROM coachbyte.timers
     WHERE user_id = tests.get_supabase_uid('timer_user')),
    90,
    'Replacement timer has new duration_seconds'
);

SELECT ok(
    (SELECT end_time > now() FROM coachbyte.timers
     WHERE user_id = tests.get_supabase_uid('timer_user')),
    'Replacement timer has end_time set in the future'
);

-- ============================================================
-- RLS: user cannot see or modify another user's timer
-- ============================================================

-- timer_user2's timer (000...003) should not be visible to timer_user
SELECT is(
    (SELECT count(*)::INTEGER FROM coachbyte.timers
     WHERE timer_id = '00000000-0000-0000-0000-000000000003'),
    0,
    'RLS: authenticated as timer_user cannot see timer_user2''s timer'
);

-- timer_user2 cannot modify timer_user's timer
SELECT tests.authenticate_as('timer_user2');

WITH update_result AS (
    UPDATE coachbyte.timers
    SET state = 'paused', paused_at = now()
    WHERE user_id = tests.get_supabase_uid('timer_user')
      AND state = 'running'
    RETURNING timer_id
)
SELECT is(
    (SELECT count(*)::INTEGER FROM update_result),
    0,
    'RLS: timer_user2 cannot update timer_user''s timer'
);

-- ============================================================
-- RLS: User B INSERT with User A's user_id — should fail
-- ============================================================

SELECT tests.authenticate_as('timer_user2');

SELECT throws_ok(
    $$
        INSERT INTO coachbyte.timers (
            timer_id, user_id, state, end_time, duration_seconds, elapsed_before_pause
        ) VALUES (
            '00000000-0000-0000-0000-000000000099',
            tests.get_supabase_uid('timer_user'),
            'running',
            now() + interval '60 seconds',
            60,
            0
        )
    $$,
    '42501',
    NULL,
    'RLS: User B cannot insert timer with User A''s user_id'
);

-- ============================================================
-- RLS: User B DELETE on User A's timer — should affect 0 rows
-- ============================================================

DELETE FROM coachbyte.timers
WHERE user_id = tests.get_supabase_uid('timer_user');

-- Verify User A's timer still exists by switching back
SELECT tests.authenticate_as('timer_user');

SELECT is(
    (SELECT count(*)::INTEGER FROM coachbyte.timers
     WHERE user_id = tests.get_supabase_uid('timer_user')),
    1,
    'RLS: User A''s timer still exists after User B''s DELETE attempt'
);

SELECT is(
    (SELECT state FROM coachbyte.timers
     WHERE user_id = tests.get_supabase_uid('timer_user')),
    'running',
    'RLS: User A''s timer state unchanged after User B''s DELETE attempt'
);

-- ============================================================
-- CHECK constraint: invalid state value is rejected
-- ============================================================

SELECT tests.authenticate_as('timer_user');

SELECT throws_ok(
    $$
        UPDATE coachbyte.timers
        SET state = 'invalid_state'
        WHERE user_id = tests.get_supabase_uid('timer_user')
    $$,
    '23514',  -- check_violation
    NULL,
    'Setting state to an invalid value raises a check_violation'
);

-- ============================================================
-- Cleanup
-- ============================================================

SELECT tests.clear_authentication();

SELECT tests.delete_supabase_user('timer_user');
SELECT tests.delete_supabase_user('timer_user2');

SELECT * FROM finish();

ROLLBACK;
