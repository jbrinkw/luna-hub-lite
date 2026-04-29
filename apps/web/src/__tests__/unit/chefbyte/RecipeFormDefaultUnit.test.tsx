/**
 * Unit tests for the smart default recipe unit selection logic in RecipeFormPage.
 *
 * The selectProduct callback applies this priority when setting ingUnit:
 *   1. product.default_recipe_unit if non-null AND viable
 *      ('gram' requires net_weight_g > 0)
 *   2. 'gram' if net_weight_g > 0 (and default_recipe_unit is null)
 *   3. 'serving' (final fallback)
 *
 * These tests exercise the logic as a pure function that mirrors the
 * component's selectProduct handler — no DOM rendering required, which
 * keeps the test fast and free of hook dependency noise.
 */

import { describe, it, expect } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Pure helper — mirrors the selectProduct unit-resolution logic      */
/* ------------------------------------------------------------------ */

/**
 * Computes the initial ingredient unit when a product is selected.
 * Mirrors the implementation in RecipeFormPage.selectProduct.
 */
function resolveInitialUnit(product: {
  net_weight_g: number | null;
  default_recipe_unit: 'gram' | 'serving' | 'container' | null;
}): string {
  const hasWeight = (product.net_weight_g ?? 0) > 0;
  if (product.default_recipe_unit && product.default_recipe_unit !== null) {
    if (product.default_recipe_unit === 'gram' && !hasWeight) {
      // gram is not viable without net_weight_g → fallback to serving
      return 'serving';
    } else {
      return product.default_recipe_unit;
    }
  } else if (hasWeight) {
    return 'gram';
  } else {
    return 'serving';
  }
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('RecipeFormPage — resolveInitialUnit (smart default unit)', () => {
  it('distinct product (default_recipe_unit=serving, no weight) → serving', () => {
    expect(resolveInitialUnit({ default_recipe_unit: 'serving', net_weight_g: null })).toBe('serving');
  });

  it('distinct product (default_recipe_unit=serving, has weight) → serving', () => {
    // Distinct items use serving even if net_weight_g happens to be set
    expect(resolveInitialUnit({ default_recipe_unit: 'serving', net_weight_g: 340 })).toBe('serving');
  });

  it('bulk product (default_recipe_unit=gram, net_weight_g=170) → gram', () => {
    expect(resolveInitialUnit({ default_recipe_unit: 'gram', net_weight_g: 170 })).toBe('gram');
  });

  it('container default (default_recipe_unit=container) → container', () => {
    expect(resolveInitialUnit({ default_recipe_unit: 'container', net_weight_g: null })).toBe('container');
  });

  it('downgrade: default_recipe_unit=gram but net_weight_g=null → serving', () => {
    expect(resolveInitialUnit({ default_recipe_unit: 'gram', net_weight_g: null })).toBe('serving');
  });

  it('downgrade: default_recipe_unit=gram but net_weight_g=0 → serving', () => {
    expect(resolveInitialUnit({ default_recipe_unit: 'gram', net_weight_g: 0 })).toBe('serving');
  });

  it('no default set but net_weight_g > 0 → gram (bulk fallback)', () => {
    expect(resolveInitialUnit({ default_recipe_unit: null, net_weight_g: 2267 })).toBe('gram');
  });

  it('placeholder with all-null defaults → serving (final fallback)', () => {
    expect(resolveInitialUnit({ default_recipe_unit: null, net_weight_g: null })).toBe('serving');
  });
});
