/**
 * Pure-helper tests for the new "PARTIAL (N missing)" + "Uses expiring
 * stock" recipe-card affordances introduced via the UX_AUDIT_CHEFBYTE_INTAKE
 * pass.
 *
 * The audit explicitly called out:
 *   - "PARTIAL is not actionable" — badge doesn't say what's missing.
 *   - "No 'uses what's about to expire' filter" — highest-value missing
 *     filter given default_shelf_life_days + the expired section.
 *
 * Both are surfaced by helpers exported from RecipesPage, so the test
 * lives at the pure-helper layer to mutation-check them without re-
 * rendering the whole page.
 */
import { describe, it, expect } from 'vitest';
import { computeMissingIngredients, recipeUsesExpiringStock } from '@/pages/chefbyte/RecipesPage';

const makeIng = (product_id: string, quantity: number, unit: string, name: string, spc = 1) => ({
  product_id,
  quantity,
  unit,
  products: { name, servings_per_container: spc },
});

describe('computeMissingIngredients', () => {
  it('returns empty when every ingredient has sufficient container stock', () => {
    const ings = [makeIng('a', 1, 'container', 'Eggs'), makeIng('b', 2, 'container', 'Milk')];
    const stock = new Map([
      ['a', 2],
      ['b', 3],
    ]);
    expect(computeMissingIngredients(ings, stock)).toEqual([]);
  });

  it('lists every ingredient lacking sufficient stock with required + have', () => {
    const ings = [makeIng('a', 1, 'container', 'Eggs'), makeIng('b', 2, 'container', 'Milk')];
    // 'a' is fine (have 1, need 1); 'b' is short (have 0, need 2)
    const stock = new Map([['a', 1]]);
    const missing = computeMissingIngredients(ings, stock);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      product_id: 'b',
      product_name: 'Milk',
      required: 2,
      haveContainers: 0,
    });
  });

  it('converts serving units to containers using servings_per_container', () => {
    // 4 servings @ 2 spc = 2 containers required, only 1 in stock → missing
    const ings = [makeIng('a', 4, 'serving', 'Bread', 2)];
    const stock = new Map([['a', 1]]);
    const missing = computeMissingIngredients(ings, stock);
    expect(missing).toHaveLength(1);
    expect(missing[0].required).toBeCloseTo(2);
    expect(missing[0].haveContainers).toBe(1);
  });

  it('skips ingredients with null products (placeholders) entirely', () => {
    const ings = [
      makeIng('a', 1, 'container', 'Real'),
      { product_id: 'b', quantity: 9999, unit: 'container', products: null },
    ];
    const stock = new Map<string, number>();
    const missing = computeMissingIngredients(ings, stock);
    // 'b' is null-products → skipped; 'a' missing.
    expect(missing.map((m) => m.product_id)).toEqual(['a']);
  });

  it('product missing from the stock map is treated as 0 (not undefined)', () => {
    const ings = [makeIng('a', 1, 'container', 'Vanilla')];
    const stock = new Map<string, number>(); // no 'a' key at all
    const missing = computeMissingIngredients(ings, stock);
    expect(missing).toHaveLength(1);
    expect(missing[0].haveContainers).toBe(0);
  });
});

describe('recipeUsesExpiringStock', () => {
  it('returns true when any ingredient appears in the expiring set', () => {
    const ings = [{ product_id: 'a' }, { product_id: 'b' }];
    expect(recipeUsesExpiringStock(ings, new Set(['b']))).toBe(true);
  });

  it('returns false when no ingredients overlap the expiring set', () => {
    const ings = [{ product_id: 'a' }, { product_id: 'b' }];
    expect(recipeUsesExpiringStock(ings, new Set(['x', 'y']))).toBe(false);
  });

  it('returns false on an empty expiring set, regardless of ingredients', () => {
    const ings = [{ product_id: 'a' }];
    expect(recipeUsesExpiringStock(ings, new Set())).toBe(false);
  });

  it('returns false when the recipe has no ingredients (vacuous case)', () => {
    expect(recipeUsesExpiringStock([], new Set(['a']))).toBe(false);
  });
});
