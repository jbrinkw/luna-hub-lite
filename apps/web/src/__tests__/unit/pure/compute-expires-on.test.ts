/**
 * Mutation-hardening tests for `computeExpiresOn`, the pure helper that
 * turns a product's suggested shelf life into a stock lot's `expires_on`.
 *
 * Why this is load-bearing:
 *   - The scanner calls this twice per purchase (merge-key lookup + insert
 *     row). A regression that drifted either call would silently split
 *     lots that should merge, or merge lots that should split.
 *   - The returned string is stored in Postgres DATE and rendered in the
 *     Inventory "nearest expiration" column. A UTC shift would display the
 *     wrong date in any timezone west of UTC.
 *   - null handling is security-adjacent — an accidentally-valid date for
 *     a non-perishable product would spam the "expiring soon" UI.
 */
import { describe, it, expect } from 'vitest';
import { computeExpiresOn } from '@/pages/chefbyte/ScannerPage';

describe('computeExpiresOn', () => {
  it('returns null when shelf life is null', () => {
    expect(computeExpiresOn(null, new Date('2026-04-19T12:00:00'))).toBeNull();
  });

  it('returns null when shelf life is undefined', () => {
    expect(computeExpiresOn(undefined, new Date('2026-04-19T12:00:00'))).toBeNull();
  });

  it('returns null when shelf life is 0 (not a silent "expires today")', () => {
    // A mutation that changed `n <= 0` to `n < 0` would treat 0 as a real
    // shelf life and emit today's date — every newly-scanned pantry staple
    // would appear as "expires today" in the UI.
    expect(computeExpiresOn(0, new Date('2026-04-19T12:00:00'))).toBeNull();
  });

  it('returns null for negative values', () => {
    expect(computeExpiresOn(-7, new Date('2026-04-19T12:00:00'))).toBeNull();
  });

  it('returns null for NaN / non-finite', () => {
    expect(computeExpiresOn(NaN, new Date('2026-04-19T12:00:00'))).toBeNull();
    expect(computeExpiresOn(Infinity, new Date('2026-04-19T12:00:00'))).toBeNull();
  });

  it('adds the days correctly for a typical packaged bread (14 days)', () => {
    expect(computeExpiresOn(14, new Date('2026-04-19T12:00:00'))).toBe('2026-05-03');
  });

  it('handles month rollover', () => {
    // April has 30 days; +20 from April 19 = May 9. A mutation that
    // dropped `setDate` for `setMonth` or swapped addends would fail here.
    expect(computeExpiresOn(20, new Date('2026-04-19T12:00:00'))).toBe('2026-05-09');
  });

  it('handles year rollover', () => {
    expect(computeExpiresOn(30, new Date('2026-12-15T12:00:00'))).toBe('2027-01-14');
  });

  it('handles leap-year Feb 29 correctly', () => {
    // 2024 was a leap year; 2028 is too. Starting Feb 27, +3 = Feb 30
    // doesn't exist → Mar 1 in a non-leap year, Mar 1 in a leap year too
    // (Feb 27 + 3 = Mar 1). We just want to prove the Date arithmetic is
    // calendar-aware, not that we reinvented it.
    expect(computeExpiresOn(3, new Date('2024-02-27T12:00:00'))).toBe('2024-03-01');
  });

  it('floors non-integer shelf life (guards against LLM emitting 7.5)', () => {
    // The edge function rounds, but defense-in-depth: if a fractional
    // number ever reaches this helper, the emitted date should still be
    // a whole day. A mutation that dropped the `Math.floor` would produce
    // Invalid Date from `setDate(NaN)`.
    expect(computeExpiresOn(7.9, new Date('2026-04-19T12:00:00'))).toBe('2026-04-26');
  });

  it('emits local date, not UTC — no off-by-one in west-of-UTC timezones', () => {
    // If the implementation used `.toISOString().slice(0,10)` on a local
    // Date, a purchase made at 11pm local time in America/New_York (UTC-4)
    // with a 1-day shelf life would emit tomorrow-plus-one in UTC, i.e.
    // one day AHEAD of what the user expects. This test pins the local-
    // date formatting.
    const local = new Date(2026, 3 /* April, 0-indexed */, 19, 23, 30); // 11:30pm local
    expect(computeExpiresOn(1, local)).toBe('2026-04-20');
  });

  it('same (purchaseDate, shelfLife) produces identical strings — merge-key stability', () => {
    // Scanner.tsx calls this twice per purchase (merge-key lookup AND
    // insert row). If the two calls ever produced different strings, a
    // purchase would fail to merge into its own freshly-created lot.
    const d = new Date('2026-04-19T14:37:22');
    expect(computeExpiresOn(14, d)).toBe(computeExpiresOn(14, d));
  });
});
