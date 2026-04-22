-- pgTAP tests for the coachbyte timer state machine.
--
-- This file was rewritten (2026-04-25) after the legacy-test-fidelity
-- audit flagged the original as a tautology: it re-implemented the
-- WHERE-clause guards inside the test SQL and asserted the row count,
-- which passes even when the production client removes every guard.
-- The rewrite calls the NEW private.*_timer / coachbyte.*_timer RPCs
-- introduced in 20260425040000_timer_state_machine_rpcs.sql — the
-- single source of truth for the state machine. Removing a guard
-- inside those RPCs causes the corresponding test to fail.
--
-- State machine:
--
--          ┌── start_timer ──┐ (any state → running)
--          ▼                 │
--        running ─ pause ─► paused
--          │                 │
--          │                 └── resume ─► running
--          │
--          └── expire ─► expired (only if end_time <= now())
--
--        reset_timer (DELETE): any state → (no row), soft-noop when empty
--
-- Each test:
--   1. Seeds DB (via RPC or a narrow direct INSERT for "bad starting
--      state" scenarios).
--   2. Invokes the production RPC (coachbyte.* wrapper, uses the
--      caller's auth.uid()) OR the private.* RPC (by user_id, for
--      tests that exercise multi-user behavior).
--   3. Asserts the DB-visible outcome.

BEGIN;

SELECT plan(43);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('timer_user');
SELECT tests.create_supabase_user('timer_user2');

------------------------------------------------------------
-- 1. start_timer creates a running timer with end_time in the future
------------------------------------------------------------

SELECT tests.authenticate_as('timer_user');

SELECT lives_ok(
  $$ SELECT coachbyte.start_timer(60); $$,
  'start_timer(60) succeeds for authenticated user'
);

SELECT is(
  (SELECT state FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user')),
  'running',
  'start_timer inserts a row with state=running'
);

SELECT ok(
  (SELECT end_time > now() FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user')),
  'start_timer sets end_time in the future'
);

------------------------------------------------------------
-- 2. pause_timer: running → paused, paused_at set, elapsed_before_pause computed
------------------------------------------------------------

SELECT lives_ok(
  $$ SELECT coachbyte.pause_timer(); $$,
  'pause_timer succeeds when state=running'
);

SELECT is(
  (SELECT state FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user')),
  'paused',
  'pause_timer transitions state to paused'
);

SELECT ok(
  (SELECT paused_at IS NOT NULL FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user')),
  'pause_timer sets paused_at'
);

SELECT ok(
  (SELECT elapsed_before_pause >= 0
     FROM coachbyte.timers
    WHERE user_id = tests.get_supabase_uid('timer_user')),
  'pause_timer computes a non-negative elapsed_before_pause'
);

------------------------------------------------------------
-- 3. resume_timer: paused → running, new end_time set, paused_at cleared
------------------------------------------------------------

SELECT lives_ok(
  $$ SELECT coachbyte.resume_timer(); $$,
  'resume_timer succeeds when state=paused'
);

SELECT is(
  (SELECT state FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user')),
  'running',
  'resume_timer transitions state back to running'
);

SELECT ok(
  (SELECT end_time > now() FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user')),
  'resume_timer mints a fresh end_time in the future'
);

SELECT ok(
  (SELECT paused_at IS NULL FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user')),
  'resume_timer clears paused_at'
);

------------------------------------------------------------
-- 4. expire_timer: running → expired (when end_time <= now())
------------------------------------------------------------

-- Force the running timer into the past so expire is legitimate.
-- This is a narrow privileged write to set up the expire scenario — it
-- simulates what the wall clock does after duration_seconds elapses.
UPDATE coachbyte.timers
   SET end_time = now() - interval '5 seconds'
 WHERE user_id = tests.get_supabase_uid('timer_user');

SELECT lives_ok(
  $$ SELECT coachbyte.expire_timer(); $$,
  'expire_timer succeeds when state=running AND end_time <= now()'
);

SELECT is(
  (SELECT state FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user')),
  'expired',
  'expire_timer transitions state to expired'
);

------------------------------------------------------------
-- 5. pause_timer on a paused timer is rejected (guard: state must be running)
------------------------------------------------------------

-- Reset and seed a paused timer via the real RPCs
SELECT coachbyte.reset_timer();
SELECT coachbyte.start_timer(60);
SELECT coachbyte.pause_timer();

SELECT throws_like(
  $$ SELECT coachbyte.pause_timer(); $$,
  '%cannot pause timer in state paused%',
  'pause_timer rejects when state=paused (guard in RPC)'
);

SELECT is(
  (SELECT state FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user')),
  'paused',
  'timer remains paused after rejected pause_timer'
);

------------------------------------------------------------
-- 6. resume_timer on an expired timer is rejected (guard: state must be paused)
------------------------------------------------------------

-- Seed an expired timer for user 2 by starting, forcing end_time past,
-- and calling expire_timer through the real RPC chain.
SELECT tests.authenticate_as('timer_user2');

SELECT coachbyte.start_timer(60);
UPDATE coachbyte.timers
   SET end_time = now() - interval '10 seconds'
 WHERE user_id = tests.get_supabase_uid('timer_user2');
SELECT coachbyte.expire_timer();

SELECT throws_like(
  $$ SELECT coachbyte.resume_timer(); $$,
  '%cannot resume timer in state expired%',
  'resume_timer rejects when state=expired (guard in RPC)'
);

SELECT is(
  (SELECT state FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user2')),
  'expired',
  'timer remains expired after rejected resume_timer'
);

------------------------------------------------------------
-- 7. pause_timer on an expired timer is rejected (guard: state must be running)
------------------------------------------------------------

SELECT throws_like(
  $$ SELECT coachbyte.pause_timer(); $$,
  '%cannot pause timer in state expired%',
  'pause_timer rejects when state=expired (guard in RPC)'
);

SELECT is(
  (SELECT state FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user2')),
  'expired',
  'timer remains expired after rejected pause_timer'
);

------------------------------------------------------------
-- 8. expire_timer on a paused timer is rejected (guard: state must be running)
------------------------------------------------------------

SELECT tests.authenticate_as('timer_user');
-- timer_user currently has a paused timer from test 5

SELECT throws_like(
  $$ SELECT coachbyte.expire_timer(); $$,
  '%cannot expire timer in state paused%',
  'expire_timer rejects when state=paused (guard in RPC)'
);

SELECT is(
  (SELECT state FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user')),
  'paused',
  'timer remains paused after rejected expire_timer'
);

------------------------------------------------------------
-- 9. expire_timer on a running-but-not-yet-due timer is rejected
--    (guard: end_time must be <= now())
------------------------------------------------------------

SELECT coachbyte.reset_timer();
SELECT coachbyte.start_timer(600);  -- 10 minutes out, definitely not due

SELECT throws_like(
  $$ SELECT coachbyte.expire_timer(); $$,
  '%has not reached end_time yet%',
  'expire_timer rejects when end_time > now() (guard in RPC)'
);

SELECT is(
  (SELECT state FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user')),
  'running',
  'timer remains running after rejected expire_timer'
);

------------------------------------------------------------
-- 10. reset_timer deletes the timer and returns 1; empty is a soft-noop
------------------------------------------------------------

SELECT is(
  coachbyte.reset_timer(),
  1,
  'reset_timer returns 1 when a row existed'
);

SELECT is(
  (SELECT count(*)::INTEGER FROM coachbyte.timers
    WHERE user_id = tests.get_supabase_uid('timer_user')),
  0,
  'reset_timer removes the timer row'
);

SELECT is(
  coachbyte.reset_timer(),
  0,
  'reset_timer returns 0 when no timer exists (soft noop, not an error)'
);

------------------------------------------------------------
-- 11. UNIQUE(user_id) — only one timer per user
------------------------------------------------------------

-- Seed a running timer via the RPC, then try to INSERT another row
-- directly for the same user. The UNIQUE constraint on coachbyte.timers
-- (user_id) must raise unique_violation.
SELECT coachbyte.start_timer(60);

SELECT throws_ok(
  format(
    $$ INSERT INTO coachbyte.timers (
         timer_id, user_id, state, end_time, duration_seconds, elapsed_before_pause
       ) VALUES (
         '00000000-0000-0000-0000-000000000099',
         %L,
         'running',
         now() + interval '60 seconds',
         60, 0
       ) $$,
    tests.get_supabase_uid('timer_user')
  ),
  '23505',
  NULL,
  'UNIQUE(user_id) rejects a second timer row per user'
);

------------------------------------------------------------
-- 12. start_timer on an existing timer replaces it (any prior state OK)
------------------------------------------------------------

-- User 1 currently has a running timer from test 11.
-- Pause it, then call start_timer — the result must be a fresh
-- running timer with the new duration, not the paused one.
SELECT coachbyte.pause_timer();

SELECT coachbyte.start_timer(90);

SELECT is(
  (SELECT count(*)::INTEGER FROM coachbyte.timers
    WHERE user_id = tests.get_supabase_uid('timer_user')),
  1,
  'start_timer on an existing paused timer leaves exactly one row (UPSERT)'
);

SELECT is(
  (SELECT state FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user')),
  'running',
  'start_timer resets state to running even if prior was paused'
);

SELECT is(
  (SELECT duration_seconds FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user')),
  90,
  'start_timer updates duration_seconds to the new value'
);

------------------------------------------------------------
-- 13. RLS — user 1 cannot see user 2's timer
------------------------------------------------------------

-- user_user2 currently has an expired timer from test 6.
SELECT is(
  (SELECT count(*)::INTEGER FROM coachbyte.timers
    WHERE user_id = tests.get_supabase_uid('timer_user2')),
  0,
  'RLS: timer_user cannot SELECT timer_user2''s row'
);

------------------------------------------------------------
-- 14. RLS — user 2 cannot pause user 1's timer via the RPC
------------------------------------------------------------

-- The coachbyte.pause_timer() wrapper extracts auth.uid() from JWT,
-- so calling it as user 2 targets user 2's own row — not user 1's.
-- User 2's timer is currently expired, which means pause_timer on
-- their OWN row is rejected by the guard. Either way, user 1's timer
-- must remain running.
SELECT tests.authenticate_as('timer_user2');

SELECT throws_ok(
  $$ SELECT coachbyte.pause_timer(); $$,
  NULL, NULL,
  'pause_timer as timer_user2 raises (own timer is expired, not running)'
);

SELECT tests.authenticate_as('timer_user');

SELECT is(
  (SELECT state FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user')),
  'running',
  'timer_user''s timer is untouched by timer_user2''s pause_timer call'
);

------------------------------------------------------------
-- 15. CHECK constraint: invalid state value still rejected by the DB
------------------------------------------------------------

SELECT throws_ok(
  format(
    $$ UPDATE coachbyte.timers SET state = 'invalid_state'
        WHERE user_id = %L $$,
    tests.get_supabase_uid('timer_user')
  ),
  '23514',
  NULL,
  'CHECK(state) rejects invalid state values'
);

------------------------------------------------------------
-- 16. Service-role overloads — coachbyte.*_timer(p_user_id, ...)
--     introduced in migration 20260425090000. The MCP worker calls
--     these (no JWT available) so the same state-machine guards must
--     apply when the user_id is passed explicitly. We exercise the
--     full happy-path chain: start → pause → resume → reset.
------------------------------------------------------------

-- Authenticate so RLS lets us read timer_user's row after each
-- service-role-grant mutation. (service_role does the write; the
-- authenticated SELECT is just how we verify.)
SELECT tests.authenticate_as('timer_user');
-- Clean slate for the overload walk-through.
SELECT coachbyte.reset_timer();
SELECT tests.clear_authentication();

-- Cache timer_user's UID into a session GUC — service_role has no
-- privileges on the tests schema, so we can't call tests.get_supabase_uid
-- after SET ROLE. Stashing the UUID in a GUC lets each service-role
-- block read it back with current_setting().
SELECT set_config(
  'tests.timer_user_uid',
  tests.get_supabase_uid('timer_user')::text,
  false  -- session-scoped, survives SET ROLE / RESET ROLE
);

-- The service-role overloads are GRANTed only to service_role. Switch
-- roles for these calls so the tests exercise the GRANT correctly.
SET LOCAL ROLE service_role;

SELECT lives_ok(
  $$ SELECT coachbyte.start_timer(current_setting('tests.timer_user_uid')::uuid, 45) $$,
  'service-role start_timer(p_user_id, p_duration_seconds) succeeds'
);

RESET ROLE;
SELECT tests.authenticate_as('timer_user');
SELECT is(
  (SELECT state FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user')),
  'running',
  'service-role start_timer writes a running row'
);
SELECT tests.clear_authentication();
SET LOCAL ROLE service_role;

SELECT lives_ok(
  $$ SELECT coachbyte.pause_timer(current_setting('tests.timer_user_uid')::uuid) $$,
  'service-role pause_timer(p_user_id) succeeds on a running row'
);

RESET ROLE;
SELECT tests.authenticate_as('timer_user');
SELECT is(
  (SELECT state FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user')),
  'paused',
  'service-role pause_timer transitions running → paused'
);
SELECT tests.clear_authentication();
SET LOCAL ROLE service_role;

-- Pausing a paused timer via the service-role overload must still
-- reject with the state-machine guard (same error as the no-arg form).
SELECT throws_like(
  $$ SELECT coachbyte.pause_timer(current_setting('tests.timer_user_uid')::uuid) $$,
  '%cannot pause timer in state paused%',
  'service-role pause_timer rejects when state=paused (guard honored)'
);

SELECT lives_ok(
  $$ SELECT coachbyte.resume_timer(current_setting('tests.timer_user_uid')::uuid) $$,
  'service-role resume_timer(p_user_id) succeeds on a paused row'
);

RESET ROLE;
SELECT tests.authenticate_as('timer_user');
SELECT is(
  (SELECT state FROM coachbyte.timers WHERE user_id = tests.get_supabase_uid('timer_user')),
  'running',
  'service-role resume_timer transitions paused → running'
);
SELECT tests.clear_authentication();
SET LOCAL ROLE service_role;

SELECT is(
  coachbyte.reset_timer(current_setting('tests.timer_user_uid')::uuid),
  1,
  'service-role reset_timer(p_user_id) returns 1 when row existed'
);

-- NULL p_user_id must be rejected (the overloads explicitly guard it).
SELECT throws_like(
  $$ SELECT coachbyte.pause_timer(NULL::uuid) $$,
  '%p_user_id is required%',
  'service-role overloads reject NULL p_user_id'
);

RESET ROLE;

------------------------------------------------------------
-- Cleanup
------------------------------------------------------------

SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('timer_user');
SELECT tests.delete_supabase_user('timer_user2');

SELECT * FROM finish();

ROLLBACK;
