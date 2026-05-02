// Response-normalization helpers for analyze-product.
//
// Extracted from index.ts so they're unit-testable in Deno isolation
// (supabase/functions/analyze-product/test.ts). The runtime HTTP entry
// point still lives in index.ts.
//
// Validation pipeline (post-LLM):
//
//   1. parseAIResponse — legacy text-mode JSON extractor. The runtime no
//      longer needs it (forced tool-use returns structured input directly),
//      but it's retained as defensive recovery + for the unit tests that
//      exercise malformed-text edge cases.
//   2. SuggestionSchema — Zod schema (Pydantic-style) that:
//        - coerces numerics from strings,
//        - clamps integer ranges (default_expiry_days / shelf_life_days)
//          to null when out-of-bounds rather than throwing,
//        - normalizes the visual-unit pair (both-or-neither),
//        - downgrades display_by_weight=true → false when net_weight_g
//          is missing (DB CHECK would reject it otherwise),
//        - asserts display_by_weight precedence over visual_unit_label,
//        - downgrades default_recipe_unit gram → serving when
//          net_weight_g is missing,
//        - COMPUTES calories_per_serving server-side via Atwater
//          (carbs×4 + protein×4 + fat×9). The AI does NOT emit calories —
//          that field was removed from the tool schema. This eliminates
//          the "model picked the wrong calorie source" failure class.
//   3. validateSuggestion wraps SuggestionSchema.safeParse and returns
//      `{ ok: true, suggestion }` or `{ ok: false, missing }` for the
//      caller's required-field-presence check.
//
// The schema is the single source of truth: TypeScript type, runtime
// validator, and (hand-mirrored) prompt JSON spec. If you change a
// field here, mirror it in `_prompt.ts`'s system prompt schema block.

import { z } from 'npm:zod@4.3.6';

/** Coerce numeric-or-numeric-string → finite number, defaulting to 0.
 * Accepts undefined as well so callers can omit optional macros without
 * triggering a Zod parse failure (the transform layer treats null and
 * undefined identically). */
const NumLike = z.union([z.number(), z.string(), z.null(), z.undefined()]).transform((v) => {
  if (v == null) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
});

/** Integer in [min, max] or null. Out-of-range values clamp to null
 * rather than throwing — the caller treats null as "unknown / non-perishable". */
const ClampedInt = (min: number, max: number) =>
  z.union([z.number(), z.string(), z.null(), z.undefined()]).transform((v) => {
    if (v == null) return null;
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (!Number.isFinite(n)) return null;
    const r = Math.round(n as number);
    return r >= min && r <= max ? r : null;
  });

/** Positive number or null. Zero / negative / non-finite → null. */
const PositiveOrNull = z.union([z.number(), z.string(), z.null(), z.undefined()]).transform((v) => {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) && (n as number) > 0 ? (n as number) : null;
});

/** Trimmed non-empty string or null. */
const TrimmedStringOrNull = z.union([z.string(), z.null(), z.undefined()]).transform((s) => {
  if (s == null) return null;
  const t = s.trim();
  return t === '' ? null : t;
});

/**
 * Raw schema — applies field-level coercion and clamping. Cross-field
 * invariants are layered on via the .transform below.
 *
 * calories_per_serving is INTENTIONALLY absent. The AI never emits it —
 * the tool schema doesn't include the field. SuggestionSchema's transform
 * computes it from the macros via Atwater. If a legacy caller still sends
 * a `calories_per_serving` value (test suite + parseAIResponse paths),
 * Zod silently ignores the extra key (strict mode is off) and the
 * computed value overwrites it.
 */
const SuggestionRawSchema = z.object({
  name: z.string().min(1),
  servings_per_container: NumLike.transform((n) => (n >= 1 ? n : 1)),
  carbs_per_serving: NumLike,
  protein_per_serving: NumLike,
  fat_per_serving: NumLike,
  description: z.string().optional(),
  default_shelf_life_days: ClampedInt(1, 3650),
  default_expiry_days: ClampedInt(1, 730),
  is_distinct_unit_item: z.union([z.boolean(), z.null(), z.undefined()]).transform((v) => !!v),
  default_recipe_unit: z
    .union([z.enum(['gram', 'serving', 'container']), z.string(), z.null(), z.undefined()])
    .transform((v) => (v === 'gram' || v === 'serving' || v === 'container' ? v : 'serving')),
  net_weight_g: PositiveOrNull,
  visual_unit_label: TrimmedStringOrNull,
  visual_units_per_serving: PositiveOrNull,
  display_by_weight: z.union([z.boolean(), z.null(), z.undefined()]).transform((v) => !!v),
});

/**
 * Cross-field transform layer — applied after field-level coercion.
 *
 * - Visual pair both-or-neither: if only one of label/units is set, clear both.
 * - display_by_weight requires net_weight_g > 0 → downgrade to false otherwise.
 * - display_by_weight precedence: when true, force visual pair null (helper's render
 *   logic already prefers display_by_weight, but keeping the row truthful avoids
 *   stale form-state on later edits).
 * - default_recipe_unit gram requires net_weight_g > 0 → downgrade to serving.
 * - calories_per_serving is COMPUTED server-side via Atwater
 *   (carbs×4 + protein×4 + fat×9). The AI does not emit it.
 */
const SuggestionSchema = SuggestionRawSchema.transform((s) => {
  const out: Record<string, unknown> = { ...s };

  // Visual-pair both-or-neither.
  if ((out.visual_unit_label === null) !== (out.visual_units_per_serving === null)) {
    console.warn(
      `validateSuggestion: visual pair incomplete (label=${JSON.stringify(out.visual_unit_label)}, units=${out.visual_units_per_serving}) — clearing both`,
    );
    out.visual_unit_label = null;
    out.visual_units_per_serving = null;
  }

  // display_by_weight requires net_weight_g.
  if (out.display_by_weight && !(typeof out.net_weight_g === 'number' && out.net_weight_g > 0)) {
    console.warn('validateSuggestion: downgrading display_by_weight true→false (net_weight_g missing)');
    out.display_by_weight = false;
  }

  // display_by_weight wins over visual pair.
  if (out.display_by_weight && out.visual_unit_label !== null) {
    console.warn('validateSuggestion: display_by_weight=true AND visual_unit_label set — clearing visual pair');
    out.visual_unit_label = null;
    out.visual_units_per_serving = null;
  }

  // default_recipe_unit gram requires net_weight_g.
  if (out.default_recipe_unit === 'gram' && !(typeof out.net_weight_g === 'number' && out.net_weight_g > 0)) {
    console.warn('validateSuggestion: downgrading default_recipe_unit gram→serving (net_weight_g missing)');
    out.default_recipe_unit = 'serving';
  }

  // Atwater 4-4-9: calories are deterministic from macros. Compute server-
  // side so the AI never has to (and never can) miscount them.
  const carbs = (out.carbs_per_serving as number) ?? 0;
  const protein = (out.protein_per_serving as number) ?? 0;
  const fat = (out.fat_per_serving as number) ?? 0;
  out.calories_per_serving = Math.round((carbs * 4 + protein * 4 + fat * 9) * 10) / 10;

  return out;
});

/** Suggestion type derived from the Zod schema — single source of truth. */
export type Suggestion = z.infer<typeof SuggestionSchema>;

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
 * Validate + coerce a raw parsed suggestion via the Zod schema.
 *
 * Returns
 *   { ok: false, missing: [...] }  when required fields are missing/null
 *   { ok: true, suggestion }       with coerced + cross-field-normalized
 *                                  + 4-4-9-corrected output
 *
 * Required-field check runs before Zod parse so the caller's "422 missing
 * required fields" path keeps its existing contract.
 */
export function validateSuggestion(raw: Record<string, unknown> | null): SuggestionValidation {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, missing: ['*'] };
  }

  // Required-field gate: if name/macros are missing entirely, the AI
  // normalization "didn't really succeed" and the caller falls through to
  // the OFF-only path. calories_per_serving is NOT required — it's
  // computed server-side from the macros via Atwater.
  const required = ['name', 'protein_per_serving', 'carbs_per_serving', 'fat_per_serving'];
  const missing = required.filter((k) => raw[k] == null);
  if (missing.length > 0) return { ok: false, missing };

  const result = SuggestionSchema.safeParse(raw);
  if (!result.success) {
    // A Zod failure here means the field shapes were malformed beyond what
    // the coercion transforms can rescue (e.g. name is not a string, or a
    // numeric field is an object). Surface the issue paths so the caller
    // can log a useful diagnostic.
    console.error('validateSuggestion: Zod parse failed', result.error.issues);
    const issuePaths = Array.from(new Set(result.error.issues.map((i) => i.path.join('.') || '*')));
    return { ok: false, missing: issuePaths };
  }
  return { ok: true, suggestion: result.data };
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
