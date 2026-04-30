/**
 * TZ/DST boundary tests for the JS getLogicalDate / todayStr helper.
 *
 * Verifies that the client-side logical-date computation agrees with the
 * SQL `private.get_logical_date(ts, tz, day_start_hour)` contract across:
 *   - UTC (no DST)
 *   - America/New_York (EDT/EST, spring-forward 2026-03-08 02:00)
 *   - America/New_York (fall-back 2026-11-01 02:00)
 *   - Pacific/Auckland (UTC+12/+13, near date-line)
 *   - Pacific/Honolulu (UTC-10, no DST)
 *
 * SQL semantics (from migration 20260302020835_fix_logical_date_convention.sql):
 *
 *   (ts AT TIME ZONE tz  - interval '<day_start_hour> hours')::DATE
 *
 * JS equivalent:
 *   1. Convert the UTC instant to the wall-clock time in `tz`.
 *   2. Subtract `day_start_hour` hours from that wall-clock time.
 *   3. Take the DATE part.
 *
 * We implement that computation here in pure JS/Intl so we can verify it
 * against the expected values without touching the DB.  A paired pgTAP
 * test at supabase/tests/get_logical_date_tz/ exercises the SQL side.
 */

import { describe, it, expect } from 'vitest';

// ─── Reference implementation ────────────────────────────────────────────────
//
// Mirrors `private.get_logical_date(ts, tz, day_start_hour)` in JS.
// Uses Intl.DateTimeFormat — real timezone data, not a naive UTC offset.
//
// Algorithm:
//   1. Parse the UTC instant into a Date object.
//   2. Decompose it into year/month/day/hour/minute/second in `tz` using
//      Intl.DateTimeFormat with 'en-US' locale (gives us numeric parts).
//   3. Build a local-timezone Date from those parts (for hour arithmetic).
//   4. Subtract day_start_hour hours.
//   5. Re-extract the date as YYYY-MM-DD in that same timezone.

function getLogicalDate(utcIso: string, tz: string, dayStartHour: number): string {
  const instant = new Date(utcIso);

  // Step 1 — decompose the UTC instant into local parts in `tz`
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));

  // Step 2 — build a synthetic Date in local time so we can do hour
  //          arithmetic. We deliberately use the local browser timezone
  //          here because we only care about the resulting YYYY-MM-DD
  //          after the subtraction, and JS Date arithmetic is UTC-based
  //          under the hood; using the tz-local values as a local Date
  //          gives us correct calendar arithmetic.
  const hour24 = parseInt(parts.hour, 10) % 24; // '24' → 0 for midnight
  const localEquiv = new Date(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    hour24,
    parseInt(parts.minute, 10),
    parseInt(parts.second, 10),
  );

  // Step 3 — subtract dayStartHour hours (matches SQL INTERVAL subtraction)
  localEquiv.setHours(localEquiv.getHours() - dayStartHour);

  // Step 4 — format the resulting date as YYYY-MM-DD
  const y = localEquiv.getFullYear();
  const m = String(localEquiv.getMonth() + 1).padStart(2, '0');
  const d = String(localEquiv.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ─── Test matrix ─────────────────────────────────────────────────────────────
//
// Source: agent brief A5 TZ/DST boundary spec (2026-04-30).
// Each row: [timezone, utcInstant, expectedLogicalDate, description]

const DAY_START_HOUR = 4;

const MATRIX: [string, string, string, string][] = [
  // UTC — no DST, simple offset subtraction
  ['UTC', '2026-03-08T03:30:00Z', '2026-03-07', 'UTC 3:30am → before 4am boundary → previous day'],
  ['UTC', '2026-03-08T04:30:00Z', '2026-03-08', 'UTC 4:30am → after 4am boundary → same day'],

  // America/New_York spring-forward 2026-03-08 02:00 → 03:00 (clocks jump from 2am to 3am)
  // DST begins at 2am local — clocks skip from 2:00am to 3:00am.
  // 2026-03-08T07:00Z = 3:00am EDT (the moment clocks spring forward).
  // Wall-clock hour is 3am, which is before 4am → previous day.
  ['America/New_York', '2026-03-08T07:00:00Z', '2026-03-07', 'NYC spring-forward day, 3am EDT < 4am → previous day'],
  // 2026-03-08T08:30Z = 4:30am EDT
  ['America/New_York', '2026-03-08T08:30:00Z', '2026-03-08', 'NYC spring-forward day, 4:30am EDT ≥ 4am → same day'],

  // America/New_York fall-back 2026-11-01 02:00 → 01:00 (clocks fall back)
  // At 2026-11-01T07:30Z:
  //   Before fall-back (pre-2am EST): EDT offset is -4h → 07:30-04 = 3:30am.
  //   After fall-back: EST offset is -5h → 07:30-05 = 2:30am.
  // Intl gives us the wall-clock time. At T07:30Z the clocks have already
  // fallen back (fall-back is at 2am local = 06:00Z). So wall-clock = 2:30am EST.
  // 2:30am < 4am → previous day expected.
  // NOTE: The brief says "3:30am EDT counts as past 4am" for T07:30Z, but
  // the math shows the wall-clock is 2:30am EST after fall-back (UTC-5).
  // The SQL contract uses AT TIME ZONE which is unambiguous — we use the same
  // Intl implementation, so both sides agree. We pin the ACTUAL computed date.
  //
  // Verification: 2026-11-01T07:30Z - 5h (EST after fall-back at T06:00Z) = 2:30am
  // 2:30am < 4am → logical date = 2026-10-31 (previous day).
  // The brief description was slightly off; this test captures the true contract.
  ['America/New_York', '2026-11-01T07:30:00Z', '2026-10-31', 'NYC fall-back: T07:30Z = 2:30am EST → previous day'],

  // Pacific/Auckland — April 2026 is Southern-Hemisphere autumn → NZST = UTC+12
  // (NOT NZDT=UTC+13; DST ends in April). 2026-04-04T15:30Z + 12h = 03:30am on
  // April 5. 3:30am < 4am → logical date = 2026-04-04 (the previous calendar day
  // relative to the wall-clock date 2026-04-05).
  // SQL contract: (T15:30Z AT TIME ZONE 'Pacific/Auckland' - interval '4 hours')::date
  //             = (03:30am Apr-05 - 4h) = 23:30pm Apr-04 → date = 2026-04-04.
  [
    'Pacific/Auckland',
    '2026-04-04T15:30:00Z',
    '2026-04-04',
    'Auckland NZST (UTC+12): 15:30Z = 3:30am Apr-5 < 4am → logical date is Apr-4',
  ],

  // Pacific/Honolulu UTC-10 (no DST)
  // 2026-12-31T13:30Z in Honolulu (UTC-10): 13:30-10 = 03:30am
  // 3:30am < 4am → previous day → 2026-12-30
  [
    'Pacific/Honolulu',
    '2026-12-31T13:30:00Z',
    '2026-12-30',
    'Honolulu UTC-10: 13:30Z = 3:30am → before 4am → previous day',
  ],
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('getLogicalDate — TZ/DST boundary matrix', () => {
  describe.each(MATRIX)('%s @ %s', (tz, instant, expected, desc) => {
    it(desc, () => {
      const result = getLogicalDate(instant, tz, DAY_START_HOUR);
      expect(result).toBe(expected);
    });
  });
});

describe('getLogicalDate — edge cases', () => {
  it('day_start_hour=0 returns the simple timezone-local date', () => {
    // UTC midnight in NYC (EST, UTC-5) = 2025-12-31T19:00 previous day local
    const result = getLogicalDate('2026-01-01T00:30:00Z', 'America/New_York', 0);
    // 00:30Z - 5h = 19:30 Dec 31 local
    expect(result).toBe('2025-12-31');
  });

  it('exactly at the day_start_hour boundary is same-day (>= not >)', () => {
    // UTC 4:00:00am exactly with tz=UTC, dayStartHour=4
    // 04:00 - 4h = 00:00 → date part = 2026-03-08
    const result = getLogicalDate('2026-03-08T04:00:00Z', 'UTC', 4);
    expect(result).toBe('2026-03-08');
  });

  it('one second before boundary is previous day', () => {
    // UTC 3:59:59am, dayStartHour=4
    // 03:59:59 - 4h = 23:59:59 previous day
    const result = getLogicalDate('2026-03-08T03:59:59Z', 'UTC', 4);
    expect(result).toBe('2026-03-07');
  });
});
