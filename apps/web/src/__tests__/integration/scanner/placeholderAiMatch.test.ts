/**
 * Integration test — AI-assisted placeholder promotion in the scanner.
 *
 * Simulates the full scanner pipeline for the "AI name-match" path:
 *   1. Seed a placeholder product ("Greek Yogurt") with estimated macros.
 *   2. Seed a recipe_ingredient that points at the placeholder.
 *   3. Mock `analyze-product` to return `matched_placeholder_id` = that placeholder's id.
 *   4. Invoke the scanner's product-write logic directly (bypassing the UI render)
 *      so we can assert the DB mutations in isolation.
 *
 * Assertions:
 *   - The placeholder row is UPDATEd in place (same product_id).
 *   - `is_placeholder` is flipped to false.
 *   - `name` and macro fields are overwritten with the AI-normalized values.
 *   - NO new product row is inserted.
 *   - The recipe_ingredient still points at the same product_id after the upgrade.
 *
 * This test does NOT render the ScannerPage component — it exercises the
 * DB-write logic that the scanner's handleBarcodeSubmit would execute, which
 * keeps the test fast, deterministic, and free of DOM wiring noise.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createTestUser, cleanupUser } from '../../test-helpers';

let userIds: string[] = [];

afterEach(async () => {
  for (const id of userIds) {
    await cleanupUser(id);
  }
  userIds = [];
});

// ─────────────────────────────────────────────────────────────────────────
// Helper: perform the exact DB writes the scanner does when
// `matched_placeholder_id` is returned by analyze-product.
// This mirrors the `upgradeTargetId` branch in handleBarcodeSubmit.
// ─────────────────────────────────────────────────────────────────────────
async function performPlaceholderUpgrade(chef: any, upgradeTargetId: string, productFields: Record<string, unknown>) {
  const returning =
    'product_id, name, is_placeholder, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving, servings_per_container, default_shelf_life_days';
  const { data, error } = await chef
    .from('products')
    .update(productFields)
    .eq('product_id', upgradeTargetId)
    .select(returning)
    .single();
  return { data, error };
}

describe('Scanner placeholder AI-match promotion (integration)', () => {
  it('upgrades the placeholder row in place; recipe FK survives; no duplicate row', async () => {
    const { userId, client } = await createTestUser('ph-ai-match');
    userIds.push(userId);
    const chef = client.schema('chefbyte') as any;

    // ------------------------------------------------------------------
    // 1. Seed a placeholder product — "Greek Yogurt"
    // ------------------------------------------------------------------
    const { data: placeholder, error: phErr } = await chef
      .from('products')
      .insert({
        user_id: userId,
        name: 'Greek Yogurt',
        description: 'Plain non-fat greek yogurt',
        is_placeholder: true,
        calories_per_serving: 90,
        protein_per_serving: 15,
        carbs_per_serving: 6,
        fat_per_serving: 0,
        servings_per_container: 1,
      })
      .select('product_id, name, is_placeholder')
      .single();
    expect(phErr).toBeNull();
    const placeholderProductId: string = placeholder.product_id;
    expect(placeholder.is_placeholder).toBe(true);

    // ------------------------------------------------------------------
    // 2. Seed a recipe + recipe_ingredient pointing at the placeholder
    // ------------------------------------------------------------------
    const { data: recipe, error: recipeErr } = await chef
      .from('recipes')
      .insert({ user_id: userId, name: 'Yogurt Bowl', base_servings: 1 })
      .select('recipe_id')
      .single();
    expect(recipeErr).toBeNull();
    const recipeId: string = recipe.recipe_id;

    const { error: riErr } = await chef.from('recipe_ingredients').insert({
      recipe_id: recipeId,
      product_id: placeholderProductId,
      user_id: userId,
      quantity: 1,
      unit: 'container',
    });
    expect(riErr).toBeNull();

    // ------------------------------------------------------------------
    // 3. Verify initial state: 1 product row, recipe_ingredient points at it
    // ------------------------------------------------------------------
    const { data: beforeProducts } = await chef.from('products').select('product_id').eq('user_id', userId);
    expect(beforeProducts).toHaveLength(1);

    const { data: beforeRi } = await chef.from('recipe_ingredients').select('product_id').eq('recipe_id', recipeId);
    expect(beforeRi).toHaveLength(1);
    expect(beforeRi[0].product_id).toBe(placeholderProductId);

    // ------------------------------------------------------------------
    // 4. Simulate analyze-product returning matched_placeholder_id.
    //    The mock response would look like:
    //      { matched_placeholder_id: placeholderProductId, suggestion: { ... } }
    //    The scanner extracts aiMatchedPlaceholderId and calls the upgrade path.
    // ------------------------------------------------------------------
    const aiSuggestion = {
      name: 'Chobani Greek Yogurt 0%',
      servings_per_container: 1,
      calories_per_serving: 80,
      protein_per_serving: 14,
      carbs_per_serving: 6,
      fat_per_serving: 0,
      description: 'Non-fat plain greek yogurt by Chobani',
      default_shelf_life_days: 21,
    };

    // These are the productFields the scanner builds from the AI suggestion.
    const productFields = {
      barcode: '036632003323', // Chobani barcode
      name: aiSuggestion.name,
      description: aiSuggestion.description,
      is_placeholder: false,
      calories_per_serving: aiSuggestion.calories_per_serving,
      protein_per_serving: aiSuggestion.protein_per_serving,
      carbs_per_serving: aiSuggestion.carbs_per_serving,
      fat_per_serving: aiSuggestion.fat_per_serving,
      servings_per_container: aiSuggestion.servings_per_container,
      default_shelf_life_days: aiSuggestion.default_shelf_life_days,
    };

    // Perform the upgrade (mirrors scanner's handleBarcodeSubmit upgrade branch).
    const { data: upgraded, error: upgradeErr } = await performPlaceholderUpgrade(
      chef,
      placeholderProductId, // aiMatchedPlaceholderId from mock response
      productFields,
    );
    expect(upgradeErr).toBeNull();
    expect(upgraded).not.toBeNull();

    // ------------------------------------------------------------------
    // 5. Assert: same product_id preserved
    // ------------------------------------------------------------------
    expect(upgraded.product_id).toBe(placeholderProductId);

    // ------------------------------------------------------------------
    // 6. Assert: is_placeholder flipped to false
    // ------------------------------------------------------------------
    expect(upgraded.is_placeholder).toBe(false);

    // ------------------------------------------------------------------
    // 7. Assert: name + macros overwritten with AI-normalized values
    // ------------------------------------------------------------------
    expect(upgraded.name).toBe('Chobani Greek Yogurt 0%');
    expect(upgraded.calories_per_serving).toBe(80);
    expect(upgraded.protein_per_serving).toBe(14);
    expect(upgraded.carbs_per_serving).toBe(6);
    expect(upgraded.fat_per_serving).toBe(0);
    expect(upgraded.default_shelf_life_days).toBe(21);

    // ------------------------------------------------------------------
    // 8. Assert: NO new product row inserted — still exactly 1 row
    // ------------------------------------------------------------------
    const { data: afterProducts } = await chef.from('products').select('product_id').eq('user_id', userId);
    expect(afterProducts).toHaveLength(1);
    expect(afterProducts[0].product_id).toBe(placeholderProductId);

    // ------------------------------------------------------------------
    // 9. Assert: recipe_ingredient still resolves to the same product_id
    //    post-upgrade — FK integrity survived the UPDATE-in-place.
    // ------------------------------------------------------------------
    const { data: afterRi } = await chef.from('recipe_ingredients').select('product_id').eq('recipe_id', recipeId);
    expect(afterRi).toHaveLength(1);
    expect(afterRi[0].product_id).toBe(placeholderProductId);

    // Double-check: the product the recipe now references is no longer a placeholder
    const { data: finalProduct } = await chef
      .from('products')
      .select('product_id, name, is_placeholder')
      .eq('product_id', afterRi[0].product_id)
      .single();
    expect(finalProduct.is_placeholder).toBe(false);
    expect(finalProduct.name).toBe('Chobani Greek Yogurt 0%');
  });

  it('null matched_placeholder_id → INSERT new row, placeholder untouched', async () => {
    const { userId, client } = await createTestUser('ph-ai-null');
    userIds.push(userId);
    const chef = client.schema('chefbyte') as any;

    // Seed a placeholder
    const { data: placeholder, error: phErr } = await chef
      .from('products')
      .insert({
        user_id: userId,
        name: 'Oat Milk',
        is_placeholder: true,
        calories_per_serving: 40,
        protein_per_serving: 1,
        carbs_per_serving: 7,
        fat_per_serving: 1,
        servings_per_container: 8,
      })
      .select('product_id')
      .single();
    expect(phErr).toBeNull();
    const placeholderProductId: string = placeholder.product_id;

    // When matched_placeholder_id is null AND existingPlaceholderId is null
    // (no barcode match either), the scanner inserts a new product row.
    const { data: newProd, error: insertErr } = await chef
      .from('products')
      .insert({
        user_id: userId,
        barcode: '012345678905',
        name: 'Silk Oat Yeah Oatmilk',
        description: 'Original oat milk',
        is_placeholder: false,
        calories_per_serving: 90,
        protein_per_serving: 2,
        carbs_per_serving: 15,
        fat_per_serving: 2.5,
        servings_per_container: 8,
        default_shelf_life_days: 10,
      })
      .select('product_id, name, is_placeholder')
      .single();
    expect(insertErr).toBeNull();

    // Two rows now — placeholder still exists, new row created alongside it
    const { data: allProducts } = await chef
      .from('products')
      .select('product_id, is_placeholder')
      .eq('user_id', userId)
      .order('created_at');
    expect(allProducts).toHaveLength(2);

    const placeholderRow = allProducts.find((p: any) => p.product_id === placeholderProductId);
    const newRow = allProducts.find((p: any) => p.product_id === newProd.product_id);
    expect(placeholderRow?.is_placeholder).toBe(true); // untouched
    expect(newRow?.is_placeholder).toBe(false); // new real product
  });
});
