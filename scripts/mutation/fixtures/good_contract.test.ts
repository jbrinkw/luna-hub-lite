import { describe, expect, it } from 'vitest';
import { bucket, clampTagged } from './good_contract';

describe('bucket', () => {
  it('returns "zero" for exactly 0', () => {
    expect(bucket(0, 10)).toBe('zero');
    expect(bucket(0, 1)).toBe('zero');
  });

  it('returns "low" for 0 < score < limit', () => {
    expect(bucket(1, 10)).toBe('low');
    expect(bucket(5, 10)).toBe('low');
    expect(bucket(9, 10)).toBe('low');
  });

  it('returns "high" for score >= limit', () => {
    expect(bucket(10, 10)).toBe('high'); // boundary: score == limit
    expect(bucket(11, 10)).toBe('high');
    expect(bucket(1000, 10)).toBe('high');
  });

  it('distinguishes zero from low at score=0 boundary', () => {
    // A `score === 0` → `score !== 0` mutation would send 0 to "low".
    expect(bucket(0, 5)).not.toBe('low');
    expect(bucket(0, 5)).not.toBe('high');
  });
});

describe('clampTagged', () => {
  it('returns neg-max when max < 0', () => {
    expect(clampTagged(5, -1)).toEqual({ value: 0, tag: 'neg-max' });
    expect(clampTagged(-5, -1)).toEqual({ value: 0, tag: 'neg-max' });
  });

  it('returns ok when max === 0 and n === 0 (kills max <= 0 mutation)', () => {
    // With `max < 0` mutated to `max <= 0`, max=0 would incorrectly be
    // tagged neg-max. The tag must be 'ok' here.
    expect(clampTagged(0, 0)).toEqual({ value: 0, tag: 'ok' });
  });

  it('returns neg-n when n < 0 and max >= 0', () => {
    expect(clampTagged(-1, 10)).toEqual({ value: 0, tag: 'neg-n' });
    expect(clampTagged(-100, 10)).toEqual({ value: 0, tag: 'neg-n' });
  });

  it('returns ok when n === 0 and max > 0 (kills n <= 0 mutation)', () => {
    expect(clampTagged(0, 10)).toEqual({ value: 0, tag: 'ok' });
  });

  it('returns over when n > max', () => {
    expect(clampTagged(11, 10)).toEqual({ value: 10, tag: 'over' });
    expect(clampTagged(9999, 10)).toEqual({ value: 10, tag: 'over' });
  });

  it('returns ok when n === max (kills n >= max mutation)', () => {
    // With `n > max` mutated to `n >= max`, n==max would incorrectly be
    // tagged over. The tag must be 'ok'.
    expect(clampTagged(10, 10)).toEqual({ value: 10, tag: 'ok' });
    expect(clampTagged(7, 7)).toEqual({ value: 7, tag: 'ok' });
  });

  it('returns ok with correct value for mid-range', () => {
    expect(clampTagged(5, 10)).toEqual({ value: 5, tag: 'ok' });
  });
});
