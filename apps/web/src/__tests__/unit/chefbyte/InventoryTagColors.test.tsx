import { describe, it, expect } from 'vitest';
import { livetrackTagState } from '@/pages/chefbyte/livetrackTagState';

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
});
