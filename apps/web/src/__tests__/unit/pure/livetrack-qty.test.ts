/**
 * LiveTrack Import — qty_containers derivation (item #30, commit 91550dd).
 *
 * Task 2 of the 2026-04-21 e2e audit recommends a pgTAP test for this
 * arithmetic, but the derivation is purely client-side (runs in the
 * browser's save handler in ``LiveTrackImportPage.doSave`` before the
 * ``stock_lots`` INSERT). There is no SQL function to target — the DB
 * just stores whatever the client computes. So this test lives at the
 * pure-unit layer instead; the regression is structurally impossible
 * to reintroduce at the SQL layer.
 *
 * Pre-fix bug (91550dd):
 *   Wizard save path hardcoded ``qty_containers: 1`` regardless of tare
 *   path. Selecting "not full" on a half-used jar imported it as a full
 *   container instead of the measured fraction (owner reported on
 *   "Dry Roasted Salted Peanuts": picked "not full", landed as 1 ctn).
 *
 * The fix carries ``scaleG`` through the review state and computes at
 * save time::
 *
 *     net_product_g  = max(0, scaleG − tareG)
 *     qty_containers = max(0, net_product_g / net_weight_g)
 *
 * Rounded to 3 decimals to match the NUMERIC(10,3) column.
 *
 * Fallback: qty = 1 when scaleG is missing (manual tare w/o Pi reading),
 * net_weight_g is missing/0, or either input is non-finite. This makes
 * the lot still land — indistinguishable from the pre-fix legacy path
 * for the manual-w/o-scale case, which is correct behavior (we don't
 * know the true fraction so assume full).
 */

import { describe, it, expect } from 'vitest';
import { computeQtyContainersFromScale } from '@/pages/chefbyte/livetrackSession';

describe('computeQtyContainersFromScale (item #30 / 91550dd)', () => {
  /* ------------------------------------------------------------------ */
  /*  Happy path: scaleG, tareG, netWeightG all present + finite         */
  /* ------------------------------------------------------------------ */

  it('full + sealed (scaleG − tareG === net_weight_g) → qty ≈ 1.0', () => {
    // Peanut jar: 500g declared net weight. Scale reads 580g, tare 80g.
    //   netProductG = 580 − 80 = 500
    //   qty         = 500 / 500 = 1.0
    expect(
      computeQtyContainersFromScale({
        scaleG: 580,
        tareG: 80,
        netWeightG: 500,
      }),
    ).toBe(1);
  });

  it('half-full jar → fractional qty (the 91550dd owner-reported case)', () => {
    // Same peanut jar, half consumed. Scale reads 330g, tare 80g.
    //   netProductG = 330 − 80 = 250
    //   qty         = 250 / 500 = 0.500
    // Pre-fix: would have been 1.000 (the bug).
    expect(
      computeQtyContainersFromScale({
        scaleG: 330,
        tareG: 80,
        netWeightG: 500,
      }),
    ).toBe(0.5);
  });

  it('quarter-full jar → 0.25 exactly', () => {
    // 205 − 80 = 125; 125 / 500 = 0.250
    expect(
      computeQtyContainersFromScale({
        scaleG: 205,
        tareG: 80,
        netWeightG: 500,
      }),
    ).toBe(0.25);
  });

  it('empty jar (scaleG === tareG) → qty = 0 (floors at 0, never negative)', () => {
    // 80 − 80 = 0; 0 / 500 = 0.
    expect(
      computeQtyContainersFromScale({
        scaleG: 80,
        tareG: 80,
        netWeightG: 500,
      }),
    ).toBe(0);
  });

  it('below-tare reading (scaleG < tareG) → clamped to 0, never negative', () => {
    // Defensive: if the scale reads below the tare (jiggle, zero drift,
    // whatever), we MUST NOT emit a negative qty into NUMERIC.
    //   max(0, 50 − 80) = 0
    //   0 / 500 = 0
    expect(
      computeQtyContainersFromScale({
        scaleG: 50,
        tareG: 80,
        netWeightG: 500,
      }),
    ).toBe(0);
  });

  it('overfilled (scaleG − tareG > net_weight_g) → qty > 1 (no cap)', () => {
    // 1200 − 200 = 1000; 1000 / 500 = 2.0. We don't cap at 1.0 because
    // a physical overfill (e.g. user piled extra into the jar) is real
    // stock and must be tracked.
    expect(
      computeQtyContainersFromScale({
        scaleG: 1200,
        tareG: 200,
        netWeightG: 500,
      }),
    ).toBe(2);
  });

  it('rounds to 3 decimals (NUMERIC(10,3) column)', () => {
    // 1/3 of a 500g jar: netProductG = 166.666...g, qty = 0.33333...
    // Column stores 3 decimals → expect 0.333 exactly.
    const qty = computeQtyContainersFromScale({
      scaleG: 80 + 500 / 3,
      tareG: 80,
      netWeightG: 500,
    });
    expect(qty).toBe(0.333);
  });

  it('rounds to 3 decimals — half-round-up case', () => {
    // Contrived to force the rounding boundary: want qty = 0.1235
    // (post-rounding: 0.124 via Math.round of 0.1235 * 1000 = 123.5).
    //   netProductG / netWeightG === 0.1235
    //   Use netWeightG = 10_000, netProductG = 1235.
    //   scaleG = 1235 + tareG = 1235 + 0 = 1235.
    const qty = computeQtyContainersFromScale({
      scaleG: 1235,
      tareG: 0,
      netWeightG: 10_000,
    });
    // JS Math.round is banker's-style for halves → Math.round(123.5) = 124.
    expect(qty).toBe(0.124);
  });

  /* ------------------------------------------------------------------ */
  /*  Fallback: qty = 1 when any input is absent / non-finite / zero     */
  /* ------------------------------------------------------------------ */

  it('null scaleG (manual tare, no Pi reading) → qty = 1 (fallback)', () => {
    expect(
      computeQtyContainersFromScale({
        scaleG: null,
        tareG: 80,
        netWeightG: 500,
      }),
    ).toBe(1);
  });

  it('undefined scaleG → qty = 1 (fallback)', () => {
    expect(
      computeQtyContainersFromScale({
        scaleG: undefined,
        tareG: 80,
        netWeightG: 500,
      }),
    ).toBe(1);
  });

  it('null tareG → qty = 1 (fallback)', () => {
    expect(
      computeQtyContainersFromScale({
        scaleG: 580,
        tareG: null,
        netWeightG: 500,
      }),
    ).toBe(1);
  });

  it('null netWeightG → qty = 1 (fallback, can\'t normalize)', () => {
    // Without a declared net_weight_g, we can't express the reading as
    // a fraction of containers — fall back to 1 so the lot at least lands.
    expect(
      computeQtyContainersFromScale({
        scaleG: 580,
        tareG: 80,
        netWeightG: null,
      }),
    ).toBe(1);
  });

  it('zero netWeightG → qty = 1 (fallback, divide-by-zero guard)', () => {
    // Never divide by zero, even if a corrupt product row slipped through
    // with net_weight_g = 0.
    expect(
      computeQtyContainersFromScale({
        scaleG: 580,
        tareG: 80,
        netWeightG: 0,
      }),
    ).toBe(1);
  });

  it('negative netWeightG → qty = 1 (fallback, not > 0 guard)', () => {
    // Corrupt row defence: a negative net_weight_g would yield a negative
    // qty otherwise.
    expect(
      computeQtyContainersFromScale({
        scaleG: 580,
        tareG: 80,
        netWeightG: -100,
      }),
    ).toBe(1);
  });

  it('NaN scaleG → qty = 1 (fallback)', () => {
    expect(
      computeQtyContainersFromScale({
        scaleG: Number.NaN,
        tareG: 80,
        netWeightG: 500,
      }),
    ).toBe(1);
  });

  it('Infinity tareG → qty = 1 (fallback)', () => {
    expect(
      computeQtyContainersFromScale({
        scaleG: 580,
        tareG: Number.POSITIVE_INFINITY,
        netWeightG: 500,
      }),
    ).toBe(1);
  });

  /* ------------------------------------------------------------------ */
  /*  Regression pins: the explicit 91550dd counterexamples              */
  /* ------------------------------------------------------------------ */

  it('regression: pre-91550dd bug would have returned 1 for the half-jar case', () => {
    // Sanity: the NEW function must return a non-1 value for the bug
    // input, otherwise 91550dd wasn't actually fixed.
    const qty = computeQtyContainersFromScale({
      scaleG: 330,
      tareG: 80,
      netWeightG: 500,
    });
    expect(qty).not.toBe(1);
    expect(qty).toBeLessThan(1);
    expect(qty).toBeGreaterThan(0);
  });

  it('regression: manual tare without scaleG must still hit the qty=1 fallback', () => {
    // Pre-91550dd hardcoded qty=1 for EVERY path — the fix specifically
    // kept this path at 1 (no measurement → assume full). Assert the
    // branch is preserved.
    const qty = computeQtyContainersFromScale({
      scaleG: null,
      tareG: 80,
      netWeightG: 500,
    });
    expect(qty).toBe(1);
  });
});
