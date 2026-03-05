import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData, seedMealEntry, seedShoppingItems, todayStr } from '../helpers/seed';

test.describe('ChefByte Home Page', () => {
  test('home page loads with status cards and macro summary', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-home-load');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/home');

      // Wait for loading to disappear
      await expect(page.getByTestId('home-loading')).toBeHidden({ timeout: 10000 });

      // Status cards section visible with all 4 cards
      const statusCards = page.getByTestId('status-cards');
      await expect(statusCards).toBeVisible();
      await expect(page.getByTestId('card-missing-prices')).toBeVisible();
      await expect(page.getByTestId('card-placeholders')).toBeVisible();
      await expect(page.getByTestId('card-below-min')).toBeVisible();
      await expect(page.getByTestId('card-cart-value')).toBeVisible();

      // Macro summary section visible with all 4 compact progress bars
      const macroSummary = page.getByTestId('macro-summary');
      await expect(macroSummary).toBeVisible();
      await expect(page.getByTestId('compact-calories')).toBeVisible();
      await expect(page.getByTestId('compact-protein')).toBeVisible();
      await expect(page.getByTestId('compact-carbs')).toBeVisible();
      await expect(page.getByTestId('compact-fats')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('quick action buttons are visible', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-home-actions');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/home');

      await expect(page.getByTestId('home-loading')).toBeHidden({ timeout: 10000 });

      // Quick actions section visible with all 4 buttons
      const quickActions = page.getByTestId('quick-actions');
      await expect(quickActions).toBeVisible();
      await expect(page.getByTestId('import-shopping-btn')).toBeVisible();
      await expect(page.getByTestId('target-macros-btn')).toBeVisible();
      await expect(page.getByTestId('taste-profile-btn')).toBeVisible();
      await expect(page.getByTestId('meal-plan-cart-btn')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('target macros modal opens and shows auto-calculated calories', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-home-macros');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/home');

      await expect(page.getByTestId('home-loading')).toBeHidden({ timeout: 10000 });

      // Click target macros quick action button
      await page.getByTestId('target-macros-btn').click();

      // Modal opens
      const modal = page.getByTestId('target-macros-modal');
      await expect(modal).toBeVisible({ timeout: 5000 });

      // Protein, carbs, fats inputs present
      await expect(page.getByTestId('target-protein')).toBeVisible();
      await expect(page.getByTestId('target-carbs')).toBeVisible();
      await expect(page.getByTestId('target-fats')).toBeVisible();

      // Auto-calculated calories display present
      await expect(page.getByTestId('target-calories')).toBeVisible();

      // Cancel and save buttons present
      await expect(page.getByTestId('target-cancel-btn')).toBeVisible();
      await expect(page.getByTestId('target-save-btn')).toBeVisible();

      // Click cancel to close
      await page.getByTestId('target-cancel-btn').click();
      await expect(modal).toBeHidden({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('taste profile modal opens with textarea', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-home-taste');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/home');

      await expect(page.getByTestId('home-loading')).toBeHidden({ timeout: 10000 });

      // Click taste profile quick action button
      await page.getByTestId('taste-profile-btn').click();

      // Taste modal opens
      const modal = page.getByTestId('taste-modal');
      await expect(modal).toBeVisible({ timeout: 5000 });

      // Textarea present
      await expect(page.getByTestId('taste-textarea')).toBeVisible();

      // Cancel and save buttons present
      await expect(page.getByTestId('taste-cancel-btn')).toBeVisible();
      await expect(page.getByTestId('taste-save-btn')).toBeVisible();

      // Click cancel to close
      await page.getByTestId('taste-cancel-btn').click();
      await expect(modal).toBeHidden({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('meal prep section shows empty state when no preps scheduled', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-home-noprep');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/home');

      await expect(page.getByTestId('home-loading')).toBeHidden({ timeout: 10000 });

      // Meal prep section visible
      const mealPrepSection = page.getByTestId('meal-prep-section');
      await expect(mealPrepSection).toBeVisible();

      // No meal prep message visible (empty state)
      await expect(page.getByTestId('no-meal-prep')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('below-min stock count reflects seed data', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-home-belowmin');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/home');

      await expect(page.getByTestId('home-loading')).toBeHidden({ timeout: 10000 });

      // card-below-min should contain "2" (Eggs: 0.5 < 1 min, Bananas: 0 < 3 min)
      const belowMinCard = page.getByTestId('card-below-min');
      await expect(belowMinCard).toBeVisible();
      await expect(belowMinCard).toContainText('2');
    } finally {
      await cleanup();
    }
  });

  // Status cards are plain divs without click handlers/links — no navigation behavior exists
  test.skip('status card click navigates to relevant page', async ({ page }) => {
    // TODO: Status cards are currently static display-only divs. Once they become
    // clickable links (e.g. below-min card -> /chef/inventory), enable this test.
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-home-card-nav');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/home');

      await expect(page.getByTestId('home-loading')).toBeHidden({ timeout: 10000 });

      // Click the below-min status card
      await page.getByTestId('card-below-min').click();

      // Verify navigation to inventory page
      await expect(page).toHaveURL(/\/chef\/inventory/);
    } finally {
      await cleanup();
    }
  });

  test('import shopping to inventory flow', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-home-import');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chef = (client as any).schema('chefbyte');

      // Seed purchased shopping items for two products
      const chickenId = productMap['Chicken Breast'];
      const riceId = productMap['Brown Rice'];

      await seedShoppingItems(client, userId, [
        { productId: chickenId, qtyContainers: 2, purchased: true },
        { productId: riceId, qtyContainers: 1, purchased: true },
      ]);

      // Verify shopping items exist before import
      const { data: beforeItems } = await chef
        .from('shopping_list')
        .select('cart_item_id')
        .eq('user_id', userId)
        .eq('purchased', true);
      expect(beforeItems!.length).toBe(2);

      // Get stock count before import for Chicken Breast
      const { data: stockBefore } = await chef
        .from('stock_lots')
        .select('qty_containers')
        .eq('product_id', chickenId)
        .eq('user_id', userId);
      const stockBeforeTotal = (stockBefore ?? []).reduce(
        (sum: number, lot: any) => sum + Number(lot.qty_containers),
        0,
      );

      await page.goto('/chef/home');
      await expect(page.getByTestId('home-loading')).toBeHidden({ timeout: 10000 });

      // Click the import shopping button
      await page.getByTestId('import-shopping-btn').click();

      // Wait for the import to process and data to reload
      await page.waitForTimeout(2000);

      // Verify purchased shopping items were removed from shopping_list
      const { data: afterItems } = await chef
        .from('shopping_list')
        .select('cart_item_id')
        .eq('user_id', userId)
        .eq('purchased', true);
      expect(afterItems?.length ?? 0).toBe(0);

      // Verify stock increased for Chicken Breast
      const { data: stockAfter } = await chef
        .from('stock_lots')
        .select('qty_containers')
        .eq('product_id', chickenId)
        .eq('user_id', userId);
      const stockAfterTotal = (stockAfter ?? []).reduce((sum: number, lot: any) => sum + Number(lot.qty_containers), 0);
      expect(stockAfterTotal).toBeGreaterThan(stockBeforeTotal);
    } finally {
      await cleanup();
    }
  });

  test('todays meals section shows seeded meals', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-home-meals');
    try {
      const { recipeId } = await seedChefByteData(client, userId);

      // Seed a non-prep meal entry for today
      const today = todayStr();
      const mealId = await seedMealEntry(client, userId, recipeId, today, {
        servings: 2,
        mealType: 'dinner',
        isMealPrep: false,
      });

      await page.goto('/chef/home');
      await expect(page.getByTestId('home-loading')).toBeHidden({ timeout: 10000 });

      // Today's meals section should be visible
      const mealsSection = page.getByTestId('todays-meals-section');
      await expect(mealsSection).toBeVisible();

      // The "no meals" empty state should NOT be visible
      await expect(page.getByTestId('no-todays-meals')).toBeHidden();

      // The seeded meal entry should appear
      const mealEntry = page.getByTestId(`meal-entry-${mealId}`);
      await expect(mealEntry).toBeVisible();

      // Verify the meal shows the recipe name
      const entryText = await mealEntry.textContent();
      expect(entryText).toContain('Chicken & Rice');

      // Verify meal type is displayed
      const mealType = page.getByTestId(`meal-type-${mealId}`);
      await expect(mealType).toBeVisible();
      await expect(mealType).toContainText('dinner');

      // Verify status shows Pending (not completed)
      const mealStatus = page.getByTestId(`meal-status-${mealId}`);
      await expect(mealStatus).toContainText('Pending');
    } finally {
      await cleanup();
    }
  });

  test('meal plan to cart sync adds recipe ingredients to shopping list', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-home-sync');
    try {
      const { recipeId, productMap } = await seedChefByteData(client, userId);

      // Seed a meal plan entry for today (non-prep, not completed)
      const today = todayStr();
      await seedMealEntry(client, userId, recipeId, today, {
        servings: 2,
        mealType: 'lunch',
        isMealPrep: false,
      });

      await page.goto('/chef/home');
      await expect(page.getByTestId('home-loading')).toBeHidden({ timeout: 10000 });

      // Click the meal plan → cart sync button
      await page.getByTestId('meal-plan-cart-btn').click();

      // Wait for the sync to process
      await page.waitForTimeout(2000);

      // Verify in DB that shopping list items were created from recipe ingredients
      const chef = (client as any).schema('chefbyte');
      const { data: shopItems } = await chef
        .from('shopping_list')
        .select('product_id, qty_containers, purchased')
        .eq('user_id', userId);

      expect(shopItems).toBeTruthy();
      expect(shopItems.length).toBeGreaterThanOrEqual(1);

      // The recipe "Chicken & Rice" has 2 ingredients: Chicken Breast (0.5 container) and Brown Rice (0.25 container)
      // With 2 servings and base_servings=2, ratio = 1
      // Chicken: 0.5 * 1 = 0.5 → ceil = 1 container
      // Rice: 0.25 * 1 = 0.25 → ceil = 1 container
      const chickenItem = shopItems.find((i: any) => i.product_id === productMap['Chicken Breast']);
      expect(chickenItem).toBeTruthy();
      expect(chickenItem.qty_containers).toBe(1);
      expect(chickenItem.purchased).toBe(false);

      const riceItem = shopItems.find((i: any) => i.product_id === productMap['Brown Rice']);
      expect(riceItem).toBeTruthy();
      expect(riceItem.qty_containers).toBe(1);
      expect(riceItem.purchased).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
