// good_contract.ts — small functions whose branches are distinguishable
// at their boundary values, so a rigorous test can kill virtually every
// Stryker mutant. The mutation meta-test expects HIGH score (> 80%).
//
// Specifically avoid functions where `<` vs `<=` produces the same output
// at the equality case — those generate equivalent mutants that NO test
// can kill, capping the achievable score below 100%.

/**
 * Bucket a non-negative integer into one of three labels.
 *   score == 0        → "zero"
 *   0 < score < limit → "low"
 *   score >= limit    → "high"
 *
 * The return-value changes at each boundary, so `<` ↔ `<=` and `>` ↔ `>=`
 * mutations all produce observably wrong outputs.
 */
export function bucket(score: number, limit: number): 'zero' | 'low' | 'high' {
  if (score === 0) return 'zero';
  if (score < limit) return 'low';
  return 'high';
}

/**
 * Clamp-and-tag: returns the clamped value AND a string tag indicating
 * which branch fired. Makes boundary-equivalent mutants detectable because
 * the tag differs even when the numeric output would be equal.
 */
export function clampTagged(n: number, max: number): { value: number; tag: 'neg-max' | 'neg-n' | 'over' | 'ok' } {
  if (max < 0) return { value: 0, tag: 'neg-max' };
  if (n < 0) return { value: 0, tag: 'neg-n' };
  if (n > max) return { value: max, tag: 'over' };
  return { value: n, tag: 'ok' };
}
