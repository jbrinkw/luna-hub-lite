import { describe, expect, it } from 'vitest';
import { bucketTaut, clampTaggedTaut } from './tautology';

// DELIBERATELY WEAK — this is the negative fixture for the mutation gate.
// A rigorous test would kill mutants; these assertions don't. They check
// only defined-ness and rough type shape, leaving all branch logic
// unconstrained.

describe('bucketTaut (tautological)', () => {
  it('is defined', () => {
    expect(bucketTaut).toBeDefined();
  });

  it('returns a string', () => {
    expect(typeof bucketTaut(0, 0)).toBe('string');
    expect(typeof bucketTaut(5, 10)).toBe('string');
  });
});

describe('clampTaggedTaut (tautological)', () => {
  it('is defined', () => {
    expect(clampTaggedTaut).toBeDefined();
  });

  it('returns an object with value and tag keys', () => {
    const r = clampTaggedTaut(5, 10);
    expect(r).toHaveProperty('value');
    expect(r).toHaveProperty('tag');
  });
});
