/**
 * Property tests for `computeExpiresOn` (apps/web/src/pages/chefbyte/ScannerPage.tsx).
 *
 * The fixed-input tests in `unit/pure/compute-expires-on.test.ts` catch
 * the obvious branches; this file fuzzes the input domain with
 * fast-check to assert three load-bearing invariants:
 *
 *   1. For a positive finite `shelfLifeDays` and ANY purchase date, the
 *      result is a valid YYYY-MM-DD string AND its calendar value is
 *      strictly later than the purchase date.
 *   2. For null / undefined / 0 / negative / NaN / Infinity inputs, the
 *      result is null (no silent "today" fallthrough that would let a
 *      bogus shelf-life value mint a same-day-expiring lot).
 *   3. The function is deterministic — calling it twice with equal
 *      inputs yields equal results (no Date.now drift sneaking in).
 *
 * Mutation hardening: removing the `n <= 0` guard, switching `>` to
 * `>=`, dropping `Number.isFinite`, or replacing the local-date format
 * with `toISOString().slice(0, 10)` will fail one of these properties.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeExpiresOn } from '@/pages/chefbyte/ScannerPage';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function localYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

describe('computeExpiresOn — properties', () => {
  it('returns a YYYY-MM-DD string strictly later than purchaseDate for any positive finite days', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.date({
          // Constrain to a reasonable century — JS Date handles wider, but
          // this is the realistic domain for grocery shelf-life math.
          min: new Date('1970-01-01T00:00:00Z'),
          max: new Date('2100-12-31T23:59:59Z'),
          noInvalidDate: true,
        }),
        (days, purchaseDate) => {
          const result = computeExpiresOn(days, purchaseDate);
          expect(result).not.toBeNull();
          expect(result).toMatch(ISO_DATE_RE);
          // Strictly later than the purchase date (in local-date space).
          expect(result! > localYMD(purchaseDate)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('returns null for any non-positive / non-finite / null / undefined input', () => {
    const badNumbers = fc.oneof(
      fc.constant(0),
      fc.integer({ min: -10_000, max: -1 }),
      fc.float({ min: -1e6, max: -Math.fround(1e-6), noNaN: true }),
      fc.constant(NaN),
      fc.constant(Infinity),
      fc.constant(-Infinity),
    );
    fc.assert(
      fc.property(
        fc.oneof(badNumbers, fc.constant(null), fc.constant(undefined)),
        fc.date({ noInvalidDate: true }),
        (badDays, purchaseDate) => {
          expect(computeExpiresOn(badDays as any, purchaseDate)).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('is deterministic for equal inputs', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000 }), fc.date({ noInvalidDate: true }), (days, purchaseDate) => {
        const a = computeExpiresOn(days, purchaseDate);
        const b = computeExpiresOn(days, new Date(purchaseDate.getTime()));
        expect(a).toBe(b);
      }),
      { numRuns: 100 },
    );
  });
});
