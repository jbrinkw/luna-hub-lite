/**
 * H1 — Pi USB scanner placeholder promotion
 *
 * Cross-component contract test.
 *
 * The web ScannerPage flow loads the user's barcode-less placeholder products
 * and forwards them as `placeholder_candidates` to /functions/v1/analyze-product
 * so Haiku can return a `matched_placeholder_id`. ScannerPage then UPDATEs the
 * placeholder row in place — preserving the placeholder's UUID across
 * recipe_ingredients, meal_plan, food_logs FK references.
 *
 * The Pi USB scanner pipeline (shelf-ingest /barcode-scan → analyze-product
 * over service-role) does NOT load placeholder candidates. It invokes
 * analyze-product with body `{barcode, user_id}` — see
 * supabase/functions/shelf-ingest/index.ts:1305-1307.
 *
 * Consequence: when a user has a placeholder product (e.g., "Greek Yogurt"
 * with no barcode) and then scans the matching real product via the Pi USB
 * scanner, analyze-product's service-role auto-create branch INSERTs a
 * brand-new product row instead of upgrading the placeholder. The user ends
 * up with TWO rows for the same item, recipe_ingredients still pointing at
 * the abandoned placeholder, and the new lot keyed to the duplicate product.
 *
 * This test exercises the contract directly:
 *   1. Seed a placeholder product whose name matches the canned OFF response.
 *   2. Call analyze-product the way shelf-ingest does — service-role bearer +
 *      body `{barcode, user_id}` — including the canned-OFF header so the
 *      pipeline reaches the auto-create branch deterministically without
 *      hitting the live OFF API.
 *   3. Assert: ONE product row remains for that user (the placeholder was
 *      promoted, NOT a new row inserted alongside).
 *
 * If the assertion fails with two product rows, that's the H1 bug.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { adminClient, SUPABASE_URL, getFunctionRuntimeServiceRoleKey } from '../../setup.integration';
import { createTestUser, cleanupUser } from '../../test-helpers';

const ANALYZE_URL = `${SUPABASE_URL}/functions/v1/analyze-product`;

const userIds: string[] = [];

afterEach(async () => {
  for (const id of userIds.splice(0)) {
    await (adminClient as any).schema('chefbyte').from('stock_lots').delete().eq('user_id', id);
    await (adminClient as any).schema('chefbyte').from('recipe_ingredients').delete().eq('user_id', id);
    await (adminClient as any).schema('chefbyte').from('recipes').delete().eq('user_id', id);
    await (adminClient as any).schema('chefbyte').from('products').delete().eq('user_id', id);
    await (adminClient as any).schema('chefbyte').from('user_config').delete().eq('user_id', id);
    await cleanupUser(id);
  }
});

describe('Pi USB scanner placeholder promotion (cross-component contract)', () => {
  it('Pi-style service-role analyze-product invocation must promote an existing placeholder, not duplicate', async () => {
    const { userId, client } = await createTestUser('pi-ph-promo');
    userIds.push(userId);

    const { error: actErr } = await (client as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
    expect(actErr).toBeNull();

    // Seed a recipe that uses the placeholder product, so we can prove the
    // FK damage when the duplicate is created. recipe_ingredients points
    // at placeholder.product_id; if the Pi flow inserts a duplicate
    // instead of upgrading the placeholder, the recipe is left referencing
    // an orphan placeholder while the user thinks the placeholder was
    // "scanned in".

    // ─── 1. Seed a placeholder product matching the canned OFF blob. ───
    // The canned OFF response (CANNED_OFF_PRODUCT in analyze-product
    // index.ts:85) returns product_name "Test Canned Nutella" / brand
    // "Nutella". A user adding a Nutella placeholder ahead of time is a
    // realistic flow: they note they have Nutella on the shelf but don't
    // know the barcode yet. When they later scan it via the Pi USB
    // scanner, the cloud pipeline should recognize the match and promote
    // the placeholder rather than create a duplicate.
    const { data: placeholder, error: phErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Nutella',
        description: 'Hazelnut spread (placeholder until I scan the jar)',
        is_placeholder: true,
        servings_per_container: 26,
        calories_per_serving: 80,
        protein_per_serving: 1,
        carbs_per_serving: 9,
        fat_per_serving: 5,
      })
      .select('product_id, name, is_placeholder')
      .single();
    expect(phErr).toBeNull();
    const placeholderId: string = placeholder.product_id;
    expect(placeholder.is_placeholder).toBe(true);

    // Sanity: exactly one row.
    {
      const { data: rows } = await (adminClient as any)
        .schema('chefbyte')
        .from('products')
        .select('product_id')
        .eq('user_id', userId);
      expect(rows ?? []).toHaveLength(1);
    }

    // Seed a recipe + recipe_ingredient pointing at the placeholder.
    // After the Pi scan, the recipe must still resolve to a non-placeholder
    // product. If a duplicate was inserted, the recipe is now an orphan
    // pointer to the abandoned placeholder.
    const { data: recipe } = await (adminClient as any)
      .schema('chefbyte')
      .from('recipes')
      .insert({ user_id: userId, name: 'Nutella Toast', base_servings: 1 })
      .select('recipe_id')
      .single();
    const recipeId: string = recipe.recipe_id;
    await (adminClient as any).schema('chefbyte').from('recipe_ingredients').insert({
      recipe_id: recipeId,
      product_id: placeholderId,
      user_id: userId,
      quantity: 1,
      unit: 'serving',
    });

    // ─── 2. Mimic shelf-ingest's invoke pattern ───────────────────────
    // shelf-ingest sends (see supabase/functions/shelf-ingest/index.ts:1305):
    //   const analyzeRes = await supabase.functions.invoke('analyze-product', {
    //     body: { barcode, user_id: userId },
    //   });
    // — service-role bearer (because the supabase client is service-role
    // scoped) and body `{barcode, user_id}`. NO `placeholder_candidates`.
    //
    // We use the same shape here, plus `x-test-off-mode: canned` so the
    // pipeline doesn't depend on the live OFF API. (shelf-ingest can't
    // forward this header through `supabase.functions.invoke`, but the
    // bug we're testing is independent of OFF availability — it's about
    // whether the cloud-side pipeline gathers placeholder_candidates at
    // all when the call originates server-to-server. It does not.)
    const serviceRoleKey = getFunctionRuntimeServiceRoleKey();
    const res = await fetch(ANALYZE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceRoleKey}`,
        'x-test-off-mode': 'canned',
      },
      body: JSON.stringify({
        barcode: '3017620429484', // canonical Nutella EAN
        user_id: userId,
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();

    // The service-role flow auto-creates by design. The bug is that the
    // auto-create has no way to detect the placeholder match — even if
    // Haiku is perfect, it has no candidates to consider, and the
    // suggestion-side `matched_placeholder_id` cannot fire.
    //
    // Whatever the AI degraded state, we must NOT have produced a
    // duplicate. Either:
    //   (a) the placeholder was UPDATEd in place (is_placeholder flipped
    //       to false, barcode set to 3017620429484), or
    //   (b) the call short-circuited (degraded / errored / etc) and the
    //       placeholder is untouched.
    //
    // What MUST NOT happen: two rows for the same user, one placeholder
    // and one freshly-inserted real product covering the same item.

    // ─── 3. Read the post-invoke state. ───────────────────────────────
    const { data: afterRows } = await (adminClient as any)
      .schema('chefbyte')
      .from('products')
      .select('product_id, name, barcode, is_placeholder')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    const rowList = afterRows ?? [];

    // Diagnostic dump: when the test fails, surface the exact bug shape so
    // a reader doesn't have to re-run with logging enabled.
    if (rowList.length !== 1) {
      console.error(
        '[H1 BUG] Pi USB scan path duplicated the placeholder. Rows:',
        JSON.stringify(rowList, null, 2),
        '\nanalyze-product response:',
        JSON.stringify(json, null, 2),
      );
    }

    // ─── 4. The contract assertion: at most ONE product row exists. ────
    expect(rowList).toHaveLength(1);

    // The single remaining row must be the placeholder's product_id —
    // promoted in place, FK-safe across recipe_ingredients, meal_plan,
    // food_logs. If a second row appears with a different product_id,
    // recipes that referenced the placeholder are now orphaned.
    expect(rowList[0].product_id).toBe(placeholderId);

    // If the function reported auto_created=true with a different
    // product_id, that's a duplicate — surface it loudly.
    if (json.auto_created && typeof json.product_id === 'string') {
      expect(json.product_id).toBe(placeholderId);
    }

    // ─── 5. AI-conditional assertion: when AI ran, the placeholder must
    // have been promoted (is_placeholder flipped + barcode set). When AI
    // is unavailable in the local stack (no ANTHROPIC_API_KEY in the
    // edge runtime, suggestion=null), the auto-create branch is skipped
    // entirely — the placeholder stays untouched but no duplicate is
    // created. The no-duplicate path above is the load-bearing assertion;
    // the promote-in-place path below additionally pins the UPDATE
    // semantics when AI is present.
    if (json.suggestion) {
      expect(rowList[0].is_placeholder).toBe(false);
      expect(rowList[0].barcode).toBe('3017620429484');
    } else {
      // AI degraded / absent — placeholder must be UNTOUCHED (no partial
      // promotion, no half-applied state). is_placeholder stays true,
      // barcode stays null. Surfaces a regression where the auto-create
      // branch fires writes without a suggestion to back them.
      expect(rowList[0].is_placeholder).toBe(true);
      expect(rowList[0].barcode).toBeNull();
    }

    // ─── 6. Recipe FK survived the upgrade. ────────────────────────────
    const { data: ri } = await (adminClient as any)
      .schema('chefbyte')
      .from('recipe_ingredients')
      .select('product_id')
      .eq('recipe_id', recipeId);
    expect(ri ?? []).toHaveLength(1);
    expect(ri![0].product_id).toBe(placeholderId);
  }, 30_000);
});
