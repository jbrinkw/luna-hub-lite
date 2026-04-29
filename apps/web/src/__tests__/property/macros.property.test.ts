/**
 * Property tests for `calcCaloriesFromMacros`
 * (apps/web/src/pages/chefbyte/MacroPage.tsx).
 *
 * The fixed-input tests in `unit/pure/macro-calc.test.ts` cover named
 * macro vectors; this file fuzzes the input domain to assert two
 * load-bearing invariants:
 *
 *   1. The 4-4-9 formula holds within float tolerance for ANY
 *      non-negative (protein, carbs, fat) triple. This catches a
 *      coefficient-mutation regression on ANY input, not just the
 *      hand-picked fixtures.
 *   2. The function is monotonic non-decreasing in each argument when
 *      the others are held fixed. Increasing a macro can never lower
 *      the calorie total. Catches a sign flip on any coefficient.
 *
 * Mutation hardening: changing 4*p, 4*c, or 9*f to a different
 * coefficient or a subtraction will violate property #1 immediately on
 * the corresponding shrunk synthetic vector.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { calcCaloriesFromMacros } from '@/pages/chefbyte/MacroPage';

const TOLERANCE = 1e-9;

describe('calcCaloriesFromMacros — properties', () => {
  it('matches the 4-4-9 formula within float tolerance for any non-negative macros', () => {
    fc.assert(
      fc.property(
        // Realistic macro grams — humans don't track 10^15 grams of protein.
        fc.double({ min: 0, max: 10_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 10_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 10_000, noNaN: true, noDefaultInfinity: true }),
        (p, c, f) => {
          const expected = 4 * p + 4 * c + 9 * f;
          // Use a relative tolerance so the test stays meaningful at
          // both small and large macro magnitudes.
          const diff = Math.abs(calcCaloriesFromMacros(p, c, f) - expected);
          // Allow either absolute (small inputs) or relative (large inputs) tolerance.
          expect(diff <= TOLERANCE || diff <= 1e-9 * Math.abs(expected)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('is monotonic non-decreasing in each argument', () => {
    // Increasing one macro while holding the others fixed must never
    // decrease the calorie total. Catches a coefficient sign flip.
    const baseMacro = fc.double({ min: 0, max: 1_000, noNaN: true, noDefaultInfinity: true });
    const delta = fc.double({ min: 0, max: 1_000, noNaN: true, noDefaultInfinity: true });
    fc.assert(
      fc.property(baseMacro, baseMacro, baseMacro, delta, (p, c, f, d) => {
        const base = calcCaloriesFromMacros(p, c, f);
        expect(calcCaloriesFromMacros(p + d, c, f)).toBeGreaterThanOrEqual(base);
        expect(calcCaloriesFromMacros(p, c + d, f)).toBeGreaterThanOrEqual(base);
        expect(calcCaloriesFromMacros(p, c, f + d)).toBeGreaterThanOrEqual(base);
      }),
      { numRuns: 100 },
    );
  });

  it('returns exactly 0 on the all-zero vector (sanity boundary)', () => {
    expect(calcCaloriesFromMacros(0, 0, 0)).toBe(0);
  });
});
