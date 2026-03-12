import { describe, it, expect } from 'vitest';

/**
 * Stock dot color function from InventoryPage.
 * Returns Tailwind class based on totalStock vs minStock threshold.
 */
const stockDotColor = (totalStock: number, minStock: number): string => {
  if (totalStock <= 0) return 'bg-red-600';
  if (totalStock < minStock) return 'bg-amber-500';
  return 'bg-green-600';
};

describe('stockDotColor', () => {
  it('returns red when totalStock is 0', () => {
    expect(stockDotColor(0, 2)).toBe('bg-red-600');
  });

  it('returns red when totalStock is negative', () => {
    expect(stockDotColor(-1, 2)).toBe('bg-red-600');
  });

  it('returns amber when totalStock < minStock', () => {
    expect(stockDotColor(1, 3)).toBe('bg-amber-500');
  });

  it('returns green when totalStock >= minStock', () => {
    expect(stockDotColor(3, 3)).toBe('bg-green-600');
  });

  it('returns green when totalStock > minStock', () => {
    expect(stockDotColor(5, 2)).toBe('bg-green-600');
  });

  it('returns green when minStock is 0 and stock is positive', () => {
    expect(stockDotColor(1, 0)).toBe('bg-green-600');
  });
});
