import { describe, it, expect } from 'vitest';
import { calcCaloriesFromMacros } from '@/pages/chefbyte/MacroPage';

describe('calcCaloriesFromMacros', () => {
  /* ---- Basic formula: protein*4 + carbs*4 + fat*9 ---- */

  it('calculates standard macros correctly', () => {
    // 150*4 + 250*4 + 65*9 = 600 + 1000 + 585 = 2185
    expect(calcCaloriesFromMacros(150, 250, 65)).toBe(2185);
  });

  it('weights fat at 9 cal/g vs protein/carbs at 4 cal/g', () => {
    // 10*4 + 10*4 + 10*9 = 40 + 40 + 90 = 170
    expect(calcCaloriesFromMacros(10, 10, 10)).toBe(170);
  });

  /* ---- Single macro inputs ---- */

  it('handles protein only', () => {
    expect(calcCaloriesFromMacros(100, 0, 0)).toBe(400);
  });

  it('handles carbs only', () => {
    expect(calcCaloriesFromMacros(0, 200, 0)).toBe(800);
  });

  it('handles fat only', () => {
    expect(calcCaloriesFromMacros(0, 0, 50)).toBe(450);
  });

  /* ---- Edge cases ---- */

  it('returns 0 when all macros are 0', () => {
    expect(calcCaloriesFromMacros(0, 0, 0)).toBe(0);
  });

  it('handles very large values', () => {
    // 1000*4 + 1000*4 + 1000*9 = 4000 + 4000 + 9000 = 17000
    expect(calcCaloriesFromMacros(1000, 1000, 1000)).toBe(17000);
  });

  it('handles decimal macro values', () => {
    // 10.5*4 + 20.5*4 + 5.5*9 = 42 + 82 + 49.5 = 173.5
    expect(calcCaloriesFromMacros(10.5, 20.5, 5.5)).toBe(173.5);
  });

  it('handles negative values (passes them through formula)', () => {
    // -10*4 + 0*4 + 0*9 = -40
    expect(calcCaloriesFromMacros(-10, 0, 0)).toBe(-40);
  });
});
