import { describe, it, expect } from 'vitest';
import { vsGoalDelta, vsGoalDeltaParts, reduceDayTotalsExcludingPrep } from '@/pages/chefbyte/MealPlanPage';

/**
 * UX_AUDIT_CHEFBYTE_USE_R2 #1 — vs-goal sign convention.
 *
 *   - delta = consumed - goal (mainstream-fitness-app idiom).
 *   - delta < 0 → under goal (sign '-').
 *   - delta > 0 → over goal (sign '+').
 *   - delta === 0 → on goal (no sign).
 *
 * Pre-fix: the page computed `goal - consumed`, so a day at 1600/2000
 * would show `+400 cal` (sign-flipped). This test pins the corrected
 * convention so a regression that swaps the operands fails loudly.
 *
 * UX_AUDIT_CHEFBYTE_USE_R2 #2 — meal_prep exclusion from day totals.
 *
 *   `reduceDayTotalsExcludingPrep` skips entries with `meal_prep: true`
 *   so a Sunday with a 14-serving prep doesn't generate a fake
 *   "+2400 cal over goal" alarm.
 */

describe('vsGoalDelta — R2 audit #1 sign convention', () => {
  it('returns negative when consumed is under the goal', () => {
    expect(vsGoalDelta(1500, 2000)).toBe(-500);
    expect(vsGoalDelta(0, 100)).toBe(-100);
  });

  it('returns positive when consumed is over the goal', () => {
    expect(vsGoalDelta(2400, 2000)).toBe(400);
    expect(vsGoalDelta(150, 100)).toBe(50);
  });

  it('returns 0 when on goal', () => {
    expect(vsGoalDelta(100, 100)).toBe(0);
  });

  // Mutation probe: catches the pre-fix bug where the page computed
  // `goal - consumed`. If a future edit re-introduces the swap, the
  // sign on this assertion flips and the test fails.
  it('rejects the swapped (goal - consumed) form', () => {
    expect(vsGoalDelta(1500, 2000)).not.toBe(500);
    expect(vsGoalDelta(2400, 2000)).not.toBe(-400);
  });
});

describe('vsGoalDeltaParts', () => {
  it('classifies under/over/on with the right sign character', () => {
    expect(vsGoalDeltaParts(1500, 2000)).toEqual({ sign: '-', abs: 500, kind: 'under' });
    expect(vsGoalDeltaParts(2400, 2000)).toEqual({ sign: '+', abs: 400, kind: 'over' });
    expect(vsGoalDeltaParts(2000, 2000)).toEqual({ sign: '', abs: 0, kind: 'on' });
  });

  it('rounds the absolute value (no fractional cal output)', () => {
    expect(vsGoalDeltaParts(1500.7, 2000).abs).toBe(499);
    expect(vsGoalDeltaParts(2000.6, 2000).kind).toBe('over');
    expect(vsGoalDeltaParts(2000.6, 2000).abs).toBe(1);
  });
});

describe('reduceDayTotalsExcludingPrep — R2 audit #2', () => {
  type Meal = { meal_prep: boolean; calories: number; protein: number; carbs: number; fat: number };
  const macrosFor = (m: Meal) => ({
    calories: m.calories,
    protein: m.protein,
    carbs: m.carbs,
    fat: m.fat,
  });

  it('sums non-meal_prep entries normally', () => {
    const meals: Meal[] = [
      { meal_prep: false, calories: 500, protein: 30, carbs: 40, fat: 15 },
      { meal_prep: false, calories: 700, protein: 40, carbs: 50, fat: 20 },
    ];
    expect(reduceDayTotalsExcludingPrep(meals, macrosFor)).toEqual({
      calories: 1200,
      protein: 70,
      carbs: 90,
      fat: 35,
    });
  });

  it('excludes meal_prep entries from the totals', () => {
    const meals: Meal[] = [
      // Regular Monday lunch (counts):
      { meal_prep: false, calories: 600, protein: 40, carbs: 50, fat: 20 },
      // Sunday meal-prep batch — 14 servings of chicken intended to feed
      // Mon-Fri lunches. Pre-fix totals would lump these in and show
      // +2400 cal over goal on Sunday. Post-fix: ignored.
      { meal_prep: true, calories: 2400, protein: 240, carbs: 0, fat: 80 },
      // Sunday dinner (counts):
      { meal_prep: false, calories: 800, protein: 50, carbs: 70, fat: 30 },
    ];
    expect(reduceDayTotalsExcludingPrep(meals, macrosFor)).toEqual({
      calories: 1400,
      protein: 90,
      carbs: 120,
      fat: 50,
    });
  });

  it('returns zeros when all meals are prep entries', () => {
    const meals: Meal[] = [
      { meal_prep: true, calories: 1000, protein: 100, carbs: 0, fat: 30 },
      { meal_prep: true, calories: 1500, protein: 150, carbs: 0, fat: 40 },
    ];
    expect(reduceDayTotalsExcludingPrep(meals, macrosFor)).toEqual({
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
    });
  });

  it('skips entries whose macrosFor returns null (e.g. unresolved recipe)', () => {
    const meals: Meal[] = [
      { meal_prep: false, calories: 0, protein: 0, carbs: 0, fat: 0 },
      { meal_prep: false, calories: 500, protein: 30, carbs: 40, fat: 15 },
    ];
    const partialMacros = (m: Meal) => (m.calories === 0 ? null : macrosFor(m));
    expect(reduceDayTotalsExcludingPrep(meals, partialMacros)).toEqual({
      calories: 500,
      protein: 30,
      carbs: 40,
      fat: 15,
    });
  });
});
