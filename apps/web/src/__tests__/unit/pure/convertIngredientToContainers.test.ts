/**
 * Unit tests for convertIngredientToContainers — the gram-unit helper
 * exported from RecipesPage.
 */
import { describe, it, expect } from 'vitest';
import { convertIngredientToContainers } from '@/pages/chefbyte/RecipesPage';

describe('convertIngredientToContainers', () => {
  // ── container ──────────────────────────────────────────────────────
  it('container: returns quantity unchanged (1:1)', () => {
    expect(
      convertIngredientToContainers({ quantity: 3, unit: 'container', servings_per_container: 4, net_weight_g: 500 }),
    ).toBe(3);
  });

  it('container: fractional container passes through', () => {
    expect(
      convertIngredientToContainers({
        quantity: 0.5,
        unit: 'container',
        servings_per_container: 2,
        net_weight_g: null,
      }),
    ).toBe(0.5);
  });

  // ── serving ────────────────────────────────────────────────────────
  it('serving: divides by servings_per_container', () => {
    // 4 servings / 4 spc = 1 container
    expect(
      convertIngredientToContainers({ quantity: 4, unit: 'serving', servings_per_container: 4, net_weight_g: null }),
    ).toBeCloseTo(1);
  });

  it('serving: fractional result', () => {
    // 1 serving / 4 spc = 0.25 containers
    expect(
      convertIngredientToContainers({ quantity: 1, unit: 'serving', servings_per_container: 4, net_weight_g: null }),
    ).toBeCloseTo(0.25);
  });

  it('serving: spc=0 clamps to 0.001 denominator (no divide-by-zero)', () => {
    const result = convertIngredientToContainers({
      quantity: 1,
      unit: 'serving',
      servings_per_container: 0,
      net_weight_g: null,
    });
    expect(result).toBeGreaterThan(0);
    expect(isFinite(result)).toBe(true);
  });

  // ── gram ───────────────────────────────────────────────────────────
  it('gram: divides quantity by net_weight_g', () => {
    // 200g / 500g per container = 0.4 containers
    expect(
      convertIngredientToContainers({ quantity: 200, unit: 'gram', servings_per_container: 4, net_weight_g: 500 }),
    ).toBeCloseTo(0.4);
  });

  it('gram: fractional grams (0.5g) returns positive containers', () => {
    // 0.5g / 250g = 0.002 containers — positive and finite
    const result = convertIngredientToContainers({
      quantity: 0.5,
      unit: 'gram',
      servings_per_container: 4,
      net_weight_g: 250,
    });
    expect(result).toBeGreaterThan(0);
    expect(isFinite(result)).toBe(true);
  });

  it('gram: large quantity (5000g / 250g container) returns 20', () => {
    expect(
      convertIngredientToContainers({ quantity: 5000, unit: 'gram', servings_per_container: 4, net_weight_g: 250 }),
    ).toBeCloseTo(20);
  });

  it('gram: net_weight_g=null throws', () => {
    expect(() =>
      convertIngredientToContainers({ quantity: 100, unit: 'gram', servings_per_container: 4, net_weight_g: null }),
    ).toThrow('gram unit requires product.net_weight_g > 0');
  });

  it('gram: net_weight_g=0 throws', () => {
    expect(() =>
      convertIngredientToContainers({ quantity: 100, unit: 'gram', servings_per_container: 4, net_weight_g: 0 }),
    ).toThrow('gram unit requires product.net_weight_g > 0');
  });

  it('gram: negative net_weight_g throws', () => {
    expect(() =>
      convertIngredientToContainers({ quantity: 100, unit: 'gram', servings_per_container: 4, net_weight_g: -1 }),
    ).toThrow('gram unit requires product.net_weight_g > 0');
  });

  // ── unknown unit ───────────────────────────────────────────────────
  it('unknown unit throws with descriptive message', () => {
    expect(() =>
      convertIngredientToContainers({
        quantity: 1,
        unit: 'kilogram' as any,
        servings_per_container: 4,
        net_weight_g: 500,
      }),
    ).toThrow('unknown unit: kilogram');
  });
});
