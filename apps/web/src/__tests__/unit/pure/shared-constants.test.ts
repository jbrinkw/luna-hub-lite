import { describe, it, expect } from 'vitest';
import { DEFAULT_MACRO_GOALS, NOT_ON_WALMART, WEIGHT_UNIT, MIN_PASSWORD_LENGTH } from '@/shared/constants';

describe('DEFAULT_MACRO_GOALS', () => {
  it('has all four macro keys', () => {
    expect(DEFAULT_MACRO_GOALS).toHaveProperty('calories');
    expect(DEFAULT_MACRO_GOALS).toHaveProperty('protein');
    expect(DEFAULT_MACRO_GOALS).toHaveProperty('carbs');
    expect(DEFAULT_MACRO_GOALS).toHaveProperty('fat');
  });

  it('has reasonable default values', () => {
    expect(DEFAULT_MACRO_GOALS.calories).toBe(2000);
    expect(DEFAULT_MACRO_GOALS.protein).toBe(150);
    expect(DEFAULT_MACRO_GOALS.carbs).toBe(250);
    expect(DEFAULT_MACRO_GOALS.fat).toBe(65);
  });

  it('calories ≈ 4-4-9 macro sum (within 10%)', () => {
    const computed = DEFAULT_MACRO_GOALS.protein * 4 + DEFAULT_MACRO_GOALS.carbs * 4 + DEFAULT_MACRO_GOALS.fat * 9;
    const ratio = DEFAULT_MACRO_GOALS.calories / computed;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });

  it('all macro values are positive integers', () => {
    for (const val of Object.values(DEFAULT_MACRO_GOALS)) {
      expect(val).toBeGreaterThan(0);
      expect(Number.isInteger(val)).toBe(true);
    }
  });
});

describe('NOT_ON_WALMART', () => {
  it('is the sentinel string "NOT_ON_WALMART"', () => {
    expect(NOT_ON_WALMART).toBe('NOT_ON_WALMART');
  });
});

describe('WEIGHT_UNIT', () => {
  it('is "lb"', () => {
    expect(WEIGHT_UNIT).toBe('lb');
  });
});

describe('MIN_PASSWORD_LENGTH', () => {
  it('is 8', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
  });
});
