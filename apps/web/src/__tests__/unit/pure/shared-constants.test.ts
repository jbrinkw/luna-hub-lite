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

  it('uses "fat" not "fats"', () => {
    expect(DEFAULT_MACRO_GOALS).not.toHaveProperty('fats');
    expect(DEFAULT_MACRO_GOALS).toHaveProperty('fat');
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
