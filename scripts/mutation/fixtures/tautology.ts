// tautology.ts — same function shape as good_contract.ts but its test only
// checks defined-ness and type. Stryker should report LOW kill rate (high
// survivor count). Used by the mutation meta-test as the negative case.

export function bucketTaut(score: number, limit: number): 'zero' | 'low' | 'high' {
  if (score === 0) return 'zero';
  if (score < limit) return 'low';
  return 'high';
}

export function clampTaggedTaut(n: number, max: number): { value: number; tag: 'neg-max' | 'neg-n' | 'over' | 'ok' } {
  if (max < 0) return { value: 0, tag: 'neg-max' };
  if (n < 0) return { value: 0, tag: 'neg-n' };
  if (n > max) return { value: max, tag: 'over' };
  return { value: n, tag: 'ok' };
}
