import { describe, it, expect } from 'vitest';
import { computeMealEntryMacros } from '@/pages/chefbyte/HomePage';

describe('computeMealEntryMacros', () => {
  it('computes macros from recipe ingredients', () => {
    const entry = {
      meal_id: '1',
      servings: 2,
      meal_type: 'lunch',
      completed_at: null,
      product_id: null,
      products: null,
      recipes: {
        name: 'Test Recipe',
        base_servings: 4,
        recipe_ingredients: [
          {
            product_id: 'p1',
            quantity: 2,
            unit: 'containers',
            products: {
              calories_per_serving: 100,
              protein_per_serving: 10,
              carbs_per_serving: 20,
              fat_per_serving: 5,
              servings_per_container: 1,
            },
          },
        ],
      },
    } as any;

    // computeRecipeMacros(ingredients, baseServings=1):
    //   multiplier = qty(2) × servings_per_container(1) = 2
    //   perServing = (200cal, 20p, 40c, 10f) / 1 = (200, 20, 40, 10)
    // computeMealEntryMacros multiplies by entry.servings(2):
    //   Final = (400, 40, 80, 20)
    const result = computeMealEntryMacros(entry);
    expect(result).toEqual({
      calories: 400,
      protein: 40,
      carbs: 80,
      fat: 20,
    });
  });

  it('computes macros from product (no recipe)', () => {
    const entry = {
      meal_id: '2',
      servings: 3,
      meal_type: 'snack',
      completed_at: null,
      product_id: 'p1',
      recipes: null,
      products: {
        name: 'Chicken',
        calories_per_serving: 200,
        protein_per_serving: 30,
        carbs_per_serving: 0,
        fat_per_serving: 8,
        servings_per_container: 1,
      },
    } as any;

    const result = computeMealEntryMacros(entry);
    expect(result).toEqual({
      calories: 600,
      protein: 90,
      carbs: 0,
      fat: 24,
    });
  });

  it('returns null when no recipe or product', () => {
    const entry = {
      meal_id: '3',
      servings: 1,
      meal_type: null,
      completed_at: null,
      product_id: null,
      recipes: null,
      products: null,
    } as any;

    expect(computeMealEntryMacros(entry)).toBeNull();
  });
});
