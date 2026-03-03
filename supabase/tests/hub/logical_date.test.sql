BEGIN;
SELECT plan(5);

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

SELECT * FROM finish();
ROLLBACK;
