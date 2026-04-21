-- RLS isolation tests for coachbyte.timers
-- Policies (USING/WITH CHECK auth.uid() = user_id): SELECT, INSERT, UPDATE, DELETE
-- Note: user_id has UNIQUE constraint — one timer per user.
BEGIN;
SELECT plan(6);

-- Setup: two users
SELECT tests.create_supabase_user('timers_rls_a');
SELECT tests.create_supabase_user('timers_rls_b');

SELECT tests.authenticate_as('timers_rls_a');
SELECT hub.activate_app('coachbyte');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('timers_rls_b');
SELECT hub.activate_app('coachbyte');
SELECT tests.clear_authentication();

-- ═══════════════════════════════════════════════════════════════
-- User A creates a timer for themselves.
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('timers_rls_a');

INSERT INTO coachbyte.timers
  (timer_id, user_id, state, end_time, duration_seconds, elapsed_before_pause)
VALUES (
  'd0000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('timers_rls_a'),
  'running',
  now() + interval '90 seconds',
  90, 0
);

-- Regression guard: User A's own SELECT returns their row (policy isn't USING false)
SELECT ok(
  EXISTS (SELECT 1 FROM coachbyte.timers
    WHERE timer_id = 'd0000000-0000-0000-0000-000000000001'),
  'User A can SELECT own timer'
);

-- ═══════════════════════════════════════════════════════════════
-- User B cannot SELECT / UPDATE / DELETE User A's timer
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('timers_rls_b');

SELECT is(
  (SELECT count(*)::integer FROM coachbyte.timers
    WHERE user_id = tests.get_supabase_uid('timers_rls_a')),
  0,
  'User B cannot SELECT User A timers'
);

-- UPDATE via RLS silently affects 0 rows
UPDATE coachbyte.timers SET duration_seconds = 9999
  WHERE timer_id = 'd0000000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('timers_rls_a');
SELECT is(
  (SELECT duration_seconds FROM coachbyte.timers
    WHERE timer_id = 'd0000000-0000-0000-0000-000000000001'),
  90,
  'User B cannot UPDATE User A timers'
);

-- DELETE via RLS silently affects 0 rows
SELECT tests.authenticate_as('timers_rls_b');
DELETE FROM coachbyte.timers
  WHERE timer_id = 'd0000000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('timers_rls_a');
SELECT ok(
  EXISTS (SELECT 1 FROM coachbyte.timers
    WHERE timer_id = 'd0000000-0000-0000-0000-000000000001'),
  'User B cannot DELETE User A timers'
);

-- ═══════════════════════════════════════════════════════════════
-- User B cannot INSERT a timer spoofing User A's user_id
-- WITH CHECK ((select auth.uid()) = user_id) → throws RLS violation
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('timers_rls_b');

SELECT throws_ok(
  $$ INSERT INTO coachbyte.timers
       (timer_id, user_id, state, end_time, duration_seconds, elapsed_before_pause)
     VALUES ('d0000000-0000-0000-0000-00000000000b',
       (SELECT id FROM auth.users
         WHERE raw_user_meta_data->>'test_identifier' = 'timers_rls_a'),
       'running', now() + interval '60 seconds', 60, 0) $$,
  '42501',
  NULL,
  'User B cannot INSERT a timer row owned by User A (RLS WITH CHECK)'
);

-- ═══════════════════════════════════════════════════════════════
-- User A's timer is still untouched (end-to-end regression guard)
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('timers_rls_a');
SELECT is(
  (SELECT state FROM coachbyte.timers
    WHERE timer_id = 'd0000000-0000-0000-0000-000000000001'),
  'running',
  'User A timer state preserved through B''s attacks'
);

-- Teardown
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('timers_rls_a');
SELECT tests.delete_supabase_user('timers_rls_b');

SELECT * FROM finish();
ROLLBACK;
