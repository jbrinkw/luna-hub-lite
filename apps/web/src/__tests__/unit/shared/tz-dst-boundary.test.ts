/**
 * TZ/DST boundary tests for the SHIPPED client logical-date helpers
 * `todayStr` / `toDateStr` from `@/shared/dates`.
 *
 * These tests import and exercise the REAL production functions (not an
 * inline re-implementation). They verify that, when handed the profile's
 * IANA timezone, the client logical-date computation agrees with the SQL
 * `private.get_logical_date(ts, tz, day_start_hour)` contract across:
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
 * To make the assertions deterministic regardless of the HOST timezone the
 * test runner happens to be in, each case:
 *   1. Freezes wall-clock time to a fixed UTC instant via vi.setSystemTime.
 *   2. Calls the shipped `todayStr(dayStartHour, timezone)`.
 *   3. Asserts against a HARD-CODED expected YYYY-MM-DD string.
 *
 * REGRESSION GUARD (audit H-19 / FP-1): the previous version of this file
 * asserted a private inline `getLogicalDate` re-implementation and never
 * imported `todayStr` — so the shipped function could be broken to the UTC
 * bug while this suite stayed green. By importing the real `todayStr`, a
 * reversion of `dates.ts` to `new Date().toLocaleDateString('sv-SE')`
 * (host-tz, no `timezone` param) makes the non-UTC cases below go RED.
 *
 * A paired pgTAP test at supabase/tests/get_logical_date_tz/ exercises the
 * SQL side of the same contract.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { todayStr, toDateStr } from '@/shared/dates';

afterEach(() => {
  vi.useRealTimers();
});

// ─── todayStr(dayStartHour, timezone) — TZ/DST boundary matrix ────────────────
//
// Each row: [timezone, utcInstant, dayStartHour, expectedLogicalDate, description]
// Expected values are pinned (not generated) so the test pins the CONTRACT,
// not whatever the implementation currently does.

const MATRIX: [string, string, number, string, string][] = [
  // UTC — no DST, simple offset subtraction
  ['UTC', '2026-03-08T03:30:00Z', 4, '2026-03-07', 'UTC 3:30am < 4am boundary → previous day'],
  ['UTC', '2026-03-08T04:30:00Z', 4, '2026-03-08', 'UTC 4:30am ≥ 4am boundary → same day'],

  // The exact H-19 verification case: 2026-06-02T09:30:00Z, dsh=6.
  // Browser=UTC would (buggily) give '2026-06-02', but in America/New_York
  // (EDT, UTC-4) the wall clock is 05:30am, which is before the 6am boundary
  // → the logical date is 2026-06-01. This is the row that diverges from the
  // old UTC bug and is the headline regression guard for H-19.
  [
    'America/New_York',
    '2026-06-02T09:30:00Z',
    6,
    '2026-06-01',
    'H-19 case: 09:30Z = 5:30am EDT < 6am → previous day (UTC bug would say 2026-06-02)',
  ],

  // America/New_York spring-forward 2026-03-08 02:00 → 03:00.
  // 2026-03-08T07:00Z = 3:00am EDT (clocks have sprung forward). 3am < 4am → prev day.
  ['America/New_York', '2026-03-08T07:00:00Z', 4, '2026-03-07', 'NYC spring-forward, 3am EDT < 4am → previous day'],
  // 2026-03-08T08:30Z = 4:30am EDT ≥ 4am → same day
  ['America/New_York', '2026-03-08T08:30:00Z', 4, '2026-03-08', 'NYC spring-forward, 4:30am EDT ≥ 4am → same day'],

  // America/New_York fall-back 2026-11-01 02:00 → 01:00 (fall-back is at 06:00Z).
  // At 2026-11-01T07:30Z the clocks have already fallen back → 2:30am EST (UTC-5).
  // 2:30am < 4am → previous day.
  ['America/New_York', '2026-11-01T07:30:00Z', 4, '2026-10-31', 'NYC fall-back: 07:30Z = 2:30am EST → previous day'],

  // Pacific/Auckland — April 2026 is Southern-Hemisphere autumn → NZST = UTC+12.
  // 2026-04-04T15:30Z + 12h = 3:30am Apr-5. 3:30am < 4am → logical date Apr-4.
  [
    'Pacific/Auckland',
    '2026-04-04T15:30:00Z',
    4,
    '2026-04-04',
    'Auckland NZST (UTC+12): 15:30Z = 3:30am Apr-5 < 4am → logical date Apr-4',
  ],

  // Pacific/Honolulu UTC-10 (no DST).
  // 2026-12-31T13:30Z in Honolulu (UTC-10): 03:30am. 3:30am < 4am → previous day → 2026-12-30.
  [
    'Pacific/Honolulu',
    '2026-12-31T13:30:00Z',
    4,
    '2026-12-30',
    'Honolulu UTC-10: 13:30Z = 3:30am < 4am → previous day',
  ],
];

describe('todayStr(dayStartHour, timezone) — TZ/DST boundary matrix', () => {
  describe.each(MATRIX)('%s @ %s (dsh=%i)', (tz, instant, dsh, expected, desc) => {
    it(desc, () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(instant));
      expect(todayStr(dsh, tz)).toBe(expected);
    });
  });
});

describe('todayStr(dayStartHour, timezone) — boundary edge cases', () => {
  it('exactly at the day_start_hour boundary is same-day (>= not >)', () => {
    // UTC 4:00:00am exactly, tz=UTC, dayStartHour=4 → 04:00 - 4h = 00:00 → 2026-03-08
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T04:00:00Z'));
    expect(todayStr(4, 'UTC')).toBe('2026-03-08');
  });

  it('one second before the boundary is the previous day', () => {
    // UTC 3:59:59am, dayStartHour=4 → 03:59:59 - 4h = 23:59:59 previous day
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T03:59:59Z'));
    expect(todayStr(4, 'UTC')).toBe('2026-03-07');
  });

  it('day_start_hour=0 returns the simple timezone-local date', () => {
    // 2026-01-01T00:30Z in NYC (EST, UTC-5) = 19:30 on Dec 31 local → 2025-12-31
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:30:00Z'));
    expect(todayStr(0, 'America/New_York')).toBe('2025-12-31');
  });

  it('does NOT use the host timezone when an IANA tz is supplied (the H-19 fix)', () => {
    // Force a host tz that disagrees with the profile tz: Asia/Tokyo (UTC+9).
    // The instant 2026-06-02T09:30:00Z is 18:30 the same day in Tokyo, but the
    // call asks for America/New_York where it is 5:30am < 6am → previous day.
    // If todayStr ignored the tz arg and used the host clock, it would return
    // 2026-06-02 — this assertion pins that it honors the supplied tz.
    process.env.TZ = 'Asia/Tokyo';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-02T09:30:00Z'));
    try {
      expect(todayStr(6, 'America/New_York')).toBe('2026-06-01');
    } finally {
      delete process.env.TZ;
    }
  });
});

// ─── toDateStr(d, timezone) ──────────────────────────────────────────────────
//
// `toDateStr` formats a specific Date's calendar day in the supplied IANA tz.
// We assert against a fixed instant whose calendar day differs by timezone.

describe('toDateStr(d, timezone)', () => {
  it('formats the calendar date in the supplied timezone', () => {
    // 2026-03-15T02:00:00Z is still 2026-03-14 (10pm) in New York (EDT? no —
    // March 15 2026 is after spring-forward so EDT UTC-4 → 22:00 Mar 14).
    const d = new Date('2026-03-15T02:00:00Z');
    expect(toDateStr(d, 'America/New_York')).toBe('2026-03-14');
    // …and it is already 2026-03-15 in UTC.
    expect(toDateStr(d, 'UTC')).toBe('2026-03-15');
  });

  it('handles the date-line crossing into the next day for far-east zones', () => {
    // 2026-12-31T20:00:00Z is already 2027-01-01 09:00 in Tokyo (UTC+9).
    const d = new Date('2026-12-31T20:00:00Z');
    expect(toDateStr(d, 'Asia/Tokyo')).toBe('2027-01-01');
    expect(toDateStr(d, 'UTC')).toBe('2026-12-31');
  });
});
