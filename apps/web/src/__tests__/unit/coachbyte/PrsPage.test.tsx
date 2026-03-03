import { describe, it, expect } from 'vitest';
import { epley1RM } from '@/pages/coachbyte/PrsPage';

describe('epley1RM', () => {
  it('returns 0 for 0 reps', () => {
    expect(epley1RM(225, 0)).toBe(0);
  });

  it('returns 0 for 0 load', () => {
    expect(epley1RM(0, 5)).toBe(0);
  });

  it('returns load directly for 1 rep', () => {
    expect(epley1RM(315, 1)).toBe(315);
  });

  it('calculates Epley for 5 reps at 225', () => {
    // 225 × (1 + 5/30) = 225 × 1.1667 ≈ 263
    expect(epley1RM(225, 5)).toBe(263);
  });

  it('calculates Epley for 10 reps at 185', () => {
    // 185 × (1 + 10/30) = 185 × 1.3333 ≈ 247
    expect(epley1RM(185, 10)).toBe(247);
  });

  it('calculates Epley for 3 reps at 315', () => {
    // 315 × (1 + 3/30) = 315 × 1.1 = 347
    expect(epley1RM(315, 3)).toBe(347);
  });
});
