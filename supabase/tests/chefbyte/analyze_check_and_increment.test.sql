-- H-7 (deep-audit 2026-06-03): analyze-product daily quota must be an
-- ATOMIC check-and-increment, not a client-side read-modify-write.
--
-- The pre-fix edge fn `checkQuota` did:
--   SELECT value → JSON.parse(count) → if (count >= 100) return false
--   → upsert({count: count+1})  (an ABSOLUTE JS-computed value)
-- Two concurrent requests both read count=99, both pass the gate, both
-- write 100 → the 100/day platform-LLM cap is bypassed.
--
-- The fix ports the walmart pattern: private.analyze_check_and_increment
-- performs the gate + the increment INSIDE one SQL statement, so the
-- second caller at the cap is rejected and the counter never advances
-- past the limit.
--
-- This suite asserts the RPC contract that makes the edge fn safe:
--   * fresh user (no row) → allowed, count=1
--   * increments count = count + 1 per call (NOT an absolute write)
--   * at the cap (count = limit) → returns allowed=false WITHOUT
--     bumping count past the cap (idempotent refusal)
--   * a stale-date row (yesterday) RESETS to today's count=1 (preserves
--     the "resets on a new day" semantics the edge fn currently has)
--   * stored shape stays {date, count} JSON in chefbyte.user_config under
--     key 'analyze_quota' (so existing rows + the integration suite keep
--     working)
--   * "concurrency" proof: two sequential calls at limit-1 → the first
--     is allowed (reaches the cap), the second is refused. The atomic
--     statement makes the interleaved-concurrent case equivalent.

BEGIN;
SELECT plan(15);

------------------------------------------------------------
-- Setup
------------------------------------------------------------
SELECT tests.create_supabase_user('analyze_quota_user');
SELECT tests.get_supabase_uid('analyze_quota_user') AS _uid \gset
SELECT tests.create_supabase_user('analyze_quota_attacker');
SELECT tests.get_supabase_uid('analyze_quota_attacker') AS _attacker \gset

-- private.* functions run under service_role (matches canonical pattern).
SET ROLE service_role;

------------------------------------------------------------
-- 1-3. Fresh user → first call allowed, count = 1, row stored as JSON
------------------------------------------------------------
SELECT is(
  (private.analyze_check_and_increment(:'_uid'::uuid, 100)->>'allowed')::boolean,
  true,
  'fresh user: first call is allowed'
);

SELECT is(
  (private.analyze_check_and_increment(:'_uid'::uuid, 100)->>'used')::int,
  2,
  'second call increments used to 2 (count = count + 1, not absolute)'
);

SELECT is(
  (SELECT (value::jsonb->>'count')::int
     FROM chefbyte.user_config
    WHERE user_id = :'_uid'::uuid AND key = 'analyze_quota'),
  2,
  'persisted shape: chefbyte.user_config.value JSON {count} == 2'
);

SELECT is(
  (SELECT value::jsonb->>'date'
     FROM chefbyte.user_config
    WHERE user_id = :'_uid'::uuid AND key = 'analyze_quota'),
  (now() AT TIME ZONE 'UTC')::date::text,
  'persisted shape: value JSON {date} == today (UTC)'
);

------------------------------------------------------------
-- 4-6. At-the-cap refusal WITHOUT over-increment (the H-7 core).
-- Seed count = limit-1 (=2 with p_max=3), then:
--   call A → allowed, reaches count=3 (the cap)
--   call B → refused, count stays 3 (does NOT become 4)
------------------------------------------------------------
UPDATE chefbyte.user_config
   SET value = jsonb_build_object('date', (now() AT TIME ZONE 'UTC')::date::text, 'count', 2)::text
 WHERE user_id = :'_uid'::uuid AND key = 'analyze_quota';

SELECT is(
  (private.analyze_check_and_increment(:'_uid'::uuid, 3)->>'allowed')::boolean,
  true,
  'call A at limit-1: allowed (reaches the cap)'
);

SELECT is(
  (SELECT (value::jsonb->>'count')::int
     FROM chefbyte.user_config
    WHERE user_id = :'_uid'::uuid AND key = 'analyze_quota'),
  3,
  'after call A: count == limit (3)'
);

-- call B is the SECOND concurrent request in the race. The atomic RPC
-- must refuse it AND leave the counter at the cap.
SELECT is(
  (private.analyze_check_and_increment(:'_uid'::uuid, 3)->>'allowed')::boolean,
  false,
  'call B at the cap: REFUSED (the H-7 bypass is closed)'
);

SELECT is(
  (SELECT (value::jsonb->>'count')::int
     FROM chefbyte.user_config
    WHERE user_id = :'_uid'::uuid AND key = 'analyze_quota'),
  3,
  'after refused call B: count UNCHANGED at the cap (no over-increment past limit)'
);

-- A further refused call is still refused + still pinned at the cap.
SELECT is(
  (private.analyze_check_and_increment(:'_uid'::uuid, 3)->>'allowed')::boolean,
  false,
  'repeated over-cap call stays refused (idempotent refusal)'
);

------------------------------------------------------------
-- 7. Daily reset: a stale-date row (yesterday) at the cap resets to
-- today with count = 1 on the next call.
------------------------------------------------------------
UPDATE chefbyte.user_config
   SET value = jsonb_build_object(
                 'date', ((now() AT TIME ZONE 'UTC')::date - 1)::text,
                 'count', 999)::text
 WHERE user_id = :'_uid'::uuid AND key = 'analyze_quota';

SELECT is(
  (private.analyze_check_and_increment(:'_uid'::uuid, 100)->>'allowed')::boolean,
  true,
  'stale-date (yesterday) row: next call is allowed (quota reset)'
);

SELECT is(
  (SELECT (value::jsonb->>'count')::int
     FROM chefbyte.user_config
    WHERE user_id = :'_uid'::uuid AND key = 'analyze_quota'),
  1,
  'daily reset: count restarts at 1 for the new UTC day'
);

------------------------------------------------------------
-- 8. p_user_id NULL guard (defensive — service-role caller must supply it).
------------------------------------------------------------
SELECT throws_ok(
  $$ SELECT private.analyze_check_and_increment(NULL::uuid, 100) $$,
  'p_user_id required',
  'NULL p_user_id raises'
);

------------------------------------------------------------
-- 9-11. T2 cross-tenant guard on the PostgREST wrapper.
-- An authenticated caller may only bump THEIR OWN counter; calling the
-- chefbyte wrapper with a victim's user_id must raise insufficient_privilege
-- (else an attacker could exhaust a victim's analyze quota — a DoS).
------------------------------------------------------------
RESET ROLE;
SELECT tests.authenticate_as('analyze_quota_attacker');

-- attacker bumping their OWN counter is fine.
SELECT is(
  (chefbyte.analyze_check_and_increment(:'_attacker'::uuid, 100)->>'allowed')::boolean,
  true,
  'wrapper: authenticated caller may bump their own counter'
);

-- attacker targeting the VICTIM (_uid) must be refused by the auth.uid() guard.
SELECT throws_ok(
  format($$ SELECT chefbyte.analyze_check_and_increment(%L::uuid, 100) $$, :'_uid'),
  42501,
  NULL,
  'wrapper: authenticated caller targeting another user raises insufficient_privilege (T2)'
);

-- ...and the victim's counter was NOT touched by the refused call. The
-- victim's last successful state (from the daily-reset test) was count=1;
-- the refused attacker call must leave it untouched. Read as service_role
-- (RLS would hide the victim's row from the attacker identity).
SELECT tests.clear_authentication();
SET ROLE service_role;
SELECT is(
  (SELECT (value::jsonb->>'count')::int
     FROM chefbyte.user_config
    WHERE user_id = :'_uid'::uuid AND key = 'analyze_quota'),
  1,
  'wrapper: refused cross-tenant call did NOT advance the victim counter'
);

------------------------------------------------------------
-- Teardown
------------------------------------------------------------
RESET ROLE;
SELECT tests.delete_supabase_user('analyze_quota_user');
SELECT tests.delete_supabase_user('analyze_quota_attacker');

SELECT * FROM finish();
ROLLBACK;
