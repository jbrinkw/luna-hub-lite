// Prompt-builder helpers for analyze-product.
//
// Extracted from index.ts so they're unit-testable in Deno isolation
// (supabase/functions/analyze-product/test.ts) without hitting Supabase,
// OpenFoodFacts, or Anthropic. index.ts imports + uses the exports below
// unchanged — the runtime HTTP entry point still lives in index.ts.

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
 * Build the Claude Haiku system prompt that tells the model how to return
 * normalized product data. Pure function of the OFF product — no I/O.
 */
export function buildSystemPrompt(offProduct: {
  brands?: unknown;
  product_name?: unknown;
  generic_name?: unknown;
}): string {
  const proposed = proposedName(offProduct);
  return [
    'You normalize Open Food Facts product data into a structured JSON format.',
    'Return STRICT JSON only, no markdown, no explanation:',
    '{',
    '  "name": "<final product name>",',
    '  "servings_per_container": <number, default 1>,',
    '  "calories_per_serving": <number>,',
    '  "carbs_per_serving": <number>,',
    '  "protein_per_serving": <number>,',
    '  "fat_per_serving": <number>,',
    '  "description": "<brief 1-line description>",',
    '  "default_shelf_life_days": <integer 1-3650, or null>',
    '}',
    '',
    'Rules:',
    `- Base name: "${proposed}". Fix formatting (spacing, casing, punctuation) only.`,
    '- Nutrition must be PER SERVING. If OFF data only has per-100g, calculate using serving_size.',
    '- If serving info missing, treat 100g as one serving.',
    '- Apply 4-4-9 validation: carbs×4 + protein×4 + fat×9 should ≈ calories. If >10% off, adjust calories to match.',
    '- servings_per_container: product_quantity / serving_size, or 1 if unknown.',
    '- All numeric values rounded to 1 decimal.',
    '- default_shelf_life_days: typical unopened pantry/fridge life from purchase, one integer.',
    '  Rough guide (use judgment based on categories):',
    '    fresh produce, bakery bread, deli meat, soft cheese: 5–10',
    '    packaged bread/tortillas/wraps, yogurt, cold cuts: 10–21',
    '    eggs, hard cheese, butter: 30–60',
    '    frozen foods: 180',
    '    condiments, jarred sauces (unopened): 365',
    '    canned goods, dried pasta/rice, spices, shelf-stable snacks: null',
    '  Use null when genuinely uncertain OR shelf-stable. Never guess wildly.',
  ].join('\n');
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
