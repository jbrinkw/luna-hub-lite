/**
 * `macroDelta` — 4-4-9 calorie consistency check (FLAG CHEFBYTE_USE).
 *
 * Returns null when calories agree with 4·protein + 4·carbs + 9·fat
 * within 25%. Returns `{ expected, delta, pctOff }` otherwise so the
 * UI can render a soft warning chip.
 */
import { describe, it, expect } from 'vitest';
import { macroDelta } from '@/shared/macroValidation';

describe('macroDelta — 4-4-9 calorie validation', () => {
  it('returns null on a perfectly-consistent log (200 cal, 25P 20C 5F → 4·25+4·20+9·5 = 225 cal, 11% off → null)', () => {
    expect(macroDelta(200, 25, 20, 5)).toBe(null);
  });

  it('returns null on an exact-match log', () => {
    // 4·20 + 4·30 + 9·10 = 80 + 120 + 90 = 290
    expect(macroDelta(290, 20, 30, 10)).toBe(null);
  });

  it('flags a calories-overstated row (logged 500, expected 200, +150% off)', () => {
    // 4·10 + 4·20 + 9·10 = 40 + 80 + 90 = 210
    const d = macroDelta(500, 10, 20, 10);
    expect(d).not.toBeNull();
    expect(d!.expected).toBe(210);
    expect(d!.delta).toBeGreaterThan(0);
    expect(d!.pctOff).toBeGreaterThan(0.5);
  });

  it('flags a calories-understated row (logged 50 with 30P 30C 10F → expected 330, -85%)', () => {
    const d = macroDelta(50, 30, 30, 10);
    expect(d).not.toBeNull();
    expect(d!.delta).toBeLessThan(0);
  });

  it('returns null on zero-calorie rows (e.g. flavor-only entries)', () => {
    expect(macroDelta(0, 0, 0, 0)).toBe(null);
    expect(macroDelta(5, 0, 0, 0)).toBe(null);
  });

  it('returns null on tiny-cal entries even if macros disagree', () => {
    // calories=3 → skipped (the 5-cal threshold), no warning
    expect(macroDelta(3, 5, 5, 5)).toBe(null);
  });

  it('skips rows with zero macros even at higher calories (LLM extraction failure case)', () => {
    // 100 cal but 0/0/0 macros — would always be 100% off, but no
    // 4-4-9 baseline to compare against. Skip rather than warn-spam.
    expect(macroDelta(100, 0, 0, 0)).toBe(null);
  });

  it('does NOT flag avocado-like high-fat foods within tolerance (240 cal, 3P 12C 22F → expected 258, 7% off)', () => {
    expect(macroDelta(240, 3, 12, 22)).toBe(null);
  });
});
