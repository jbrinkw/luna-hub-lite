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
 * The 2026-05-15 catch-all rule adds a symmetric per-lot gate on
 * `in_flight_kind` + `in_flight_since`: a `catch_all` row only surfaces
 * when the SAME lot is currently in flight on the catch-all.
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
 *   4. For ANY mix of lots where NO lot is currently in flight on the
 *      catch-all (i.e. in_flight_kind != 'catch_all' OR in_flight_since
 *      IS NULL on every catch_all row), the chosen source is never
 *      `catch_all`. The 2026-05-15 historical-suppression invariant.
 *
 * Mutation hardening: dropping the `liveScalePaired && source ===
 * 'live_scale'` guard makes property #1 fail; flipping the manual gate
 * to include manual rows makes property #2 fail; dropping the
 * `in_flight_kind === 'catch_all' && in_flight_since != null` guard
 * makes property #4 fail.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { pickLatestAutomatedSource } from '@/pages/chefbyte/InventoryPage';

type Source = 'manual' | 'live_shelf' | 'live_scale' | 'catch_all' | null;
type InFlightKind = 'live_shelf' | 'live_scale' | 'catch_all' | null;

const sourceArb = fc.constantFrom<Source>('manual', 'live_shelf', 'live_scale', 'catch_all', null);
const inFlightKindArb = fc.constantFrom<InFlightKind>('live_shelf', 'live_scale', 'catch_all', null);

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

/**
 * Arb for lots that carry per-lot in_flight context. Used by property #4
 * — the catch-all historical-suppression invariant — where we need to
 * generate ANY mix of in_flight_kind/in_flight_since pairs and assert
 * the gate strips catch_all rows that aren't currently on the catch-all.
 *
 * The `notCurrentlyOnCatchAll` flavor below post-filters to enforce the
 * invariant precondition (NO lot is currently in flight on the catch-all).
 */
const lotWithFlightArb = fc.record({
  last_update_source: sourceArb,
  last_update_ts: tsArb,
  in_flight_kind: inFlightKindArb,
  in_flight_since: tsArb,
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
          // When the comparator row is catch_all, stamp it as currently
          // in-flight on the catch-all so the new (2026-05-15) gate
          // doesn't strip it before the ts comparison runs — the
          // property under test is the TS comparator, not the catch_all
          // gate.
          const lots =
            oldSource === 'catch_all'
              ? [
                  {
                    last_update_source: 'catch_all' as const,
                    last_update_ts: oldTs,
                    in_flight_kind: 'catch_all' as const,
                    in_flight_since: oldTs,
                  },
                  { last_update_source: 'live_scale' as const, last_update_ts: newTs },
                ]
              : [
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

  it('never selects catch_all when NO lot is currently in flight on the catch-all', () => {
    // The 2026-05-15 historical-suppression invariant. We post-filter the
    // generated lot collection so the precondition holds: every catch_all
    // row is either NOT in_flight, or in_flight on a different kind, or
    // missing in_flight_since. Under that precondition the chosen source
    // must never be `catch_all` — historical `last_update_source` alone
    // cannot light up the pill.
    fc.assert(
      fc.property(fc.array(lotWithFlightArb, { minLength: 0, maxLength: 8 }), (rawLots) => {
        const lots = rawLots.map((l) => {
          // Force every catch_all row to be NOT currently on the catch-all
          // (either wrong kind or null since). Other source rows pass through
          // unchanged.
          if (l.last_update_source === 'catch_all') {
            return { ...l, in_flight_kind: null as InFlightKind, in_flight_since: null as string | null };
          }
          return l;
        });
        const { latestSource } = pickLatestAutomatedSource(lots, 'product-X', new Set(['product-X']));
        expect(latestSource).not.toBe('catch_all');
      }),
      { numRuns: 200 },
    );
  });
});
