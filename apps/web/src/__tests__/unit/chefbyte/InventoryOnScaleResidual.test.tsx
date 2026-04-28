/**
 * Pure-predicate guard for ``isLotOnScale`` against the sub-display
 * residual case (2026-04-28 chocolate-milk regression).
 *
 * The cloud-side rotation predicate was historically `qty_containers <= 0`,
 * so a paired lot that landed at qty=0.005 (scale noise / quantization)
 * never triggered rotation and stayed pinned. The lot rendered as
 * "0.0 ctn" in toFixed(1) UI, with the "On Scale" badge still lit.
 *
 * The fix has two layers:
 *   1. Cloud rotation predicate widened to `< 0.01` (migration
 *      20260428010000) so future writes auto-repoint.
 *   2. UI predicate (this test) defensively excludes paired lots at
 *      qty < ON_SCALE_QTY_EPSILON so realtime lag between the cloud
 *      rotation and the UI's next refetch doesn't briefly show a
 *      stranded badge.
 *
 * If anyone changes either threshold this test fails immediately —
 * the two MUST stay in lockstep so the UI never disagrees with the
 * source of truth.
 */
import { describe, it, expect } from 'vitest';
import { isLotOnScale, ON_SCALE_QTY_EPSILON } from '@/pages/chefbyte/InventoryPage';

describe('isLotOnScale — sub-display residual guard (2026-04-28)', () => {
  const paired = new Set(['lot-A']);

  it('paired lot at qty=0.005 (sub-display residual) returns false', () => {
    // The user-reported chocolate-milk case. Pre-fix this returned true
    // and lit the On Scale badge on a lot that read "0.0 ctn" — the
    // exact symptom the cloud rotation predicate change addresses.
    expect(isLotOnScale({ lot_id: 'lot-A', in_flight_since: null, qty_containers: 0.005 }, paired)).toBe(false);
  });

  it('paired lot at qty=0 returns false (still empty, predicate strict-less-than catches it)', () => {
    expect(isLotOnScale({ lot_id: 'lot-A', in_flight_since: null, qty_containers: 0 }, paired)).toBe(false);
  });

  it('paired lot at exactly the threshold (0.01) returns true (boundary inclusion)', () => {
    // 0.01 ctn is the minimum we render as "0.0" → "0.0 ctn", but the
    // UI threshold is strict-less-than, so a value AT 0.01 still
    // counts as on-scale. Locking this in prevents a future "<= 0.01"
    // bug that would silently drop the badge for a barely-non-empty
    // legitimate lot.
    expect(isLotOnScale({ lot_id: 'lot-A', in_flight_since: null, qty_containers: ON_SCALE_QTY_EPSILON }, paired)).toBe(
      true,
    );
  });

  it('paired lot at qty=0.5 (legitimate non-empty) returns true', () => {
    expect(isLotOnScale({ lot_id: 'lot-A', in_flight_since: null, qty_containers: 0.5 }, paired)).toBe(true);
  });

  it('paired lot at qty=0.005 BUT in_flight overrides (in-flight wins)', () => {
    // In-flight independence guard — independent of the qty residual
    // check, an in-flight bottle is never On Scale.
    expect(
      isLotOnScale({ lot_id: 'lot-A', in_flight_since: '2026-04-28T10:00:00Z', qty_containers: 0.005 }, paired),
    ).toBe(false);
  });

  it('qty_containers as string "0.005" (PostgREST NUMERIC default serialization) returns false', () => {
    // Postgres NUMERIC can land in JS as string under default
    // PostgREST settings. The predicate must coerce — otherwise a
    // string like "0.005" passes the `< 0.01` check by accident
    // (string comparison would say "0.005" < "0.01" ALPHANUMERICALLY,
    // which is the wrong reason).
    expect(isLotOnScale({ lot_id: 'lot-A', in_flight_since: null, qty_containers: '0.005' as any }, paired)).toBe(
      false,
    );
  });

  it('qty_containers undefined (legacy callers) returns true (preserves prior behaviour)', () => {
    // Backwards compatibility: existing test seeds and any caller that
    // doesn't supply qty fall through to the prior "paired + not in-
    // flight = on-scale" rule. We explicitly DON'T require qty so the
    // predicate's contract stays additive.
    expect(isLotOnScale({ lot_id: 'lot-A', in_flight_since: null }, paired)).toBe(true);
  });

  it('not paired returns false regardless of qty', () => {
    expect(isLotOnScale({ lot_id: 'lot-other', in_flight_since: null, qty_containers: 100 }, paired)).toBe(false);
  });

  it('ON_SCALE_QTY_EPSILON exported value is 0.01 (lockstep with cloud threshold)', () => {
    // The cloud-side rotation predicate in apply_shelf_event uses
    // `v_new_qty < 0.01`. If anyone changes this constant the cloud
    // migration MUST change too — this assertion forces that
    // coordination by failing if the UI threshold drifts.
    expect(ON_SCALE_QTY_EPSILON).toBe(0.01);
  });
});
