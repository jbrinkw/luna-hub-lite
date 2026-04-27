import { describe, it, expect } from 'vitest';
import { isQueueItemNew } from '@/pages/chefbyte/ScannerPage';

/**
 * The badge / red-vs-green treatment is the user-visible signal for
 * "this product is brand new and the system doesn't know it yet". It must
 * fire ONLY for placeholder products that the user still has to finish
 * describing (filling in macros / name).
 *
 * The user-reported bug:
 *   "I scanned chocolate milk (a known product with macros already in the
 *    catalog) and the queue row showed up RED as if it were brand new."
 *
 * Pre-fix, the row color was driven by `confirmed` which started false on
 * every scan and only flipped true on click-away — so EVERY scan looked red,
 * regardless of whether the product was known. Fix routes the predicate
 * through `isQueueItemNew` (delegating to the canonical `isNew` flag), and
 * the success path auto-confirms known products.
 */
describe('isQueueItemNew (queue row red-vs-green predicate)', () => {
  it('returns false for a known product on a successful scan', () => {
    // Re-scanning chocolate milk (already in catalog with macros): the
    // user shouldn't see the red "needs attention" treatment.
    expect(isQueueItemNew({ status: 'success', isNew: false })).toBe(false);
  });

  it('returns true for a newly-created placeholder product', () => {
    // Unknown barcode → analyze-product fails / no AI suggestion → we wrote
    // a placeholder row. The user has to finish entering name + macros, so
    // the queue row stays red.
    expect(isQueueItemNew({ status: 'success', isNew: true })).toBe(true);
  });

  it('returns false while the scan is still pending', () => {
    // pending state has its own amber border treatment; this predicate
    // must not declare the row "new" until the scan resolves.
    expect(isQueueItemNew({ status: 'pending', isNew: false })).toBe(false);
    expect(isQueueItemNew({ status: 'pending', isNew: true })).toBe(false);
  });

  it('returns false on error rows so they keep the error border treatment', () => {
    // Error rows are colored by status, not by isNew, so the predicate
    // must collapse to false to avoid double-tagging error + new.
    expect(isQueueItemNew({ status: 'error', isNew: true })).toBe(false);
    expect(isQueueItemNew({ status: 'error', isNew: false })).toBe(false);
  });

  it('exhaustively distinguishes known/new across both terminal states', () => {
    // Truth table — locks in the contract for future readers.
    const cases: Array<{
      input: { status: 'success' | 'pending' | 'error'; isNew: boolean };
      expected: boolean;
    }> = [
      { input: { status: 'success', isNew: false }, expected: false }, // known catalog hit → green
      { input: { status: 'success', isNew: true }, expected: true }, // placeholder created → red
      { input: { status: 'pending', isNew: false }, expected: false }, // resolving → amber
      { input: { status: 'pending', isNew: true }, expected: false }, // resolving (placeholder candidate) → amber
      { input: { status: 'error', isNew: false }, expected: false }, // hard error → red-error
      { input: { status: 'error', isNew: true }, expected: false }, // hard error wins over new
    ];
    for (const c of cases) {
      expect(isQueueItemNew(c.input)).toBe(c.expected);
    }
  });
});
