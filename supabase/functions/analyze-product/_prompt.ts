// Prompt-builder helpers for analyze-product.
//
// Extracted from index.ts so they're unit-testable in Deno isolation
// (supabase/functions/analyze-product/test.ts) without hitting Supabase,
// OpenFoodFacts, or Anthropic. index.ts imports + uses the exports below
// unchanged — the runtime HTTP entry point still lives in index.ts.
//
// Structure:
//   - STATIC_RULES: the rule body, identical for every call.
//   - buildProductPreamble: per-product name + placeholder candidates.
//   - buildSystemPrompt: concatenation (the runtime entry point).
//
// Earlier iterations split the system prompt into multiple blocks with
// `cache_control: { type: 'ephemeral' }` to take advantage of Anthropic's
// 5-min prompt cache. Empirical bisection (scripts/analyze_sonnet_delta.mjs)
// showed Sonnet 4.6's actual cache-write floor is ~2.5-3k tokens of
// cacheable prefix — far above our ~1.1k STATIC_RULES + tool schema. The
// cache_control markers were stillborn no-ops, so we dropped the multi-block
// shape and ship a single concatenated string. If we ever bulk the prompt
// past 3k tokens (e.g. a full taxonomy table), reintroducing the multi-
// block + cache_control plumbing is straightforward.

/** A placeholder product candidate for AI-assisted matching. */
export interface PlaceholderCandidate {
  product_id: string;
  name: string;
  description?: string | null;
}

/** The only 4-macro + energy keys we keep from OFF's massive nutriments
 * object. The raw OFF nutriments object for a typical product is 10–20 KB
 * (dozens of vitamins/minerals + variant suffixes) which makes Claude
 * spend tokens reading irrelevant data and often hit the timeout.
 *
 * Exported so the test can assert the slim set shrinks input correctly. */
export const SLIM_NUTRIMENT_KEYS = [
  'energy-kcal',
  'energy-kcal_serving',
  'energy-kcal_100g',
  'carbohydrates',
  'carbohydrates_serving',
  'carbohydrates_100g',
  'proteins',
  'proteins_serving',
  'proteins_100g',
  'fat',
  'fat_serving',
  'fat_100g',
] as const;

/** Return a new object with only the 4-macro + energy keys present in `n`. */
export function slimNutriments(n: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const src = n ?? {};
  const slim: Record<string, unknown> = {};
  for (const key of SLIM_NUTRIMENT_KEYS) {
    if (src[key] != null) slim[key] = src[key];
  }
  return slim;
}

/** Combine brand + product name in the same way the AI prompt does.
 * Exported for the test + so the real handler uses the same derivation. */
export function proposedName(offProduct: { brands?: unknown; product_name?: unknown; generic_name?: unknown }): string {
  const brand = (offProduct.brands ?? '').toString().trim();
  const food = (offProduct.product_name ?? offProduct.generic_name ?? '').toString().trim();
  if (brand && food) return `${brand} ${food}`;
  return food || brand || 'Unknown Product';
}

/**
 * Static rules block. Identical for every call — the only thing that
 * varies between products is the proposed-name and placeholder-candidates
 * preamble, which lives in `buildProductPreamble` instead.
 *
 * Design notes (avoid drift between this and the validator):
 *   - calories_per_serving is INTENTIONALLY absent from the tool schema and
 *     this prompt. SuggestionSchema computes it server-side from
 *     carbs×4 + protein×4 + fat×9 (Atwater).
 *   - HOW TO REASON's 4-step + SELF-CHECK was added to fix two regressions
 *     observed in earlier prompt iterations: pulled-chicken
 *     `shelf_life_days=null` (now caught by the "null IFF" rule) and the
 *     cheddar-cascade where one bad classification flipped 4 fields
 *     (now caught by the REQUIRES rules).
 *   - default_recipe_unit was previously ambiguous for non-distinct
 *     scoopables (cream cheese tbsp). Replaced by an explicit decision
 *     tree under CLASSIFICATION that exhausts the cases in priority order.
 *   - Coarse category anchors (frozen meat / hard cheese / yogurt / etc.)
 *     are intentionally a small list of GENERAL categories rather than
 *     specific products, to avoid overfitting. The model classifies by
 *     category first, then reads defaults.
 */
export const STATIC_RULES = [
  'You normalize Open Food Facts product data. Call the `normalize_product` tool exactly once with the structured fields.',
  '',
  'NUTRITION (per-serving) — return MACROS only; calories are computed server-side via 4-4-9:',
  '- Use `*_serving` values verbatim when present.',
  '- Fall back to `*_100g × (serving_quantity / 100)` if the matching `*_serving` key is missing.',
  '- If serving info is missing entirely, treat 100g as one serving.',
  '- Do NOT emit `calories_per_serving` — it is not in your schema.',
  '- Round numeric values to 1 decimal.',
  '- servings_per_container: product_quantity / serving_size, or 1 if unknown.',
  '',
  'HOW TO REASON — answer these 4 questions in order before emitting:',
  '1. STORAGE STATE at purchase: frozen / refrigerated / shelf-stable / shelf-stable >2y.',
  '   Only the LAST permits null on shelf_life_days AND expiry_days.',
  '2. PROCESSING LEVEL: raw fresh → short expiry; cooked or cured → medium;',
  '   highly processed (bars, packaged sweets, dry mixes) → long.',
  '3. UNIT GRANULARITY: countable pieces users name individually (eggs, slices,',
  '   bars, patties, packets) → is_distinct_unit_item=true. Bulk solids weighed',
  '   → display_by_weight=true. Liquids → visual cup/tbsp + recipe_unit "serving".',
  '4. SELF-CHECK (mandatory before emit). If any fail, redo step 1:',
  '   - shelf_life_days >= expiry_days (an unopened item lasts at least as long as opened).',
  '   - shelf_life_days null IFF expiry_days null (both or neither).',
  '   - display_by_weight=true REQUIRES net_weight_g > 0 AND visual_unit_label=null.',
  '   - default_recipe_unit="gram" REQUIRES net_weight_g > 0.',
  '   - default_recipe_unit matches the priority tree under CLASSIFICATION.',
  '   - visual_unit_label set IFF visual_units_per_serving set.',
  '',
  'CLASSIFICATION:',
  '- is_distinct_unit_item = true for discrete countable pieces users naturally count: eggs, buns,',
  '  BREAD SLICES, tortillas, protein bars, packets, individually-wrapped items, patties.',
  '  False for bulk/liquid: yogurt, milk, sugar, flour, oil, ground meat, spreads.',
  '- default_recipe_unit decision tree (apply in order, take FIRST match):',
  '    1. is_distinct_unit_item=true                  → "serving"',
  '    2. display_by_weight=true                      → "gram"',
  '    3. visual_unit_label = "cup"                   → "serving"  (volumetric liquid)',
  '    4. net_weight_g > 0                            → "gram"     (solids, spreads, condiments by mass)',
  '    5. otherwise                                   → "serving"',
  '  visual_unit_label is independent of recipe_unit — it is a UI display unit only.',
  '- net_weight_g: total package mass in grams from OFF product_quantity. Null',
  '  only when OFF lacks it AND it cannot be derived from serving × servings.',
  '',
  'SHELF LIFE & EXPIRY — DISTINCT fields, not duplicates:',
  '- default_shelf_life_days = how long UNOPENED, from purchase, stored in the',
  "  manufacturer's intended condition (frozen in freezer, refrigerated in fridge,",
  '  shelf-stable in pantry). Used to auto-populate stock_lots.expires_on. Range 1-3650.',
  '- default_expiry_days = once the user OPENS or STOCKS the item, typical',
  '  "use within N days." Range 1-730.',
  '- ALWAYS estimate both. Null reserved for items shelf-stable >2 years',
  '  (canned goods, dried rice/pasta, spices, vinegar, honey).',
  '- Coarse category anchors (illustrative, NOT a closed list — pick the closest',
  '  match, lean toward shorter expiry when uncertain). Format: shelf_life / expiry.',
  '    Frozen meat:                  180 / 4 (thawed)',
  '    Frozen vegetables / meals:    365 / 5',
  '    Refrigerated meat raw:          3 / 2',
  '    Refrigerated meat cooked:       7 / 4',
  '    Hard cheese:                  180 / 30',
  '    Soft cheese:                   30 / 7',
  '    Yogurt / refrigerated dairy:   21 / 7',
  '    Plant milks:                   60 / 7',
  '    Eggs:                          30 / 30',
  '    Bread:                         10 / 7',
  '    Fresh produce:                  7 / 4',
  '    Oils + condiments:            365 / 180',
  '    Refrigerated dressings:        90 / 30',
  '    Packaged snacks (bars, chips): 180 / 90',
  '',
  'DISPLAY (visual_unit + display_by_weight) — at most one mode per product:',
  '- visual_unit_label / visual_units_per_serving: both set together or both null.',
  '    Discrete pieces: label = SINGULAR noun ("egg", "slice", "patty"); ratio = 1.',
  '    Liquids: label = "cup"; ratio = round(serving_ml / 240, 1).',
  '    Condiments / scoopable: label = "tbsp" or "scoop"; ratio = 1.',
  '    Sliced solids by weight: label = "oz" or "slice"; ratio = 1.',
  '    Bulk solids (flour, oats, ground meat): BOTH NULL — use display_by_weight.',
  '- display_by_weight: true ONLY for bulk solids weighed by the user.',
  '  See SELF-CHECK for the REQUIRES rules.',
].join('\n');

/**
 * Per-product preamble — the part of the system prompt that varies per
 * call. NOT cached. Contains the proposed name + placeholder candidates.
 */
export function buildProductPreamble(
  offProduct: { brands?: unknown; product_name?: unknown; generic_name?: unknown },
  placeholderCandidates: PlaceholderCandidate[] = [],
): string {
  const proposed = proposedName(offProduct);
  const lines = [`Base name: "${proposed}". Fix formatting (spacing, casing, punctuation) only.`];

  if (placeholderCandidates.length > 0) {
    lines.push(
      '',
      'EXISTING PLACEHOLDER PRODUCTS (if the scanned product matches one, return its product_id in matched_placeholder_id):',
    );
    placeholderCandidates.forEach((c, i) => {
      const desc = c.description ? ` — ${c.description}` : '';
      lines.push(`  ${i + 1}. id=${c.product_id} name="${c.name}"${desc}`);
    });
    lines.push(
      '',
      'Match strictly — only when you\'re confident the scanned product IS the same item the placeholder represents. "Greek Yogurt" matches "Chobani Greek Yogurt" but NOT "Greek Yogurt Granola". Otherwise return matched_placeholder_id: null.',
    );
  } else {
    lines.push('matched_placeholder_id: always null (no placeholder candidates provided).');
  }
  return lines.join('\n');
}

/**
 * Concatenated system prompt — the static rules + per-product preamble
 * as a single string. The runtime SDK call uses this directly.
 */
export function buildSystemPrompt(
  offProduct: { brands?: unknown; product_name?: unknown; generic_name?: unknown },
  placeholderCandidates: PlaceholderCandidate[] = [],
): string {
  return STATIC_RULES + '\n\n' + buildProductPreamble(offProduct, placeholderCandidates);
}

/**
 * Build the user message that ships the slim OFF fields to Claude. Keeps
 * the exact field set + order the old inline code used (only the 4 macros
 * + energy nutriments, no vitamins/minerals).
 */
export function buildUserPrompt(offProduct: {
  product_name?: unknown;
  generic_name?: unknown;
  brands?: unknown;
  categories?: unknown;
  serving_size?: unknown;
  serving_quantity?: unknown;
  product_quantity?: unknown;
  nutriments?: Record<string, unknown> | null;
}): string {
  return (
    'Normalize this Open Food Facts product:\n' +
    JSON.stringify({
      product_name: offProduct.product_name,
      generic_name: offProduct.generic_name,
      brands: offProduct.brands,
      categories: offProduct.categories,
      serving_size: offProduct.serving_size,
      serving_quantity: offProduct.serving_quantity,
      product_quantity: offProduct.product_quantity,
      nutriments: slimNutriments(offProduct.nutriments),
    })
  );
}
