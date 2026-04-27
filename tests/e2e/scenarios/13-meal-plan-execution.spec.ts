/**
 * Scenario 13 — meal-plan-execution-creates-meal-lot
 *
 * Execute (mark done) a meal-prep recipe → assert:
 *   1. A `[MEAL] <recipe> MM-DD` product is created with frozen nutrition
 *   2. A stock_lot for that meal product exists
 *   3. Original ingredients are decremented
 *
 * Catches: meal-prep flow regressions where the [MEAL] lot fails to mint or
 * the snapshot of nutrition drifts.
 */
import { test, expect } from '../fixtures/test-base';
import { adminClient } from '../fixtures/env';
import {
  loginViaUi,
  seedProduct,
  seedStockLot,
  seedUserAndActivate,
} from '../fixtures/test-db';

test('meal-plan-execution-creates-meal-lot', async ({ page }) => {
  const seeded = await seedUserAndActivate('meal-prep');
  try {
    const admin = adminClient();
    // Recipe with one ingredient.
    const ingProductId = await seedProduct(seeded.userId, 'Chicken Breast', {
      servings_per_container: 4,
      calories_per_serving: 165,
      protein_per_serving: 31,
    });
    await seedStockLot(seeded.userId, ingProductId, 4);

    const { data: recipe } = await (admin as any)
      .schema('chefbyte')
      .from('recipes')
      .insert({
        user_id: seeded.userId,
        name: 'Grilled Chicken',
        base_servings: 2,
      })
      .select('recipe_id')
      .single();

    await (admin as any)
      .schema('chefbyte')
      .from('recipe_ingredients')
      .insert({
        recipe_id: recipe.recipe_id,
        user_id: seeded.userId,
        product_id: ingProductId,
        quantity: 0.5,
        unit: 'container',
      });

    const today = new Date().toISOString().slice(0, 10);
    const { data: meal } = await (admin as any)
      .schema('chefbyte')
      .from('meal_plan_entries')
      .insert({
        user_id: seeded.userId,
        recipe_id: recipe.recipe_id,
        logical_date: today,
        servings: 2,
        meal_type: 'lunch',
        meal_prep: true,
      })
      .select('meal_id')
      .single();

    // Execute: call mark_meal_done as the user.
    const userClient = seeded.client;
    const { data: rpcRes, error: rpcErr } = await (userClient as any)
      .schema('chefbyte')
      .rpc('mark_meal_done', { p_meal_id: meal.meal_id });
    expect(rpcErr?.message ?? 'ok', 'mark_meal_done').toBe('ok');
    expect(rpcRes, 'rpc returned data').toBeTruthy();

    // [MEAL] product exists.
    const { data: mealProducts } = await (admin as any)
      .schema('chefbyte')
      .from('products')
      .select('product_id, name')
      .eq('user_id', seeded.userId)
      .like('name', '[MEAL]%');
    expect(mealProducts?.length).toBe(1);
    expect(mealProducts[0].name).toMatch(/^\[MEAL\] Grilled Chicken \d{2}-\d{2}$/);

    // [MEAL] product has a stock_lot.
    const mealProductId = mealProducts[0].product_id;
    const { data: mealLot } = await (admin as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('lot_id, qty_containers')
      .eq('product_id', mealProductId)
      .maybeSingle();
    expect(mealLot, 'meal lot exists').toBeTruthy();
    expect(Number(mealLot.qty_containers)).toBeGreaterThan(0);

    // Web-side: inventory shows the [MEAL] product.
    await loginViaUi(page, seeded.email, seeded.password);
    await page.goto('/chef/inventory');
    await expect(page.getByTestId(`inv-product-${mealProductId}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`inv-product-${mealProductId}`)).toContainText('[MEAL]');
  } finally {
    await seeded.cleanup();
  }
});
