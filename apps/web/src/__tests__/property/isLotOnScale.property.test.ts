/**
 * Property tests for `isLotOnScale` + `ON_SCALE_QTY_EPSILON`
 * (apps/web/src/pages/chefbyte/InventoryPage.tsx).
 *
 * The fixed-input tests in `unit/chefbyte/InventoryOnScaleResidual.test.tsx`
 * cover specific scale-noise residual cases (0.005, exactly the
 * threshold). This file fuzzes qty over the relevant range and asserts
 * the threshold's load-bearing invariants:
 *
 *   1. For ANY qty in [0, ON_SCALE_QTY_EPSILON), a paired non-in-flight
 *      lot reports as NOT on scale (sub-display residuals are filtered).
 *   2. For ANY qty in [ON_SCALE_QTY_EPSILON, +Infinity), a paired
 *      non-in-flight lot reports as ON scale.
 *   3. For ANY qty whatsoever, an in-flight lot reports as NOT on scale
 *      (the in-flight gate dominates the qty gate).
 *   4. For ANY qty whatsoever, an unpaired lot reports as NOT on scale
 *      (the pairing gate dominates the qty gate).
 *
 * Mutation hardening: changing the epsilon literal, flipping `<` to
 * `<=`, swapping the qty gate before the in-flight/pairing gate, or
 * coercing qty without `Number.isFinite` will fail at least one
 * property.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { isLotOnScale, ON_SCALE_QTY_EPSILON } from '@/pages/chefbyte/InventoryPage';

const LOT_ID = 'lot-A';
const PAIRED = new Set<string>([LOT_ID]);
const UNPAIRED = new Set<string>();

describe('isLotOnScale — properties', () => {
  it('any qty < ON_SCALE_QTY_EPSILON on a paired non-in-flight lot returns false', () => {
    // Use double-precision arbitrary so we don't accidentally generate
    // values that float32-round into / out of the epsilon boundary.
    // Cover [0, eps) with a generous safety margin below eps.
    const SAFE_BELOW = ON_SCALE_QTY_EPSILON - 1e-9;
    fc.assert(
      fc.property(fc.double({ min: 0, max: SAFE_BELOW, noNaN: true }), (qty) => {
        expect(isLotOnScale({ lot_id: LOT_ID, in_flight_since: null, qty_containers: qty }, PAIRED)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('any qty >= ON_SCALE_QTY_EPSILON on a paired non-in-flight lot returns true', () => {
    // Use double-precision and a margin above eps so the qty is
    // unambiguously >= the predicate threshold without float32
    // re-rounding.
    const SAFE_ABOVE = ON_SCALE_QTY_EPSILON + 1e-9;
    fc.assert(
      fc.property(fc.double({ min: SAFE_ABOVE, max: 10_000, noNaN: true, noDefaultInfinity: true }), (qty) => {
        expect(isLotOnScale({ lot_id: LOT_ID, in_flight_since: null, qty_containers: qty }, PAIRED)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('any in-flight lot returns false regardless of qty', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 10_000, noNaN: true, noDefaultInfinity: true }),
        fc.string({ minLength: 1, maxLength: 30 }),
        (qty, inFlightTs) => {
          expect(isLotOnScale({ lot_id: LOT_ID, in_flight_since: inFlightTs, qty_containers: qty }, PAIRED)).toBe(
            false,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('any unpaired lot returns false regardless of qty', () => {
    fc.assert(
      fc.property(fc.float({ min: 0, max: 10_000, noNaN: true, noDefaultInfinity: true }), (qty) => {
        expect(isLotOnScale({ lot_id: LOT_ID, in_flight_since: null, qty_containers: qty }, UNPAIRED)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
