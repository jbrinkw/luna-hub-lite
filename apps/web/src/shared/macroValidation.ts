/**
 * 4-4-9 calorie validation — heuristic check that logged macros agree
 * with logged calories. Soft warning surface for the Macros consumed
 * list (FLAG: ChefByte USE — "4-4-9 calorie validation indicator on
 * logged temp items").
 *
 * Calories ≈ 4·protein + 4·carbs + 9·fat (Atwater factors). Real
 * foods drift ~5% from this; we warn at >25% off so the warning only
 * surfaces on bad LLM extractions / typos / unit mismatches and not
 * on every avocado.
 *
 * Returns null when within tolerance, or a `{ expected, delta }` shape
 * the UI can render.
 */
export interface MacroDelta {
  /** 4P + 4C + 9F — what the calories "should" read. */
  expected: number;
  /** Signed delta: actual - expected. Positive = actual is higher. */
  delta: number;
  /** Absolute % off (delta / expected, clamped). 0.30 = 30% off. */
  pctOff: number;
}

const TOLERANCE_PCT = 0.25;

export function macroDelta(calories: number, protein: number, carbs: number, fat: number): MacroDelta | null {
  // Skip the check on rows that are clearly "no macro data" — a 0-cal
  // row with 0/0/0 macros agrees trivially. Also skip when calories is
  // a positive but tiny number (a flavor-only entry); an extra cup of
  // coffee at 5 cal shouldn't warn even though 4·0+4·0+9·0=0.
  if (calories <= 5) return null;
  const expected = 4 * protein + 4 * carbs + 9 * fat;
  if (expected <= 5) return null;
  const delta = calories - expected;
  const pctOff = Math.abs(delta) / expected;
  if (pctOff < TOLERANCE_PCT) return null;
  return { expected: Math.round(expected), delta: Math.round(delta), pctOff };
}
