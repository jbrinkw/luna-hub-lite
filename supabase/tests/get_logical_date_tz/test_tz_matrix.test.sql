-- pgTAP: private.get_logical_date() — TZ/DST boundary matrix
--
-- Paired SQL-side companion to:
--   apps/web/src/__tests__/unit/shared/tz-dst-boundary.test.ts
--
-- Both sides use the same test matrix. The JS test verifies the client
-- implementation; this test verifies the SQL implementation.  If they
-- disagree, a migration or JS change broke the contract.
--
-- Function signature (migration 20260302020835_fix_logical_date_convention.sql):
--
--   private.get_logical_date(ts TIMESTAMPTZ, tz TEXT, day_start_hour INTEGER) RETURNS DATE
--
-- SQL semantics:
--   (ts AT TIME ZONE tz  -  day_start_hour * INTERVAL '1 hour')::DATE
--
-- day_start_hour = 4 for all matrix rows (matches JS test).

BEGIN;
SELECT plan(13);

-- ─── UTC rows ────────────────────────────────────────────────────────────────

SELECT is(
  private.get_logical_date('2026-03-08T03:30:00Z'::timestamptz, 'UTC', 4),
  '2026-03-07'::date,
  'UTC 3:30am (before 4am boundary) → previous day'
);

SELECT is(
  private.get_logical_date('2026-03-08T04:30:00Z'::timestamptz, 'UTC', 4),
  '2026-03-08'::date,
  'UTC 4:30am (after 4am boundary) → same day'
);

-- ─── America/New_York — spring-forward 2026-03-08 ───────────────────────────
-- Clocks spring from 2:00am EST to 3:00am EDT at 2026-03-08T07:00Z.
-- T07:00Z = 3:00am EDT; T08:30Z = 4:30am EDT.

SELECT is(
  private.get_logical_date('2026-03-08T07:00:00Z'::timestamptz, 'America/New_York', 4),
  '2026-03-07'::date,
  'NYC spring-forward: T07:00Z = 3:00am EDT < 4am → previous day'
);

SELECT is(
  private.get_logical_date('2026-03-08T08:30:00Z'::timestamptz, 'America/New_York', 4),
  '2026-03-08'::date,
  'NYC spring-forward: T08:30Z = 4:30am EDT ≥ 4am → same day'
);

-- ─── America/New_York — fall-back 2026-11-01 ────────────────────────────────
-- Clocks fall from 2:00am EDT to 1:00am EST at 2026-11-01T06:00Z.
-- At T07:30Z (after fall-back): wall-clock = 2:30am EST (UTC-5).
-- 2:30am < 4am → logical date = 2026-10-31.

SELECT is(
  private.get_logical_date('2026-11-01T07:30:00Z'::timestamptz, 'America/New_York', 4),
  '2026-10-31'::date,
  'NYC fall-back: T07:30Z = 2:30am EST (after fall-back) < 4am → previous day'
);

-- ─── Pacific/Auckland ────────────────────────────────────────────────────────
-- April 2026 is Southern-Hemisphere autumn → NZST (UTC+12, NOT NZDT=UTC+13).
-- 2026-04-04T15:30Z + 12h = 03:30am 2026-04-05.
-- 3:30am < 4am → (03:30am - 4h) = 23:30pm 2026-04-04 → logical date = 2026-04-04.

SELECT is(
  private.get_logical_date('2026-04-04T15:30:00Z'::timestamptz, 'Pacific/Auckland', 4),
  '2026-04-04'::date,
  'Auckland NZST (UTC+12): T15:30Z = 3:30am Apr-5, before 4am → logical date Apr-4'
);

-- ─── Pacific/Honolulu ────────────────────────────────────────────────────────
-- UTC-10, no DST. 2026-12-31T13:30Z - 10h = 03:30am.
-- 3:30am < 4am → (03:30am - 4h) = 23:30pm 2026-12-30 → logical date = 2026-12-30.

SELECT is(
  private.get_logical_date('2026-12-31T13:30:00Z'::timestamptz, 'Pacific/Honolulu', 4),
  '2026-12-30'::date,
  'Honolulu UTC-10: 13:30Z = 3:30am, before 4am → previous day'
);

-- ─── Edge cases ──────────────────────────────────────────────────────────────

-- day_start_hour=0: simple timezone-local date
-- 2026-01-01T00:30Z in NYC EST (UTC-5) = 2025-12-31T19:30 local
SELECT is(
  private.get_logical_date('2026-01-01T00:30:00Z'::timestamptz, 'America/New_York', 0),
  '2025-12-31'::date,
  'day_start_hour=0: 2026-01-01T00:30Z = Dec 31 in NYC (UTC-5)'
);

-- Exactly at the boundary (4:00:00am UTC) = same day
SELECT is(
  private.get_logical_date('2026-03-08T04:00:00Z'::timestamptz, 'UTC', 4),
  '2026-03-08'::date,
  'Exactly at 4am boundary UTC → same day (≥ not >)'
);

-- One second before boundary → previous day
SELECT is(
  private.get_logical_date('2026-03-08T03:59:59Z'::timestamptz, 'UTC', 4),
  '2026-03-07'::date,
  'One second before 4am UTC → previous day'
);

-- ─── Cross-layer consistency spot checks ─────────────────────────────────────
-- For each row, verify that the JS algorithm description also holds:
-- (ts AT TIME ZONE tz - day_start_hour * '1 hour'::INTERVAL)::DATE

-- UTC row 1: (2026-03-08T03:30Z AT TIME ZONE 'UTC' - 4h) = 2026-03-07T23:30 → 2026-03-07
SELECT is(
  ('2026-03-08T03:30:00Z'::timestamptz AT TIME ZONE 'UTC' - interval '4 hours')::date,
  '2026-03-07'::date,
  'Cross-check: AT TIME ZONE algebra matches for UTC row 1'
);

-- NYC fall-back: (2026-11-01T07:30Z AT TIME ZONE 'America/New_York' - 4h)
SELECT is(
  ('2026-11-01T07:30:00Z'::timestamptz AT TIME ZONE 'America/New_York' - interval '4 hours')::date,
  '2026-10-31'::date,
  'Cross-check: AT TIME ZONE algebra matches for NYC fall-back row'
);

-- Auckland NZST: (2026-04-04T15:30Z AT TIME ZONE 'Pacific/Auckland' - 4h)
SELECT is(
  ('2026-04-04T15:30:00Z'::timestamptz AT TIME ZONE 'Pacific/Auckland' - interval '4 hours')::date,
  '2026-04-04'::date,
  'Cross-check: AT TIME ZONE algebra matches for Auckland NZST row'
);

SELECT * FROM finish();
ROLLBACK;
