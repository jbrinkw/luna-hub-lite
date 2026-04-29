/**
 * Property tests for `pickLatestAutomatedSource`
 * (apps/web/src/pages/chefbyte/InventoryPage.tsx).
 *
 * Background: this is the inventory-pill source-selection algorithm.
 * The chicken stale-tag bug (2026-04-28) was a `live_scale` lot
 * surfacing the live-scale pill long after the pairing was torn down,
 * because the predicate didn't gate on the current paired-product set.
 * The fix added the `liveScalePairedProductIds` guard.
 *
 * Properties:
 *
 *   1. For ANY mix of (last_update_source, ts) pairs where the product
 *      is NOT in the paired set, the chosen source is never `live_scale`.
 *      This is the load-bearing chicken-bug invariant.
 *   2. Manual rows are never chosen — the pill is reserved for
 *      automated sources only (algorithm contract).
 *   3. When the product IS in the paired set, a single `live_scale` row
 *      with a defined ts beats every older non-live_scale row by ts.
 *
 * Mutation hardening: dropping the `liveScalePaired && source ===
 * 'live_scale'` guard makes property #1 fail; flipping the manual gate
 * to include manual rows makes property #2 fail.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { pickLatestAutomatedSource } from '@/pages/chefbyte/InventoryPage';

type Source = 'manual' | 'live_shelf' | 'live_scale' | 'catch_all' | null;

const sourceArb = fc.constantFrom<Source>('manual', 'live_shelf', 'live_scale', 'catch_all', null);

const tsArb = fc.oneof(
  fc.constant<string | null>(null),
  fc
    .date({ noInvalidDate: true, min: new Date('2020-01-01'), max: new Date('2030-01-01') })
    .map((d) => d.toISOString()),
);

const lotArb = fc.record({
  last_update_source: sourceArb,
  last_update_ts: tsArb,
});

describe('pickLatestAutomatedSource — properties', () => {
  it('never selects live_scale when the product is NOT in the live-scale paired set', () => {
    fc.assert(
      fc.property(fc.array(lotArb, { minLength: 0, maxLength: 8 }), (lots) => {
        const { latestSource } = pickLatestAutomatedSource(
          lots,
          'product-X',
          new Set(), // product-X NOT in paired set
        );
        expect(latestSource).not.toBe('live_scale');
      }),
      { numRuns: 200 },
    );
  });

  it("never selects 'manual' as the surfaced source", () => {
    fc.assert(
      fc.property(fc.array(lotArb, { minLength: 0, maxLength: 8 }), fc.boolean(), (lots, paired) => {
        const pairedSet = paired ? new Set(['product-X']) : new Set<string>();
        const { latestSource } = pickLatestAutomatedSource(lots, 'product-X', pairedSet);
        // Algorithm contract: manual rows are excluded from selection.
        // The return type forbids 'manual' too — this asserts both.
        expect(latestSource === null || latestSource !== ('manual' as unknown)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('when paired, a fresh live_scale row beats older non-live_scale automated rows', () => {
    fc.assert(
      fc.property(
        fc
          .date({ noInvalidDate: true, min: new Date('2020-01-01'), max: new Date('2025-01-01') })
          .map((d) => d.toISOString()),
        fc
          .date({ noInvalidDate: true, min: new Date('2025-06-01'), max: new Date('2030-01-01') })
          .map((d) => d.toISOString()),
        fc.constantFrom<Source>('live_shelf', 'catch_all'),
        (oldTs, newTs, oldSource) => {
          // oldTs strictly < newTs (separate ranges chosen above).
          const lots = [
            { last_update_source: oldSource, last_update_ts: oldTs },
            { last_update_source: 'live_scale' as const, last_update_ts: newTs },
          ];
          const { latestSource } = pickLatestAutomatedSource(lots, 'product-X', new Set(['product-X']));
          expect(latestSource).toBe('live_scale');
        },
      ),
      { numRuns: 50 },
    );
  });
});
