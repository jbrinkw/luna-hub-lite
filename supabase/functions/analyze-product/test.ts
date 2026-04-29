// Deno unit tests for the analyze-product helpers.
//
// Run with:
//   deno test supabase/functions/analyze-product/test.ts
//
// These tests exercise the prompt builder, response normalizer, 4-4-9
// calorie validator, and suggestion validator in isolation — no Supabase,
// no OpenFoodFacts, no Anthropic calls. Integration coverage for the full
// HTTP handler lives at:
//   apps/web/src/__tests__/integration/edge-functions/analyze-product.test.ts
// (that suite hits real local Supabase + the real fn over HTTP).

import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { SLIM_NUTRIMENT_KEYS, buildSystemPrompt, buildUserPrompt, proposedName, slimNutriments } from './_prompt.ts';
import { calorieDrift, isCalorieDriftImplausible, parseAIResponse, validateSuggestion } from './_normalize.ts';

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

/** Realistic Nutella-shaped OFF product. Mirrors what the real OFF API
 * returns so the prompt tests assert against production shape. */
const OFF_NUTELLA = {
  product_name: 'Nutella',
  generic_name: 'Hazelnut cocoa spread',
  brands: 'Ferrero',
  categories: 'Spreads, Chocolate spreads, Nut spreads, Breakfasts',
  serving_size: '15 g',
  serving_quantity: 15,
  product_quantity: 400,
  nutriments: {
    'energy-kcal_100g': 539,
    'energy-kcal_serving': 80.8,
    carbohydrates_100g: 57.5,
    carbohydrates_serving: 8.62,
    proteins_100g: 6.3,
    proteins_serving: 0.95,
    fat_100g: 30.9,
    fat_serving: 4.64,
    // Fields that SHOULD be dropped by slimNutriments
    sugars_100g: 56.3,
    sodium_100g: 0.04,
    'vitamin-e_100g': 4.3,
    iron_100g: 0.003,
    salt_100g: 0.107,
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Prompt builder tests
// ─────────────────────────────────────────────────────────────────────────

Deno.test('proposedName combines brand + product_name when both present', () => {
  assertEquals(proposedName({ brands: 'Ferrero', product_name: 'Nutella' }), 'Ferrero Nutella');
});

Deno.test('proposedName falls back to product_name when brand missing', () => {
  assertEquals(proposedName({ brands: '', product_name: 'Plain Rice' }), 'Plain Rice');
});

Deno.test('proposedName falls back to generic_name when product_name missing', () => {
  assertEquals(proposedName({ brands: '', generic_name: 'Hazelnut Spread' }), 'Hazelnut Spread');
});

Deno.test('proposedName returns "Unknown Product" when everything blank', () => {
  assertEquals(proposedName({}), 'Unknown Product');
  assertEquals(proposedName({ brands: '', product_name: '', generic_name: '' }), 'Unknown Product');
});

Deno.test('slimNutriments keeps only the 4-macro + energy keys', () => {
  const slim = slimNutriments(OFF_NUTELLA.nutriments);
  // Every key in SLIM_NUTRIMENT_KEYS that existed in source should survive
  for (const key of SLIM_NUTRIMENT_KEYS) {
    const src = (OFF_NUTELLA.nutriments as Record<string, unknown>)[key];
    if (src != null) assertEquals(slim[key], src, `expected ${key} preserved`);
  }
  // Junk keys should be dropped
  assertEquals(slim['sugars_100g'], undefined);
  assertEquals(slim['sodium_100g'], undefined);
  assertEquals(slim['vitamin-e_100g'], undefined);
  assertEquals(slim['iron_100g'], undefined);
  assertEquals(slim['salt_100g'], undefined);
});

Deno.test('slimNutriments handles null / undefined nutriments', () => {
  assertEquals(slimNutriments(null), {});
  assertEquals(slimNutriments(undefined), {});
  assertEquals(slimNutriments({}), {});
});

Deno.test('buildSystemPrompt includes proposed name and 4-4-9 rule', () => {
  const prompt = buildSystemPrompt(OFF_NUTELLA);
  assertStringIncludes(prompt, 'Ferrero Nutella');
  assertStringIncludes(prompt, '4-4-9 validation');
  assertStringIncludes(prompt, 'carbs×4 + protein×4 + fat×9');
  // Contract fields the AI must return
  assertStringIncludes(prompt, 'calories_per_serving');
  assertStringIncludes(prompt, 'servings_per_container');
  assertStringIncludes(prompt, 'default_shelf_life_days');
  // Shelf-life range must be tamped to [1, 3650]
  assertStringIncludes(prompt, 'integer 1-3650');
});

Deno.test('buildUserPrompt ships OFF product fields + slim nutriments only', () => {
  const prompt = buildUserPrompt(OFF_NUTELLA);
  // Human-readable lead-in
  assertStringIncludes(prompt, 'Normalize this Open Food Facts product:');
  // Parse the JSON payload and assert shape
  const jsonStart = prompt.indexOf('{');
  assert(jsonStart > -1, 'prompt should contain a JSON payload');
  const payload = JSON.parse(prompt.slice(jsonStart));
  assertEquals(payload.product_name, 'Nutella');
  assertEquals(payload.brands, 'Ferrero');
  assertEquals(payload.serving_size, '15 g');
  assertEquals(payload.product_quantity, 400);
  // Nutriments must be slimmed
  assertEquals(payload.nutriments['energy-kcal_100g'], 539);
  assertEquals(payload.nutriments['proteins_serving'], 0.95);
  assertEquals(payload.nutriments['sugars_100g'], undefined);
  assertEquals(payload.nutriments['vitamin-e_100g'], undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// parseAIResponse tests — the key failure-mode guard.
// ─────────────────────────────────────────────────────────────────────────

Deno.test('parseAIResponse: clean JSON round-trips', () => {
  const clean = JSON.stringify({
    name: 'Test',
    calories_per_serving: 100,
    protein_per_serving: 10,
    carbs_per_serving: 15,
    fat_per_serving: 3,
    servings_per_container: 2,
    default_shelf_life_days: 30,
  });
  const parsed = parseAIResponse(clean);
  assert(parsed, 'clean JSON should parse');
  assertEquals(parsed.name, 'Test');
  assertEquals(parsed.calories_per_serving, 100);
});

Deno.test('parseAIResponse: markdown-fenced JSON is recovered', () => {
  const fenced = '```json\n{"name":"Wrapped","calories_per_serving":50}\n```';
  const parsed = parseAIResponse(fenced);
  assert(parsed, 'fenced JSON should be extracted');
  assertEquals(parsed.name, 'Wrapped');
  assertEquals(parsed.calories_per_serving, 50);
});

Deno.test('parseAIResponse: JSON with prose prefix is recovered', () => {
  const mixed = 'Here is the normalized product:\n{"name":"Rice","calories_per_serving":200}';
  const parsed = parseAIResponse(mixed);
  assert(parsed, 'JSON inside prose should be recovered');
  assertEquals(parsed.name, 'Rice');
});

Deno.test('parseAIResponse: JSON with prose suffix is recovered', () => {
  const mixed = '{"name":"Pasta","calories_per_serving":350}\n\nAs you can see, this is pasta.';
  const parsed = parseAIResponse(mixed);
  assert(parsed, 'JSON with trailing prose should be recovered');
  assertEquals(parsed.name, 'Pasta');
});

Deno.test('parseAIResponse: truncated JSON returns null (degraded fallback)', () => {
  // max_tokens hit mid-object — no closing brace
  const truncated = '{"name":"Truncated","calories_per_serving":100,"protein_per_serving":';
  const parsed = parseAIResponse(truncated);
  assertEquals(parsed, null, 'truncated JSON should return null → triggers ai_degraded');
});

Deno.test('parseAIResponse: empty / whitespace returns null', () => {
  assertEquals(parseAIResponse(''), null);
  assertEquals(parseAIResponse('   \n\n\t'), null);
});

Deno.test('parseAIResponse: non-object JSON (array/primitive) returns null', () => {
  assertEquals(parseAIResponse('[1,2,3]'), null);
  assertEquals(parseAIResponse('"just a string"'), null);
  assertEquals(parseAIResponse('42'), null);
  assertEquals(parseAIResponse('null'), null);
});

Deno.test('parseAIResponse: nested braces in strings do not confuse the parser', () => {
  const tricky = 'Prefix {"name":"Weird {nested} thing","calories_per_serving":120}';
  const parsed = parseAIResponse(tricky);
  assert(parsed, 'escaped braces in strings should still parse');
  assertEquals(parsed.name, 'Weird {nested} thing');
});

// ─────────────────────────────────────────────────────────────────────────
// 4-4-9 calorie validator tests
// ─────────────────────────────────────────────────────────────────────────

Deno.test('calorieDrift: perfectly accurate macros → ~0% drift', () => {
  // 10g carb * 4 + 5g protein * 4 + 3g fat * 9 = 87 kcal
  const drift = calorieDrift({ protein: 5, carbs: 10, fat: 3, calories: 87 });
  assert(drift !== null);
  assert(Math.abs(drift) < 0.5, `expected ~0% drift, got ${drift}`);
});

Deno.test('calorieDrift: 5% over is not implausible (< 10% threshold)', () => {
  // Derived = 87. 91.35 = 5% over.
  const result = isCalorieDriftImplausible({ protein: 5, carbs: 10, fat: 3, calories: 91.35 });
  assertEquals(result, false);
});

Deno.test('calorieDrift: 50% over IS implausible', () => {
  // Derived = 87. 130 ≈ 49% over.
  const result = isCalorieDriftImplausible({ protein: 5, carbs: 10, fat: 3, calories: 130 });
  assertEquals(result, true);
});

Deno.test('calorieDrift: 50% under IS implausible', () => {
  // Derived = 87. 43 = 50% under.
  const result = isCalorieDriftImplausible({ protein: 5, carbs: 10, fat: 3, calories: 43 });
  assertEquals(result, true);
});

Deno.test('calorieDrift: Nutella serving (80.8 kcal vs 4-4-9) is plausible', () => {
  // Real Nutella: 8.62 carbs + 0.95 protein + 4.64 fat per 15g serving.
  // Derived = 8.62*4 + 0.95*4 + 4.64*9 = 34.48 + 3.8 + 41.76 = 80.04 kcal.
  // Declared = 80.8 → ~1% drift.
  const drift = calorieDrift({ protein: 0.95, carbs: 8.62, fat: 4.64, calories: 80.8 });
  assert(drift !== null);
  assert(Math.abs(drift) < 5, `real Nutella should be plausible, got ${drift}%`);
});

Deno.test('calorieDrift: all-zero macros returns null (no yardstick)', () => {
  assertEquals(calorieDrift({ protein: 0, carbs: 0, fat: 0, calories: 100 }), null);
});

Deno.test('calorieDrift: non-finite calories returns null', () => {
  assertEquals(calorieDrift({ protein: 5, carbs: 10, fat: 3, calories: NaN }), null);
  assertEquals(calorieDrift({ protein: 5, carbs: 10, fat: 3, calories: Infinity }), null);
});

// ─────────────────────────────────────────────────────────────────────────
// validateSuggestion tests — coercion, clamping, missing-field guards
// ─────────────────────────────────────────────────────────────────────────

Deno.test('validateSuggestion: accepts a complete suggestion', () => {
  const raw = {
    name: 'Chicken Breast',
    calories_per_serving: 165,
    protein_per_serving: 31,
    carbs_per_serving: 0,
    fat_per_serving: 3.6,
    servings_per_container: 4,
    default_shelf_life_days: 7,
  };
  const result = validateSuggestion(raw);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.suggestion.name, 'Chicken Breast');
    assertEquals(result.suggestion.calories_per_serving, 165);
    assertEquals(result.suggestion.default_shelf_life_days, 7);
  }
});

Deno.test('validateSuggestion: reports every missing required field', () => {
  const result = validateSuggestion({ name: 'Incomplete' });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.missing.sort(), [
      'calories_per_serving',
      'carbs_per_serving',
      'fat_per_serving',
      'protein_per_serving',
    ]);
  }
});

Deno.test('validateSuggestion: null raw → not-ok with * missing marker', () => {
  const result = validateSuggestion(null);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.missing, ['*']);
});

Deno.test('validateSuggestion: coerces string numerics to numbers', () => {
  const result = validateSuggestion({
    name: 'Stringy',
    calories_per_serving: '200' as unknown as number,
    protein_per_serving: '15' as unknown as number,
    carbs_per_serving: '30' as unknown as number,
    fat_per_serving: '5' as unknown as number,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(typeof result.suggestion.calories_per_serving, 'number');
    assertEquals(result.suggestion.calories_per_serving, 200);
    // servings_per_container defaults to 1 when missing
    assertEquals(result.suggestion.servings_per_container, 1);
  }
});

Deno.test('validateSuggestion: coerces non-numeric to 0', () => {
  const result = validateSuggestion({
    name: 'Garbled',
    calories_per_serving: 'not-a-number' as unknown as number,
    protein_per_serving: 0,
    carbs_per_serving: 0,
    fat_per_serving: 0,
  });
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.suggestion.calories_per_serving, 0);
});

Deno.test('validateSuggestion: servings_per_container < 1 is clamped to 1', () => {
  const result = validateSuggestion({
    name: 'Tiny',
    calories_per_serving: 100,
    protein_per_serving: 5,
    carbs_per_serving: 10,
    fat_per_serving: 3,
    servings_per_container: 0.5,
  });
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.suggestion.servings_per_container, 1);
});

Deno.test('validateSuggestion: default_shelf_life_days out-of-range → null', () => {
  for (const bad of [0, -5, 3651, 10_000]) {
    const result = validateSuggestion({
      name: 'Whatever',
      calories_per_serving: 100,
      protein_per_serving: 5,
      carbs_per_serving: 10,
      fat_per_serving: 3,
      default_shelf_life_days: bad,
    });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.suggestion.default_shelf_life_days, null, `expected ${bad} clamped to null`);
    }
  }
});

Deno.test('validateSuggestion: default_shelf_life_days rounds floats', () => {
  const result = validateSuggestion({
    name: 'Round Me',
    calories_per_serving: 100,
    protein_per_serving: 5,
    carbs_per_serving: 10,
    fat_per_serving: 3,
    default_shelf_life_days: 30.7,
  });
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.suggestion.default_shelf_life_days, 31);
});

// ─────────────────────────────────────────────────────────────────────────
// Anthropic SDK call shape — timeout must be in the RequestOptions arg,
// NOT in the message body. The Node SDK signature is:
//   messages.create(body, options?)  where options.timeout is honored.
// Putting timeout inside the body is silently ignored by the SDK, falling
// back to the default 10-min timeout. This is a tiny static-text guard
// against the regression — turns red the moment a future edit moves
// `timeout:` back into the body.
// ─────────────────────────────────────────────────────────────────────────

Deno.test('normalizeWithAI calls anthropic.messages.create with timeout in RequestOptions, not body', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));

  // Find the (single) anthropic.messages.create(...) invocation.
  const callIdx = src.indexOf('anthropic.messages.create(');
  assert(callIdx > -1, 'expected anthropic.messages.create call in index.ts');

  // Walk balanced parens from the open to find the full call. We need
  // both the body literal and the options literal — a quick char-by-
  // char paren depth scan handles nested braces in the body.
  const start = src.indexOf('(', callIdx);
  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert(end > start, 'unbalanced parens around anthropic call');

  const callBody = src.slice(start + 1, end);

  // Split top-level args by counting depth — body is arg[0], options
  // is arg[1]. We only need to find the comma at depth==0.
  let argDepth = 0;
  const splitPoints: number[] = [0];
  for (let i = 0; i < callBody.length; i++) {
    const c = callBody[i];
    if (c === '(' || c === '{' || c === '[') argDepth++;
    else if (c === ')' || c === '}' || c === ']') argDepth--;
    else if (c === ',' && argDepth === 0) splitPoints.push(i + 1);
  }
  splitPoints.push(callBody.length + 1);

  const args: string[] = [];
  for (let i = 0; i < splitPoints.length - 1; i++) {
    const segment = callBody.slice(splitPoints[i], splitPoints[i + 1] - 1).trim();
    if (segment.length > 0) args.push(segment);
  }

  // Must be a 2-arg call (body, options). Trailing commas / whitespace
  // around them are tolerated above.
  assertEquals(args.length, 2, `expected anthropic.messages.create(body, options) — got ${args.length} args`);

  const [body, options] = args;
  // Body must NOT contain a `timeout:` key — that's the bug we fixed.
  assert(
    !/\btimeout\s*:/.test(body),
    'timeout must NOT be in the messages.create body — the SDK silently ignores it there',
  );
  // Options must contain `timeout:` so the SDK honors it.
  assert(/\btimeout\s*:/.test(options), 'timeout must be in the RequestOptions arg (second arg of messages.create)');
  // Spot-check the value is the documented 25s — guards against silent
  // edits that swap it for something useless.
  assert(/timeout\s*:\s*25[_]?000/.test(options), `timeout option should be 25_000ms (25s) — got: ${options}`);
});
