import { describe, it, expect } from 'vitest';
import { epley1RM } from '@/pages/coachbyte/PrsPage';

describe('epley1RM', () => {
  /* ---- Standard calculations: weight * (1 + reps/30) ---- */

  it('calculates Epley for 5 reps at 225', () => {
    // 225 * (1 + 5/30) = 225 * 1.1667 = 262.5 -> 263
    expect(epley1RM(225, 5)).toBe(263);
  });

  it('calculates Epley for 10 reps at 185', () => {
    // 185 * (1 + 10/30) = 185 * 1.3333 = 246.67 -> 247
    expect(epley1RM(185, 10)).toBe(247);
  });

  it('calculates Epley for 3 reps at 315', () => {
    // 315 * (1 + 3/30) = 315 * 1.1 = 346.5 -> 347
    expect(epley1RM(315, 3)).toBe(347);
  });

  it('calculates Epley for 8 reps at 185', () => {
    // 185 * (1 + 8/30) = 185 * 1.2667 = 234.33 -> 234
    expect(epley1RM(185, 8)).toBe(234);
  });

  it('calculates Epley for 20 reps at 135', () => {
    // 135 * (1 + 20/30) = 135 * 1.6667 = 225
    expect(epley1RM(135, 20)).toBe(225);
  });

  /* ---- Special cases ---- */

  it('returns load directly for 1 rep (actual max)', () => {
    expect(epley1RM(315, 1)).toBe(315);
  });

  it('returns 0 for 0 reps', () => {
    expect(epley1RM(225, 0)).toBe(0);
  });

  it('returns 0 for 0 load', () => {
    expect(epley1RM(0, 5)).toBe(0);
  });

  it('returns 0 for negative reps', () => {
    expect(epley1RM(225, -3)).toBe(0);
  });

  it('returns 0 for negative load', () => {
    expect(epley1RM(-100, 5)).toBe(0);
  });

  it('returns 0 when both load and reps are 0', () => {
    expect(epley1RM(0, 0)).toBe(0);
  });

  /* ---- Decimal loads ---- */

  it('handles decimal load values', () => {
    // 100.5 * (1 + 5/30) = 100.5 * 1.1667 = 117.25 -> 117
    expect(epley1RM(100.5, 5)).toBe(117);
  });

  /* ---- High rep ranges ---- */

  it('handles 30 reps (doubles the load)', () => {
    // 100 * (1 + 30/30) = 100 * 2 = 200
    expect(epley1RM(100, 30)).toBe(200);
  });
});
