import { describe, it, expect } from 'vitest';
import { livetrackTagState } from '@/pages/chefbyte/livetrackTagState';

describe('livetrackTagState', () => {
  it('returns red when tare_weight_g is null', () => {
    const s = livetrackTagState({ tare_weight_g: null, measured_full_at: null });
    expect(s.color).toBe('red');
    expect(s.tooltip).toMatch(/no tare/i);
    expect(s.tooltip).toMatch(/relative changes only/i);
  });

  it('returns blue when tare set but measured_full_at is null', () => {
    const s = livetrackTagState({
      tare_weight_g: 25,
      measured_full_at: null,
    });
    expect(s.color).toBe('blue');
    expect(s.tooltip).toMatch(/AI estimate/i);
    expect(s.tooltip).toMatch(/confirm a full placement/i);
  });

  it('returns normal when both tare and measured_full_at are set', () => {
    const s = livetrackTagState({
      tare_weight_g: 25,
      measured_full_at: '2026-05-02T18:00:00Z',
    });
    expect(s.color).toBe('normal');
    expect(s.tooltip).toMatch(/calibrated/i);
  });

  it('lists net_weight_g missing as a separate tooltip cause when measured-full unreachable', () => {
    const s = livetrackTagState({
      tare_weight_g: 25,
      measured_full_at: null,
      net_weight_g: null,
    });
    expect(s.color).toBe('blue');
    expect(s.tooltip).toMatch(/net weight not set/i);
  });
});
