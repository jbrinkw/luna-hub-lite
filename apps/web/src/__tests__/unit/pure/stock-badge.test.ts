import { describe, it, expect } from 'vitest';

/**
 * Stock badge color function from InventoryPage.
 * Returns hex color based on totalStock vs minStock threshold.
 */
const stockBadgeBg = (totalStock: number, minStock: number): string => {
  if (totalStock <= 0) return '#d33';
  if (totalStock < minStock) return '#ff9800';
  return '#2f9e44';
};

describe('stockBadgeBg', () => {
  it('returns red (#d33) when totalStock is 0', () => {
    expect(stockBadgeBg(0, 2)).toBe('#d33');
  });

  it('returns red (#d33) when totalStock is negative', () => {
    expect(stockBadgeBg(-1, 2)).toBe('#d33');
  });

  it('returns orange (#ff9800) when totalStock < minStock', () => {
    expect(stockBadgeBg(1, 3)).toBe('#ff9800');
  });

  it('returns green (#2f9e44) when totalStock >= minStock', () => {
    expect(stockBadgeBg(3, 3)).toBe('#2f9e44');
  });

  it('returns green (#2f9e44) when totalStock > minStock', () => {
    expect(stockBadgeBg(5, 2)).toBe('#2f9e44');
  });

  it('returns green when minStock is 0 and stock is positive', () => {
    expect(stockBadgeBg(1, 0)).toBe('#2f9e44');
  });
});
