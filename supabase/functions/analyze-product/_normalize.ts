// Response-normalization helpers for analyze-product.
//
// Extracted from index.ts so they're unit-testable in Deno isolation
// (supabase/functions/analyze-product/test.ts). The runtime HTTP entry
// point still lives in index.ts.

export interface Suggestion {
  name: string;
  servings_per_container: number;
  calories_per_serving: number;
  carbs_per_serving: number;
  protein_per_serving: number;
  fat_per_serving: number;
  description?: string;
  default_shelf_life_days: number | null;
  /** AI-estimated days until expiry from import date. Null = non-perishable or uncertain. Range 1–730. */
  default_expiry_days: number | null;
  /** True when sold as discrete countable pieces (eggs, buns, bars, packets). */
  is_distinct_unit_item: boolean;
  /** Default unit for recipe form. 'gram' requires net_weight_g > 0. */
  default_recipe_unit: 'gram' | 'serving' | 'container';
  /** Full container mass in grams. Required when default_recipe_unit='gram'. */
  net_weight_g: number | null;
}

/** Result of validateSuggestion: ok | a list of missing required fields. */
export type SuggestionValidation = { ok: true; suggestion: Suggestion } | { ok: false; missing: string[] };

/**
 * Parse a Claude Haiku response into a structured suggestion.
 *
 * Claude is told to return STRICT JSON, but in practice the text can
 * arrive as:
 *   - clean JSON object: `{...}`
 *   - markdown-fenced: ` ```json\n{...}\n``` `
 *   - clean JSON preceded/followed by prose explanation
 *   - truncated (max_tokens hit) — JSON.parse throws
 *
 * Returns the parsed object, or null if no parseable JSON object could
 * be extracted. Mirrors the old inline try/catch + "return null" that
 * caused the `ai_degraded:true` fallback.
 */
export function parseAIResponse(text: string): Record<string, unknown> | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Fast path: clean JSON.
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: JSON.parse fails on malformed LLM output — fall through to markdown-fence recovery
  } catch {}

  // Recovery 1: strip markdown fences and retry. Matches ```json ... ```
  // and plain ``` ... ``` blocks.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: markdown-fenced JSON is still malformed — fall through to brace-extraction recovery
    } catch {}
  }

  // Recovery 2: extract the first balanced `{...}` substring. Handles
  // "Here is the JSON: {...}" and truncated-tail cases where the model
  // wrote prose after a well-formed object.
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = firstBrace; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.slice(firstBrace, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              return parsed as Record<string, unknown>;
            }
            // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: extracted brace-balanced substring is still invalid JSON — give up and return null
          } catch {}
          break;
        }
      }
    }
  }

  return null;
}

/**
 * Validate + coerce a raw parsed suggestion. Returns
 *   { ok: false, missing: [...] }  when a required field is null/missing,
 *   { ok: true, suggestion }       with coerced numeric + clamped shelf-life.
 *
 * Extracted from the inline block in index.ts so the scanner-path assertion
 * ("required fields present" → 422 otherwise) is testable without HTTP.
 */
export function validateSuggestion(raw: Record<string, unknown> | null): SuggestionValidation {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, missing: ['*'] };
  }

  const required = ['name', 'calories_per_serving', 'protein_per_serving', 'carbs_per_serving', 'fat_per_serving'];
  const missing = required.filter((k) => raw[k] == null);
  if (missing.length > 0) return { ok: false, missing };

  // Coerce numeric fields to numbers; non-numeric → 0 (matches old
  // `Number(x) || 0` semantics).
  const numericFields = [
    'calories_per_serving',
    'protein_per_serving',
    'carbs_per_serving',
    'fat_per_serving',
    'servings_per_container',
  ] as const;
  const coerced: Record<string, unknown> = { ...raw };
  for (const k of numericFields) {
    // eslint-disable-next-line @luna/anti-lazy/no-bare-number-coerce -- reason: LLM may return string numerics; || 0 provides safe fallback matching `Number(x) || 0` semantics documented in comment above
    if (coerced[k] != null) coerced[k] = Number(coerced[k]) || 0;
  }

  // servings_per_container: default to 1 when missing / < 1
  const spc = coerced.servings_per_container as number | undefined;
  if (!spc || spc < 1) coerced.servings_per_container = 1;

  // default_shelf_life_days: integer in [1, 3650] or null. Coerce, clamp,
  // or nullify — never surface a 422 for this field.
  if (coerced.default_shelf_life_days != null) {
    // eslint-disable-next-line @luna/anti-lazy/no-bare-number-coerce -- reason: immediately guarded by Number.isFinite in the same expression; LLM may return string or float
    const n = Math.round(Number(coerced.default_shelf_life_days));
    coerced.default_shelf_life_days = Number.isFinite(n) && n >= 1 && n <= 3650 ? n : null;
  } else {
    coerced.default_shelf_life_days = null;
  }

  // default_expiry_days: integer in [1, 730] or null. Coerce, clamp,
  // or nullify — never surface a 422 for this field. Out-of-range values
  // are clamped to null with a warning so the caller can log + continue.
  if (coerced.default_expiry_days != null) {
    // eslint-disable-next-line @luna/anti-lazy/no-bare-number-coerce -- reason: result `n` is checked with Number.isFinite on the next line; the rule walks parent expressions only and can't trace forward to the assigned variable's check
    const n = Math.round(Number(coerced.default_expiry_days));
    if (Number.isFinite(n) && n >= 1 && n <= 730) {
      coerced.default_expiry_days = n;
    } else {
      console.warn(
        `validateSuggestion: default_expiry_days ${coerced.default_expiry_days} out of range [1,730] — clamping to null`,
      );
      coerced.default_expiry_days = null;
    }
  } else {
    coerced.default_expiry_days = null;
  }

  // is_distinct_unit_item: coerce to boolean, default false.
  coerced.is_distinct_unit_item = !!coerced.is_distinct_unit_item;

  // net_weight_g: must be a positive number or null.
  if (coerced.net_weight_g != null) {
    const w = Number(coerced.net_weight_g);
    coerced.net_weight_g = Number.isFinite(w) && w > 0 ? w : null;
  } else {
    coerced.net_weight_g = null;
  }

  // default_recipe_unit: only 'gram'|'serving'|'container' accepted.
  // Defensive: if 'gram' but net_weight_g absent/non-positive → downgrade to 'serving'.
  const VALID_UNITS = new Set(['gram', 'serving', 'container']);
  if (!VALID_UNITS.has(coerced.default_recipe_unit as string)) {
    // Fall back: distinct items → 'serving', bulk → 'serving' (safe default).
    coerced.default_recipe_unit = 'serving';
  }
  if (coerced.default_recipe_unit === 'gram' && !coerced.net_weight_g) {
    console.warn('validateSuggestion: downgrading default_recipe_unit gram→serving (net_weight_g missing)');
    coerced.default_recipe_unit = 'serving';
  }

  return { ok: true, suggestion: coerced as unknown as Suggestion };
}

/**
 * 4-4-9 calorie validator. Returns the percent drift between the declared
 * calories and (protein*4 + carbs*4 + fat*9). Negative means calories are
 * under-stated; positive means over-stated.
 *
 * Returns `null` when the macros all round to zero — there's nothing to
 * validate against.
 *
 * The real AI is told to adjust calories to match when >10% off; this
 * helper is the yardstick the test uses to assert the prompt rule is
 * correctly applied.
 */
export function calorieDrift(macros: { protein: number; carbs: number; fat: number; calories: number }): number | null {
  const derived = macros.protein * 4 + macros.carbs * 4 + macros.fat * 9;
  if (derived <= 0) return null;
  if (!Number.isFinite(macros.calories)) return null;
  return ((macros.calories - derived) / derived) * 100;
}

/** True when the calorie drift exceeds `thresholdPct` (default 10). */
export function isCalorieDriftImplausible(
  macros: { protein: number; carbs: number; fat: number; calories: number },
  thresholdPct = 10,
): boolean {
  const drift = calorieDrift(macros);
  if (drift === null) return false;
  return Math.abs(drift) > thresholdPct;
}
