BEGIN;
SELECT plan(9);

-- Test 1: Afternoon → same date
SELECT is(
  private.get_logical_date(
    '2026-03-02 14:00:00-05'::timestamptz,
    'America/New_York',
    6
  ),
  '2026-03-02'::date,
  'Afternoon Eastern time returns same date'
);

-- Test 2: Before day boundary (5:59am with day_start=6) → previous date
SELECT is(
  private.get_logical_date(
    '2026-03-02 05:59:00-05'::timestamptz,
    'America/New_York',
    6
  ),
  '2026-03-01'::date,
  '5:59am with day_start=6 returns previous date'
);

-- Test 3: At day boundary (6:00am with day_start=6) → current date
SELECT is(
  private.get_logical_date(
    '2026-03-02 06:00:00-05'::timestamptz,
    'America/New_York',
    6
  ),
  '2026-03-02'::date,
  '6:00am with day_start=6 returns current date'
);

-- Test 4: Midnight boundary (day_start=0) → standard date
SELECT is(
  private.get_logical_date(
    '2026-03-02 23:59:00-05'::timestamptz,
    'America/New_York',
    0
  ),
  '2026-03-02'::date,
  'day_start=0 at 11:59pm returns same date'
);

-- Test 5: Different timezone — UTC 2am = Tokyo 11am
SELECT is(
  private.get_logical_date(
    '2026-03-02 02:00:00+00'::timestamptz,
    'Asia/Tokyo',
    6
  ),
  '2026-03-02'::date,
  'UTC 2am = Tokyo 11am, with day_start=6 returns Mar 2'
);

-- Test 6: day_start_hour = 23 edge case — 11:30pm is already "next day"
-- At 11:30pm ET on Mar 2 with day_start=23, local time is 23:30.
-- Formula: (23:30 - 23 hours) = 00:30 on Mar 2 → logical date = Mar 2
SELECT is(
  private.get_logical_date(
    '2026-03-02 23:30:00-05'::timestamptz,
    'America/New_York',
    23
  ),
  '2026-03-02'::date,
  'day_start=23 at 11:30pm returns current date (new logical day started)'
);

-- Test 7: DST spring-forward boundary — 2026-03-08 America/New_York
-- Clocks spring forward at 2am → 3am. At 2:30am EST (which doesn't exist,
-- but 7:30 UTC = 3:30am EDT after spring forward) with day_start=6,
-- local time 3:30am < 6 → previous logical date (Mar 7)
SELECT is(
  private.get_logical_date(
    '2026-03-08 07:30:00+00'::timestamptz,
    'America/New_York',
    6
  ),
  '2026-03-07'::date,
  'DST spring-forward: 3:30am EDT (after jump) with day_start=6 returns Mar 7'
);

-- Test 8: DST fall-back boundary — 2026-11-01 America/New_York
-- Clocks fall back at 2am → 1am. At 1:30am EDT (first occurrence, UTC 05:30)
-- with day_start=6, local time 1:30am < 6 → previous logical date (Oct 31)
SELECT is(
  private.get_logical_date(
    '2026-11-01 05:30:00+00'::timestamptz,
    'America/New_York',
    6
  ),
  '2026-10-31'::date,
  'DST fall-back: 1:30am EDT (before clocks change) with day_start=6 returns Oct 31'
);

-- Test 9: DST fall-back — after clocks change back (second 1:30am EST = UTC 06:30)
-- Still 1:30am local (now EST), still < 6 → previous logical date (Oct 31)
SELECT is(
  private.get_logical_date(
    '2026-11-01 06:30:00+00'::timestamptz,
    'America/New_York',
    6
  ),
  '2026-10-31'::date,
  'DST fall-back: 1:30am EST (after clocks change) with day_start=6 returns Oct 31'
);

SELECT * FROM finish();
ROLLBACK;
