import { describe, it, expect } from 'vitest';
import { computeStockStatus } from '@/pages/chefbyte/RecipesPage';

const makeIng = (product_id: string, quantity: number, unit: string, spc: number | null = 1) => ({
  product_id,
  quantity,
  unit,
  products: spc !== null ? { servings_per_container: spc } : null,
});

describe('computeStockStatus', () => {
  it('returns N/A for empty ingredients', () => {
    expect(computeStockStatus([], new Map())).toBe('N/A');
  });

  it('returns N/A when no ingredient has a linked product', () => {
    const ings = [{ product_id: 'a', quantity: 1, unit: 'container', products: null }];
    expect(computeStockStatus(ings, new Map())).toBe('N/A');
  });

  it('returns CAN MAKE when all ingredients have enough stock', () => {
    const ings = [makeIng('a', 2, 'container'), makeIng('b', 1, 'container')];
    const stock = new Map([
      ['a', 3],
      ['b', 1],
    ]);
    expect(computeStockStatus(ings, stock)).toBe('CAN MAKE');
  });

  it('returns NO STOCK when no ingredients have stock', () => {
    const ings = [makeIng('a', 1, 'container'), makeIng('b', 1, 'container')];
    const stock = new Map<string, number>();
    expect(computeStockStatus(ings, stock)).toBe('NO STOCK');
  });

  it('returns PARTIAL when some but not all ingredients have stock', () => {
    const ings = [makeIng('a', 1, 'container'), makeIng('b', 2, 'container')];
    const stock = new Map([
      ['a', 5],
      ['b', 1],
    ]);
    expect(computeStockStatus(ings, stock)).toBe('PARTIAL');
  });

  it('converts serving unit to containers for comparison', () => {
    // 4 servings needed, product has 2 servings/container = 2 containers needed
    const ings = [makeIng('a', 4, 'serving', 2)];
    const stock = new Map([['a', 2]]);
    expect(computeStockStatus(ings, stock)).toBe('CAN MAKE');
  });

  it('returns NO STOCK when serving conversion shows insufficient stock', () => {
    // 4 servings needed, 2 spc = 2 containers needed, only 1 in stock
    const ings = [makeIng('a', 4, 'serving', 2)];
    const stock = new Map([['a', 1]]);
    expect(computeStockStatus(ings, stock)).toBe('NO STOCK');
  });

  it('ignores ingredients with null products in stock check', () => {
    const ings = [makeIng('a', 1, 'container'), { product_id: 'b', quantity: 1, unit: 'container', products: null }];
    const stock = new Map([['a', 1]]);
    // Only 'a' is linked, and it has enough stock
    expect(computeStockStatus(ings, stock)).toBe('CAN MAKE');
  });
});
