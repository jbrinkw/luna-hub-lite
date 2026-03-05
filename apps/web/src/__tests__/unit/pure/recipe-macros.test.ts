import { describe, it, expect } from 'vitest';
import { computeRecipeMacros } from '@/pages/chefbyte/RecipesPage';

const makeProduct = (cal: number, carbs: number, protein: number, fat: number, spc: number) => ({
  calories_per_serving: cal,
  carbs_per_serving: carbs,
  protein_per_serving: protein,
  fat_per_serving: fat,
  servings_per_container: spc,
});

describe('computeRecipeMacros', () => {
  /* ---- Unit type: serving ---- */

  it('uses quantity directly as multiplier for "serving" unit', () => {
    const ingredients = [{ quantity: 2, unit: 'serving', products: makeProduct(100, 20, 10, 5, 4) }];
    const result = computeRecipeMacros(ingredients, 2);
    // 2 * 100 = 200 total / 2 base_servings = 100
    expect(result.calories).toBe(100);
    expect(result.carbs).toBe(20);
    expect(result.protein).toBe(10);
    expect(result.fat).toBe(5);
  });

  /* ---- Unit type: container ---- */

  it('multiplies by servings_per_container for non-serving unit', () => {
    const ingredients = [{ quantity: 1, unit: 'container', products: makeProduct(100, 20, 10, 5, 4) }];
    const result = computeRecipeMacros(ingredients, 2);
    // 1 * 4 = 4 multiplier -> 4 * 100 = 400 / 2 = 200
    expect(result.calories).toBe(200);
    expect(result.carbs).toBe(40);
    expect(result.protein).toBe(20);
    expect(result.fat).toBe(10);
  });

  /* ---- Mixed ingredients ---- */

  it('computes correctly with mixed unit ingredients', () => {
    const ingredients = [
      { quantity: 2, unit: 'serving', products: makeProduct(165, 0, 31, 3.6, 4) },
      { quantity: 1, unit: 'container', products: makeProduct(60, 12, 2, 0, 3) },
    ];
    const result = computeRecipeMacros(ingredients, 2);
    // Chicken: 2 * 165 = 330 cal, 2*0=0 carb, 2*31=62 prot, 2*3.6=7.2 fat
    // Veg: 1*3 = 3 multiplier -> 3*60=180 cal, 3*12=36 carb, 3*2=6 prot, 3*0=0 fat
    // Total: 510 cal, 36 carb, 68 prot, 7.2 fat
    // / 2 = 255 cal, 18 carb, 34 prot, 3.6 -> round -> 4 fat
    expect(result.calories).toBe(255);
    expect(result.carbs).toBe(18);
    expect(result.protein).toBe(34);
    expect(result.fat).toBe(4);
  });

  /* ---- Empty ingredients ---- */

  it('returns zeros for empty ingredients list', () => {
    const result = computeRecipeMacros([], 1);
    expect(result.calories).toBe(0);
    expect(result.carbs).toBe(0);
    expect(result.protein).toBe(0);
    expect(result.fat).toBe(0);
  });

  /* ---- Null products ---- */

  it('handles null products gracefully (defaults to 0)', () => {
    const ingredients = [{ quantity: 1, unit: 'serving', products: null }];
    const result = computeRecipeMacros(ingredients, 1);
    expect(result.calories).toBe(0);
    expect(result.carbs).toBe(0);
    expect(result.protein).toBe(0);
    expect(result.fat).toBe(0);
  });

  /* ---- Division by zero protection ---- */

  it('prevents division by zero when baseServings is 0', () => {
    const ingredients = [{ quantity: 1, unit: 'serving', products: makeProduct(200, 30, 15, 8, 1) }];
    const result = computeRecipeMacros(ingredients, 0);
    // Math.max(0, 1) = 1 as divisor
    expect(result.calories).toBe(200);
    expect(result.carbs).toBe(30);
    expect(result.protein).toBe(15);
    expect(result.fat).toBe(8);
  });

  it('prevents division by zero when baseServings is negative', () => {
    const ingredients = [{ quantity: 1, unit: 'serving', products: makeProduct(200, 30, 15, 8, 1) }];
    const result = computeRecipeMacros(ingredients, -2);
    // Math.max(-2, 1) = 1 as divisor
    expect(result.calories).toBe(200);
    expect(result.carbs).toBe(30);
    expect(result.protein).toBe(15);
    expect(result.fat).toBe(8);
  });

  /* ---- Null servings_per_container fallback ---- */

  it('defaults servings_per_container to 1 when null in products for non-serving unit', () => {
    const ingredients = [
      {
        quantity: 2,
        unit: 'container',
        products: {
          calories_per_serving: 100,
          carbs_per_serving: 10,
          protein_per_serving: 5,
          fat_per_serving: 3,
          servings_per_container: undefined as any,
        },
      },
    ];
    // For non-serving unit: multiplier = quantity * (spc ?? 1) = 2 * 1 = 2
    // But actually the code uses `ing.products?.servings_per_container ?? 1`
    // With undefined, ?? 1 gives 1, so 2 * 1 = 2
    const result = computeRecipeMacros(ingredients, 1);
    expect(result.calories).toBe(200);
  });

  /* ---- Rounding ---- */

  it('rounds results to nearest integer', () => {
    const ingredients = [{ quantity: 1, unit: 'serving', products: makeProduct(100, 10, 10, 10, 1) }];
    const result = computeRecipeMacros(ingredients, 3);
    // 100/3 = 33.33 -> 33
    // 10/3 = 3.33 -> 3
    expect(result.calories).toBe(33);
    expect(result.carbs).toBe(3);
    expect(result.protein).toBe(3);
    expect(result.fat).toBe(3);
  });

  /* ---- Macro density (g per 100 cal) — used by recipe filter ---- */

  it('supports high-protein density calculation (g protein per 100 cal)', () => {
    // Chicken breast: 165 cal, 31g protein per serving
    const ingredients = [{ quantity: 1, unit: 'serving', products: makeProduct(165, 0, 31, 3.6, 1) }];
    const macros = computeRecipeMacros(ingredients, 1);
    const proteinPer100Cal = (macros.protein / macros.calories) * 100;
    // 31/165 * 100 = 18.8 g/100cal — high protein
    expect(proteinPer100Cal).toBeGreaterThan(8); // default threshold
    expect(proteinPer100Cal).toBeCloseTo(18.8, 0);
  });

  it('supports high-carbs density calculation (g carbs per 100 cal)', () => {
    // Rice: 200 cal, 45g carbs per serving
    const ingredients = [{ quantity: 1, unit: 'serving', products: makeProduct(200, 45, 4, 0.5, 1) }];
    const macros = computeRecipeMacros(ingredients, 1);
    const carbsPer100Cal = (macros.carbs / macros.calories) * 100;
    // 45/200 * 100 = 22.5 g/100cal — high carbs
    expect(carbsPer100Cal).toBeGreaterThan(10); // default threshold
    expect(carbsPer100Cal).toBeCloseTo(22.5, 0);
  });

  it('zero-calorie recipe excluded from density filters', () => {
    const macros = computeRecipeMacros([], 1);
    expect(macros.calories).toBe(0);
    // Filter should reject when calories is 0 (division by zero guard)
  });
});
