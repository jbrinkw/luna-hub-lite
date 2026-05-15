import { describe, it, expect } from 'vitest';
import {
  livetrackTagState,
  livetrackTagVisible,
  LIVETRACK_LAST_UPDATE_SOURCES,
} from '@/pages/chefbyte/livetrackTagState';

describe('livetrackTagState', () => {
  it('returns red when tare_weight_g is null', () => {
    const s = livetrackTagState({ tare_weight_g: null, measured_full_at: null });
    expect(s.color).toBe('red');
    expect(s.tooltip).toMatch(/no tare measured/i);
    expect(s.tooltip).toMatch(/relative weight changes/i);
    expect(s.tooltip).toMatch(/catch-all/i);
  });

  it('returns blue when tare set but measured_full_at is null', () => {
    const s = livetrackTagState({
      tare_weight_g: 25,
      measured_full_at: null,
      net_weight_g: 500,
    });
    expect(s.color).toBe('blue');
    expect(s.tooltip).toMatch(/estimated, not measured/i);
    expect(s.tooltip).toMatch(/confirm and lock the calibration/i);
  });

  it('returns normal when both tare and measured_full_at are set', () => {
    const s = livetrackTagState({
      tare_weight_g: 25,
      measured_full_at: '2026-05-02T18:00:00Z',
    });
    expect(s.color).toBe('normal');
    expect(s.tooltip).toMatch(/fully calibrated/i);
  });

  it('asks user to set net weight when blue and net_weight_g is missing', () => {
    const s = livetrackTagState({
      tare_weight_g: 25,
      measured_full_at: null,
      net_weight_g: null,
    });
    expect(s.color).toBe('blue');
    expect(s.tooltip).toMatch(/set the product's net weight/i);
    expect(s.tooltip).toMatch(/catch-all/i);
  });

  // ------------------------------------------------------------------
  // Tooltip-tweak for uncertified-but-touched products.
  //
  // The red branch already fires when `tare_weight_g` is null. When the
  // caller additionally signals `certified: false`, the wording is tweaked
  // to clarify the calibration state — same colour, more actionable
  // tooltip. This is the partner of the `livetrackTagVisible` widening.
  // ------------------------------------------------------------------
  describe('certified flag tweaks the red tooltip wording', () => {
    it('uses calibration-pending wording when certified=false and tare is null', () => {
      const s = livetrackTagState({
        tare_weight_g: null,
        measured_full_at: null,
        certified: false,
      });
      expect(s.color).toBe('red');
      expect(s.tooltip).toMatch(/not yet calibrated/i);
      expect(s.tooltip).toMatch(/empty container/i);
    });

    it('falls back to the original red wording when certified=true', () => {
      const s = livetrackTagState({
        tare_weight_g: null,
        measured_full_at: null,
        certified: true,
      });
      expect(s.color).toBe('red');
      expect(s.tooltip).toMatch(/no tare measured/i);
      expect(s.tooltip).not.toMatch(/not yet calibrated/i);
    });

    it('omitted certified preserves the original red wording (back-compat)', () => {
      const s = livetrackTagState({
        tare_weight_g: null,
        measured_full_at: null,
      });
      expect(s.color).toBe('red');
      expect(s.tooltip).toMatch(/no tare measured/i);
      expect(s.tooltip).not.toMatch(/not yet calibrated/i);
    });

    it('certified=false does not affect the blue branch tooltip', () => {
      const s = livetrackTagState({
        tare_weight_g: 25,
        measured_full_at: null,
        net_weight_g: 500,
        certified: false,
      });
      // Blue tooltip wording is unchanged — the blue branch presumes tare
      // is set, which only happens after certification on the Pi side.
      expect(s.color).toBe('blue');
      expect(s.tooltip).toMatch(/estimated, not measured/i);
    });

    it('certified=false does not affect the normal branch tooltip', () => {
      const s = livetrackTagState({
        tare_weight_g: 25,
        measured_full_at: '2026-05-02T18:00:00Z',
        certified: false,
      });
      expect(s.color).toBe('normal');
      expect(s.tooltip).toMatch(/fully calibrated/i);
    });
  });
});

// ------------------------------------------------------------------------
// `livetrackTagVisible` — the bug-fix helper. Decides whether the OUTER tag
// element renders at all. `livetrackTagState` then picks the colour. These
// tests pin the "uncertified-but-touched" branch where the red tag now
// surfaces — that's the scenario that was previously unreachable because
// the render gate was `product.certified === true` and the Pi-side
// tare-gated certify guard kept `certified` false while `tare_weight_g`
// was still NULL.
// ------------------------------------------------------------------------
describe('livetrackTagVisible', () => {
  it('certified=true with no lots → visible (regression — certified products always show)', () => {
    expect(livetrackTagVisible({ certified: true, lotLastUpdateSources: [] })).toBe(true);
  });

  it('certified=false with no lots → hidden', () => {
    expect(livetrackTagVisible({ certified: false, lotLastUpdateSources: [] })).toBe(false);
  });

  it("certified=false with a 'catch_all' lot → visible (the bug fix)", () => {
    // The exact scenario from the bug report: a near-full Rice Krispies
    // box placed on the catch-all. AI classifier flips `last_update_source`
    // to 'catch_all'; `tare_weight_g` stays NULL because the empty-bottle
    // heuristic (<30% of net_weight_g) doesn't fire; the Pi-side
    // tare-gated certify guard keeps `certified` false. The user should
    // STILL see the red "delta-only" tag — that's exactly what the tag
    // was designed for.
    expect(livetrackTagVisible({ certified: false, lotLastUpdateSources: ['catch_all'] })).toBe(true);
  });

  it("certified=false with a 'live_shelf' lot → visible", () => {
    expect(livetrackTagVisible({ certified: false, lotLastUpdateSources: ['live_shelf'] })).toBe(true);
  });

  it("certified=false with a 'live_scale' lot → visible", () => {
    expect(livetrackTagVisible({ certified: false, lotLastUpdateSources: ['live_scale'] })).toBe(true);
  });

  it("certified=false with only a 'manual' lot → hidden (non-LiveTrack source)", () => {
    expect(livetrackTagVisible({ certified: false, lotLastUpdateSources: ['manual'] })).toBe(false);
  });

  it('certified=false with mixed sources → visible if any match', () => {
    expect(livetrackTagVisible({ certified: false, lotLastUpdateSources: ['manual', 'catch_all'] })).toBe(true);
  });

  it("certified=null with a 'catch_all' lot → visible (null treated like false but lot match fires)", () => {
    // `certified` may be null on rows imported before the column was
    // backfilled. We want the same behaviour as `false`: lot-source match
    // is the load-bearing signal.
    expect(livetrackTagVisible({ certified: null, lotLastUpdateSources: ['catch_all'] })).toBe(true);
  });

  it('certified=false with [null, undefined] lots → hidden (no real sources)', () => {
    expect(livetrackTagVisible({ certified: false, lotLastUpdateSources: [null, undefined] })).toBe(false);
  });

  it('certified=undefined with no lots → hidden', () => {
    expect(livetrackTagVisible({ certified: undefined, lotLastUpdateSources: [] })).toBe(false);
  });

  it('ignores unknown source values defensively', () => {
    // Future-proof: if the server adds a new `last_update_source` value
    // that isn't in the LiveTrack set, we should NOT flip visibility on.
    expect(livetrackTagVisible({ certified: false, lotLastUpdateSources: ['something_new' as any] })).toBe(false);
  });

  it('exports the LiveTrack source set with the expected members', () => {
    // Tripwire: if a maintainer drops or adds a value here, this test
    // forces a deliberate update. The set is duplicated server-side at
    // `chefbyte.stock_lots.last_update_source` — keep both in lockstep.
    expect([...LIVETRACK_LAST_UPDATE_SOURCES].sort()).toEqual(['catch_all', 'live_scale', 'live_shelf']);
  });
});
