/**
 * `mealTypeFromHour` — pre-fill heuristic for the Add Meal modal
 * (FLAG CHEFBYTE_USE).
 */
import { describe, it, expect } from 'vitest';
import { mealTypeFromHour } from '@/shared/mealTypeFromHour';

describe('mealTypeFromHour — meal-type pre-fill (FLAG CHEFBYTE_USE)', () => {
  it('returns "breakfast" for 5–10', () => {
    expect(mealTypeFromHour(5)).toBe('breakfast');
    expect(mealTypeFromHour(7)).toBe('breakfast');
    expect(mealTypeFromHour(10)).toBe('breakfast');
  });

  it('returns "lunch" for 11–14', () => {
    expect(mealTypeFromHour(11)).toBe('lunch');
    expect(mealTypeFromHour(12)).toBe('lunch');
    expect(mealTypeFromHour(14)).toBe('lunch');
  });

  it('returns "dinner" for 17–21', () => {
    expect(mealTypeFromHour(17)).toBe('dinner');
    expect(mealTypeFromHour(19)).toBe('dinner');
    expect(mealTypeFromHour(21)).toBe('dinner');
  });

  it('returns null in the snack/fasting windows (15–16, 22–4)', () => {
    expect(mealTypeFromHour(15)).toBe(null);
    expect(mealTypeFromHour(16)).toBe(null);
    expect(mealTypeFromHour(22)).toBe(null);
    expect(mealTypeFromHour(0)).toBe(null);
    expect(mealTypeFromHour(4)).toBe(null);
  });
});
