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

  /* ---- display_by_weight (highest precedence) ---- */

  it('by-weight + metric + serving unit: 1.33 svg of 454g/4-svg beef → "151g <name>"', () => {
    expect(
      formatIngredientDisplay({
        quantity: 1.33,
        unit: 'serving',
        productName: 'Ground Beef',
        visualUnitLabel: null,
        visualUnitsPerServing: null,
        servingsPerContainer: 4,
        displayByWeight: true,
        netWeightG: 454,
        unitSystem: 'metric',
      }),
    ).toBe('151g Ground Beef');
  });

  it('by-weight + imperial + serving unit: 1.33 svg of 454g/4-svg beef → "5.3oz <name>"', () => {
    expect(
      formatIngredientDisplay({
        quantity: 1.33,
        unit: 'serving',
        productName: 'Ground Beef',
        visualUnitLabel: null,
        visualUnitsPerServing: null,
        servingsPerContainer: 4,
        displayByWeight: true,
        netWeightG: 454,
        unitSystem: 'imperial',
      }),
    ).toBe('5.3oz Ground Beef');
  });

  it('by-weight + container unit: 0.5 ctn of 454g beef → "227g <name>"', () => {
    expect(
      formatIngredientDisplay({
        quantity: 0.5,
        unit: 'container',
        productName: 'Ground Beef',
        visualUnitLabel: null,
        visualUnitsPerServing: null,
        servingsPerContainer: 4,
        displayByWeight: true,
        netWeightG: 454,
        unitSystem: 'metric',
      }),
    ).toBe('227g Ground Beef');
  });

  it('by-weight + gram unit (already grams): qty=200 → "200g <name>"', () => {
    expect(
      formatIngredientDisplay({
        quantity: 200,
        unit: 'gram',
        productName: 'Flour',
        visualUnitLabel: null,
        visualUnitsPerServing: null,
        servingsPerContainer: 50,
        displayByWeight: true,
        netWeightG: 2270,
        unitSystem: 'metric',
      }),
    ).toBe('200g Flour');
  });

  it('by-weight precedes visual: visual_unit_label ignored when display_by_weight=true', () => {
    expect(
      formatIngredientDisplay({
        quantity: 2,
        unit: 'serving',
        productName: 'Beef',
        visualUnitLabel: 'oz',
        visualUnitsPerServing: 4,
        servingsPerContainer: 4,
        displayByWeight: true,
        netWeightG: 454,
        unitSystem: 'metric',
      }),
    ).toBe('227g Beef');
  });

  it('by-weight true but netWeightG missing → falls through to canonical', () => {
    expect(
      formatIngredientDisplay({
        quantity: 2,
        unit: 'serving',
        productName: 'Beef',
        visualUnitLabel: null,
        visualUnitsPerServing: null,
        servingsPerContainer: 4,
        displayByWeight: true,
        netWeightG: null,
        unitSystem: 'metric',
      }),
    ).toBe('2 svg Beef');
  });

  /* ---- Unit-abbreviation labels never pluralize ---- */

  it('label="oz" + count > 1 → "2 oz" (no plural-s on abbreviation)', () => {
    expect(
      formatIngredientDisplay({
        quantity: 2,
        unit: 'serving',
        productName: 'Cheddar',
        visualUnitLabel: 'oz',
        visualUnitsPerServing: 1,
        servingsPerContainer: 8,
      }),
    ).toBe('2 oz Cheddar');
  });

  it('label="tbsp" + count > 1 → "3 tbsp" (no plural-s)', () => {
    expect(
      formatIngredientDisplay({
        quantity: 3,
        unit: 'serving',
        productName: 'Mayo',
        visualUnitLabel: 'tbsp',
        visualUnitsPerServing: 1,
        servingsPerContainer: 60,
      }),
    ).toBe('3 tbsp Mayo');
  });

  it('label="oz" + count = 0.5 → "0.5 oz" (no plural-s on fractional)', () => {
    expect(
      formatIngredientDisplay({
        quantity: 0.5,
        unit: 'serving',
        productName: 'Cheddar',
        visualUnitLabel: 'oz',
        visualUnitsPerServing: 1,
        servingsPerContainer: 8,
      }),
    ).toBe('0.5 oz Cheddar');
  });

  it('label "OZ" (uppercase) is matched case-insensitively', () => {
    expect(
      formatIngredientDisplay({
        quantity: 2,
        unit: 'serving',
        productName: 'Cheddar',
        visualUnitLabel: 'OZ',
        visualUnitsPerServing: 1,
        servingsPerContainer: 8,
      }),
    ).toBe('2 OZ Cheddar');
  });

  it('non-abbreviation labels still pluralize: "cup" + 2 → "cups"', () => {
    expect(
      formatIngredientDisplay({
        quantity: 2,
        unit: 'serving',
        productName: 'Milk',
        visualUnitLabel: 'cup',
        visualUnitsPerServing: 1,
        servingsPerContainer: 16,
      }),
    ).toBe('2 cups Milk');
  });

  it('by-weight defaults to imperial when unitSystem omitted', () => {
    expect(
      formatIngredientDisplay({
        quantity: 1,
        unit: 'serving',
        productName: 'Beef',
        visualUnitLabel: null,
        visualUnitsPerServing: null,
        servingsPerContainer: 4,
        displayByWeight: true,
        netWeightG: 454,
      }),
    ).toBe('4.0oz Beef');
  });
});
