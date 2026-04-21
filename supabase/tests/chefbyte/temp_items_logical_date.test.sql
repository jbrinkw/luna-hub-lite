-- Audit item #40: temp_items.logical_date stamping semantics.
--
-- temp_items.logical_date is a NOT NULL column with no DB DEFAULT and no
-- INSERT trigger — the caller (UI or MCP tool) computes it via
-- ``private.get_logical_date(now(), profile.timezone, profile.day_start_hour)``
-- and passes the result in. This test pins two properties:
--
--   1. At INSERT time, the caller's stamped logical_date is the one
--      ``private.get_logical_date`` produces under the CURRENT
--      day_start_hour (cross-checked against direct calls).
--   2. AFTER an insert, changing day_start_hour must NOT retroactively
--      rewrite the row. logical_date is a write-time snapshot, not a
--      derived-on-read value.
--
-- Scenario: user's day_start_hour = 4, timezone = America/New_York.
--   t1 = 2026-04-21T03:30:00Z  → logical_date = 2026-04-20 (before rollover)
--   t2 = 2026-04-21T13:00:00Z  → logical_date = 2026-04-21 (after rollover)
--
-- Then flip day_start_hour to 0 and re-read. The first row MUST still
-- report logical_date = 2026-04-20. If a future refactor replaces the
-- column with a GENERATED expression reading from hub.profiles, this
-- test catches it.
--
-- Note on role-switching: private.get_logical_date is SECURITY DEFINER
-- but not granted to authenticated, so sanity-checks that call it
-- directly run unauthenticated. User-scoped INSERTs authenticate first
-- and use pre-computed literal dates (verified by the unauthenticated
-- sanity checks above them).

BEGIN;
SELECT plan(8);

-- ─────────────────────────────────────────────────────────────
-- Part A — Sanity-check the get_logical_date contract at the two
-- wall-clocks this test relies on. Run as superuser (no authenticate_as).
-- ─────────────────────────────────────────────────────────────

-- t1: 2026-04-21T03:30:00Z is 2026-04-20T23:30:00-04 (EDT). Local 23:30
-- is well past the 4am cutover, so the logical_date is STILL 2026-04-20
-- (the current logical day that started at 04:00 on 2026-04-20).
SELECT is(
  private.get_logical_date(
    '2026-04-21T03:30:00Z'::timestamptz,
    'America/New_York',
    4
  ),
  '2026-04-20'::date,
  'get_logical_date(03:30Z, NY, dsh=4) = 2026-04-20 (before rollover)'
);

-- t2: 2026-04-21T13:00:00Z is 2026-04-21T09:00:00-04 (EDT). Local 09:00
-- is after the 4am rollover → logical_date = 2026-04-21.
SELECT is(
  private.get_logical_date(
    '2026-04-21T13:00:00Z'::timestamptz,
    'America/New_York',
    4
  ),
  '2026-04-21'::date,
  'get_logical_date(13:00Z, NY, dsh=4) = 2026-04-21 (after rollover)'
);

-- Boundary case for Part B: t3 = 2026-04-21T07:00:00Z = 03:00 EDT.
--   dsh=4 → 03:00 < 4am → logical_date = 2026-04-20.
--   dsh=0 → 03:00 >= midnight → logical_date = 2026-04-21.
-- This is the key boundary case — a dsh flip would change the answer IF
-- logical_date were derived-on-read.
SELECT is(
  private.get_logical_date(
    '2026-04-21T07:00:00Z'::timestamptz,
    'America/New_York',
    4
  ),
  '2026-04-20'::date,
  'get_logical_date(07:00Z, NY, dsh=4) = 2026-04-20 (3am local < 4am cutover)'
);

-- ─────────────────────────────────────────────────────────────
-- Part B — Authenticate + seed profile. INSERT rows as the user with
-- the dates verified above.
-- ─────────────────────────────────────────────────────────────

SELECT tests.create_supabase_user('temp_dsh');
SELECT tests.authenticate_as('temp_dsh');
SELECT hub.activate_app('chefbyte');

UPDATE hub.profiles
   SET timezone = 'America/New_York',
       day_start_hour = 4
 WHERE user_id = tests.get_supabase_uid('temp_dsh');

-- Row #1 at t1 → logical_date=2026-04-20.
INSERT INTO chefbyte.temp_items (
  temp_id, user_id, name, logical_date,
  calories, carbs, protein, fat,
  created_at
) VALUES (
  '80000000-0000-0000-0000-000000000001',
  tests.get_supabase_uid('temp_dsh'),
  'Late-night snack',
  '2026-04-20'::date,
  180, 20, 5, 8,
  '2026-04-21T03:30:00Z'::timestamptz
);

SELECT is(
  (SELECT logical_date
     FROM chefbyte.temp_items
    WHERE temp_id = '80000000-0000-0000-0000-000000000001'),
  '2026-04-20'::date,
  'temp_items row #1 stamped with logical_date=2026-04-20 at insert'
);

-- Row #2 at t2 → logical_date=2026-04-21.
INSERT INTO chefbyte.temp_items (
  temp_id, user_id, name, logical_date,
  calories, carbs, protein, fat,
  created_at
) VALUES (
  '80000000-0000-0000-0000-000000000002',
  tests.get_supabase_uid('temp_dsh'),
  'Morning coffee',
  '2026-04-21'::date,
  50, 5, 0, 2,
  '2026-04-21T13:00:00Z'::timestamptz
);

SELECT is(
  (SELECT logical_date
     FROM chefbyte.temp_items
    WHERE temp_id = '80000000-0000-0000-0000-000000000002'),
  '2026-04-21'::date,
  'temp_items row #2 stamped with logical_date=2026-04-21 at insert'
);

-- Row #3 at the boundary-case t3 (03:00 EDT) → stamps 2026-04-20 under
-- dsh=4. We'll flip dsh=0 below and confirm this row does NOT mutate
-- even though dsh=0 would have produced 2026-04-21 had it been
-- computed live from the profile.
INSERT INTO chefbyte.temp_items (
  temp_id, user_id, name, logical_date,
  calories, carbs, protein, fat,
  created_at
) VALUES (
  '80000000-0000-0000-0000-000000000003',
  tests.get_supabase_uid('temp_dsh'),
  'Late-late-night snack',
  '2026-04-20'::date,
  90, 10, 2, 3,
  '2026-04-21T07:00:00Z'::timestamptz
);

-- ─────────────────────────────────────────────────────────────
-- Part C — WRITE-TIME INVARIANT. Flip day_start_hour to 0. Neither row
-- must mutate. If a future migration converts logical_date to a
-- GENERATED column reading hub.profiles, row #3's stored value would
-- flip from 2026-04-20 to 2026-04-21; this test catches that.
-- ─────────────────────────────────────────────────────────────

UPDATE hub.profiles
   SET day_start_hour = 0
 WHERE user_id = tests.get_supabase_uid('temp_dsh');

SELECT is(
  (SELECT logical_date
     FROM chefbyte.temp_items
    WHERE temp_id = '80000000-0000-0000-0000-000000000003'),
  '2026-04-20'::date,
  'temp_items row #3 UNCHANGED after day_start_hour flipped 4→0 (write-time snapshot)'
);

-- And rows #1/#2 are untouched too.
SELECT is(
  (SELECT logical_date
     FROM chefbyte.temp_items
    WHERE temp_id = '80000000-0000-0000-0000-000000000001'),
  '2026-04-20'::date,
  'temp_items row #1 UNCHANGED after day_start_hour change'
);

SELECT is(
  (SELECT logical_date
     FROM chefbyte.temp_items
    WHERE temp_id = '80000000-0000-0000-0000-000000000002'),
  '2026-04-21'::date,
  'temp_items row #2 UNCHANGED after day_start_hour change'
);

SELECT * FROM finish();
ROLLBACK;
