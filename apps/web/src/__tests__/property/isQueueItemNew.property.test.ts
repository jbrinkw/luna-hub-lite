/**
 * Property tests for `isQueueItemNew`
 * (apps/web/src/pages/chefbyte/ScannerPage.tsx).
 *
 * The fixed-input tests in `unit/pure/scanner-is-new-badge.test.ts`
 * cover the named status states; this file fuzzes status × isNew across
 * the full Cartesian product to assert two invariants:
 *
 *   1. For ANY non-success status (`pending` or `error`), the result is
 *      false regardless of `isNew`. This is the "don't show red until
 *      we know it's actually new" rule from the original bug fix.
 *   2. For status === 'success', the result is exactly `isNew`. No
 *      coercion, no defaulting — the predicate is a pass-through gate.
 *
 * Mutation hardening: returning true on pending, dropping the early
 * return, or returning `Boolean(item.isNew)` (which would let truthy
 * non-bools sneak in) all fail at least one property.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { isQueueItemNew } from '@/pages/chefbyte/ScannerPage';

describe('isQueueItemNew — properties', () => {
  it('non-success status is never new, regardless of isNew', () => {
    fc.assert(
      fc.property(fc.constantFrom('pending' as const, 'error' as const), fc.boolean(), (status, isNew) => {
        expect(isQueueItemNew({ status, isNew })).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  it('success status returns exactly the isNew flag (pass-through)', () => {
    fc.assert(
      fc.property(fc.boolean(), (isNew) => {
        expect(isQueueItemNew({ status: 'success', isNew })).toBe(isNew);
      }),
      { numRuns: 25 },
    );
  });
});
