import { describe, it, expect } from 'vitest';
import { autoScaleNutrition } from '@/pages/chefbyte/ScannerPage';

const baseOriginal = {
  servingsPerContainer: '10',
  calories: '200',
  carbs: '20',
  fat: '10',
  protein: '15',
};

describe('autoScaleNutrition', () => {
  /* ---- Calorie-driven scaling ---- */

  it('scales macros proportionally when calories double', () => {
    const result = autoScaleNutrition('calories', '400', { ...baseOriginal }, baseOriginal);
    // ratio = 400/200 = 2x
    expect(result.calories).toBe('400');
    expect(result.carbs).toBe('40');
    expect(result.fat).toBe('20');
    expect(result.protein).toBe('30');
  });

  it('scales macros proportionally when calories halve', () => {
    const result = autoScaleNutrition('calories', '100', { ...baseOriginal }, baseOriginal);
    // ratio = 100/200 = 0.5x
    expect(result.calories).toBe('100');
    expect(result.carbs).toBe('10');
    expect(result.fat).toBe('5');
    expect(result.protein).toBe('7.5');
  });

  it('handles zero original calories (fallback divisor of 1)', () => {
    const zeroOrig = { ...baseOriginal, calories: '0' };
    const result = autoScaleNutrition('calories', '100', { ...baseOriginal }, zeroOrig);
    expect(result.calories).toBe('100');
    // origCals = parseFloat('0') || 1 = 1, so ratio = 100/1 = 100
    // carbs = round(20 * 100 * 10) / 10 = 2000
    expect(result.carbs).toBe('2000');
    expect(result.fat).toBe('1000');
    expect(result.protein).toBe('1500');
  });

  it('handles zero new calories (ratio becomes 0)', () => {
    const result = autoScaleNutrition('calories', '0', { ...baseOriginal }, baseOriginal);
    expect(result.calories).toBe('0');
    // origCals > 0 but newCals is 0, so the if branch (origCals > 0 && newCals > 0) is false
    // macros keep current values since only calories field is set
    expect(result.carbs).toBe('20');
  });

  it('handles empty string calories', () => {
    const result = autoScaleNutrition('calories', '', { ...baseOriginal }, baseOriginal);
    expect(result.calories).toBe('');
    // parseFloat('') = NaN -> 0, so no scaling
    expect(result.carbs).toBe('20');
  });

  /* ---- Macro-driven recalculation (4-4-9 rule) ---- */

  it('recalculates calories when carbs change', () => {
    const result = autoScaleNutrition('carbs', '30', { ...baseOriginal }, baseOriginal);
    // calories = 30*4 + 10*9 + 15*4 = 120 + 90 + 60 = 270
    expect(result.carbs).toBe('30');
    expect(result.calories).toBe('270');
    expect(result.fat).toBe('10');
    expect(result.protein).toBe('15');
  });

  it('recalculates calories when protein changes', () => {
    const result = autoScaleNutrition('protein', '25', { ...baseOriginal }, baseOriginal);
    // calories = 20*4 + 10*9 + 25*4 = 80 + 90 + 100 = 270
    expect(result.protein).toBe('25');
    expect(result.calories).toBe('270');
  });

  it('recalculates calories when fat changes', () => {
    const result = autoScaleNutrition('fat', '20', { ...baseOriginal }, baseOriginal);
    // calories = 20*4 + 20*9 + 15*4 = 80 + 180 + 60 = 320
    expect(result.fat).toBe('20');
    expect(result.calories).toBe('320');
  });

  it('recalculates to 0 calories when all macros are set to 0', () => {
    const zeroMacros = { ...baseOriginal, carbs: '0', fat: '0', protein: '0' };
    const result = autoScaleNutrition('carbs', '0', zeroMacros, baseOriginal);
    // calories = 0*4 + 0*9 + 0*4 = 0
    expect(result.calories).toBe('0');
  });

  /* ---- servingsPerContainer (no scaling) ---- */

  it('does not scale macros when editing servingsPerContainer', () => {
    const result = autoScaleNutrition('servingsPerContainer', '20', { ...baseOriginal }, baseOriginal);
    expect(result.servingsPerContainer).toBe('20');
    expect(result.calories).toBe('200');
    expect(result.carbs).toBe('20');
    expect(result.fat).toBe('10');
    expect(result.protein).toBe('15');
  });

  /* ---- Edge cases ---- */

  it('handles non-numeric macro values gracefully', () => {
    const result = autoScaleNutrition('carbs', 'abc', { ...baseOriginal }, baseOriginal);
    // parseFloat('abc') = NaN -> 0 for carbs
    // calories = 0*4 + 10*9 + 15*4 = 0 + 90 + 60 = 150
    expect(result.carbs).toBe('abc');
    expect(result.calories).toBe('150');
  });

  it('preserves other fields when changing one field', () => {
    const result = autoScaleNutrition('fat', '15', { ...baseOriginal }, baseOriginal);
    expect(result.servingsPerContainer).toBe('10');
    expect(result.fat).toBe('15');
    // carbs and protein unchanged
    expect(result.carbs).toBe('20');
    expect(result.protein).toBe('15');
  });

  it('rounds scaled values to 1 decimal place', () => {
    const orig = { ...baseOriginal, calories: '300', carbs: '33', fat: '11', protein: '17' };
    const result = autoScaleNutrition('calories', '200', { ...orig }, orig);
    // ratio = 200/300 = 0.6667
    // carbs = round(33 * 0.6667 * 10) / 10 = round(220.01) / 10 = 22
    expect(parseFloat(result.carbs)).toBeCloseTo(22, 0);
  });
});
