import { describe, it, expect } from 'vitest';
import { pctOf } from '@/pages/chefbyte/HomePage';

describe('pctOf', () => {
  /* ---- Standard percentages ---- */

  it('calculates 50% correctly', () => {
    expect(pctOf(100, 200)).toBe(50);
  });

  it('calculates 100% correctly', () => {
    expect(pctOf(200, 200)).toBe(100);
  });

  it('calculates 0% correctly', () => {
    expect(pctOf(0, 200)).toBe(0);
  });

  it('rounds to nearest integer', () => {
    // 1/3 * 100 = 33.33 -> 33
    expect(pctOf(1, 3)).toBe(33);
  });

  it('rounds 2/3 to 67%', () => {
    // 2/3 * 100 = 66.67 -> 67
    expect(pctOf(2, 3)).toBe(67);
  });

  /* ---- Capping at 100 ---- */

  it('caps at 100 when value exceeds goal', () => {
    expect(pctOf(300, 200)).toBe(100);
  });

  it('caps at exactly 100 for large exceedance', () => {
    expect(pctOf(10000, 1)).toBe(100);
  });

  /* ---- Division by zero / non-positive goal ---- */

  it('returns 0 when goal is 0', () => {
    expect(pctOf(100, 0)).toBe(0);
  });

  it('returns 0 when goal is negative', () => {
    expect(pctOf(100, -50)).toBe(0);
  });

  /* ---- Edge cases ---- */

  it('returns 0 when both value and goal are 0', () => {
    expect(pctOf(0, 0)).toBe(0);
  });

  it('handles small fractional values', () => {
    // 0.1/100 * 100 = 0.1 -> rounds to 0
    expect(pctOf(0.1, 100)).toBe(0);
  });

  it('handles decimal goals', () => {
    // 50/100.5 * 100 = 49.75 -> 50
    expect(pctOf(50, 100.5)).toBe(50);
  });
});
