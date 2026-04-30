import { describe, it, expect } from 'vitest';
import { formatIngredientDisplay } from '@/shared/recipes/formatIngredientDisplay';

describe('formatIngredientDisplay', () => {
  /* ---- Visual pair set + unit conversions ---- */

  it('visual set + serving unit, qty=2, ratio=1, label="egg" → "2 eggs <name>"', () => {
    expect(
      formatIngredientDisplay({
        quantity: 2,
        unit: 'serving',
        productName: 'Cage-Free Eggs',
        visualUnitLabel: 'egg',
        visualUnitsPerServing: 1,
        servingsPerContainer: 12,
      }),
    ).toBe('2 eggs Cage-Free Eggs');
  });

  it('visual set + container unit, qty=1, servings_per_container=12, ratio=1, label="egg" → "12 eggs <name>"', () => {
    expect(
      formatIngredientDisplay({
        quantity: 1,
        unit: 'container',
        productName: 'Cage-Free Eggs',
        visualUnitLabel: 'egg',
        visualUnitsPerServing: 1,
        servingsPerContainer: 12,
      }),
    ).toBe('12 eggs Cage-Free Eggs');
  });

  it('visual set + gram unit → falls back to canonical "<n>g <name>"', () => {
    expect(
      formatIngredientDisplay({
        quantity: 30,
        unit: 'gram',
        productName: 'Bacon',
        visualUnitLabel: 'slice',
        visualUnitsPerServing: 1,
        servingsPerContainer: 4,
      }),
    ).toBe('30g Bacon');
  });

  /* ---- Visual unset, all 3 canonical units ---- */

  it('visual unset, gram → "<qty>g <name>"', () => {
    expect(
      formatIngredientDisplay({
        quantity: 30,
        unit: 'gram',
        productName: 'Bacon',
        visualUnitLabel: null,
        visualUnitsPerServing: null,
        servingsPerContainer: 4,
      }),
    ).toBe('30g Bacon');
  });

  it('visual unset, container → "<qty> ctn <name>"', () => {
    expect(
      formatIngredientDisplay({
        quantity: 1,
        unit: 'container',
        productName: 'Bacon',
        visualUnitLabel: null,
        visualUnitsPerServing: null,
        servingsPerContainer: 4,
      }),
    ).toBe('1 ctn Bacon');
  });

  it('visual unset, serving → "<qty> svg <name>"', () => {
    expect(
      formatIngredientDisplay({
        quantity: 2,
        unit: 'serving',
        productName: 'Bacon',
        visualUnitLabel: null,
        visualUnitsPerServing: null,
        servingsPerContainer: 4,
      }),
    ).toBe('2 svg Bacon');
  });

  /* ---- Pluralization ---- */

  it('pluralization: count=1 → singular ("1 egg")', () => {
    expect(
      formatIngredientDisplay({
        quantity: 1,
        unit: 'serving',
        productName: 'Eggs',
        visualUnitLabel: 'egg',
        visualUnitsPerServing: 1,
        servingsPerContainer: 12,
      }),
    ).toBe('1 egg Eggs');
  });

  it('pluralization: count=2 → plural ("2 eggs")', () => {
    expect(
      formatIngredientDisplay({
        quantity: 2,
        unit: 'serving',
        productName: 'Eggs',
        visualUnitLabel: 'egg',
        visualUnitsPerServing: 1,
        servingsPerContainer: 12,
      }),
    ).toBe('2 eggs Eggs');
  });

  it('pluralization: count=0.5 → plural ("0.5 eggs")', () => {
    expect(
      formatIngredientDisplay({
        quantity: 0.5,
        unit: 'serving',
        productName: 'Eggs',
        visualUnitLabel: 'egg',
        visualUnitsPerServing: 1,
        servingsPerContainer: 12,
      }),
    ).toBe('0.5 eggs Eggs');
  });

  /* ---- Fractional display ---- */

  it('fractional display: visual ratio < 1 (half-bagel-per-serving)', () => {
    // 1 serving × 0.5 bagels/serving = 0.5 bagel
    expect(
      formatIngredientDisplay({
        quantity: 1,
        unit: 'serving',
        productName: 'Big Bagel',
        visualUnitLabel: 'bagel',
        visualUnitsPerServing: 0.5,
        servingsPerContainer: 6,
      }),
    ).toBe('0.5 bagels Big Bagel');
  });

  it('fractional display: 0.25 cookie via serving-fraction', () => {
    // qty 0.25 servings × 1 cookie/serving = 0.25 cookies
    expect(
      formatIngredientDisplay({
        quantity: 0.25,
        unit: 'serving',
        productName: 'Cookies',
        visualUnitLabel: 'cookie',
        visualUnitsPerServing: 1,
        servingsPerContainer: 24,
      }),
    ).toBe('0.25 cookies Cookies');
  });

  /* ---- Visual set but partial (one field null) → fallback ---- */

  it('only visualUnitLabel set (units null) → canonical fallback', () => {
    expect(
      formatIngredientDisplay({
        quantity: 2,
        unit: 'serving',
        productName: 'Eggs',
        visualUnitLabel: 'egg',
        visualUnitsPerServing: null,
        servingsPerContainer: 12,
      }),
    ).toBe('2 svg Eggs');
  });

  it('only visualUnitsPerServing set (label null) → canonical fallback', () => {
    expect(
      formatIngredientDisplay({
        quantity: 2,
        unit: 'serving',
        productName: 'Eggs',
        visualUnitLabel: null,
        visualUnitsPerServing: 1,
        servingsPerContainer: 12,
      }),
    ).toBe('2 svg Eggs');
  });

  /* ---- Empty product name handled gracefully ---- */

  it('empty product name handled gracefully', () => {
    expect(
      formatIngredientDisplay({
        quantity: 1,
        unit: 'serving',
        productName: '',
        visualUnitLabel: null,
        visualUnitsPerServing: null,
        servingsPerContainer: 1,
      }),
    ).toBe('1 svg ');
  });
});
