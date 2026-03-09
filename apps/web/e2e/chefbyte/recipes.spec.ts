import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData, seedRecipe } from '../helpers/seed';

test.describe('ChefByte Recipes', () => {
  test('recipes page loads with seeded recipe', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'rec-load');
    try {
      const { recipeId } = await seedChefByteData(client, userId);

      await page.goto('/chef/recipes');
      await expect(page.getByTestId('recipe-list')).toBeVisible({ timeout: 15000 });

      // Seeded recipe card should be present
      await expect(page.getByTestId(`recipe-card-${recipeId}`)).toBeVisible();
      await expect(page.getByTestId(`recipe-card-${recipeId}`)).toContainText('Chicken & Rice');
    } finally {
      await cleanup();
    }
  });

  test('recipe card shows macro information', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'rec-macros');
    try {
      const { recipeId } = await seedChefByteData(client, userId);

      await page.goto('/chef/recipes');
      await expect(page.getByTestId('recipe-list')).toBeVisible({ timeout: 15000 });

      // Macro grid should be visible on the recipe card
      const macroGrid = page.getByTestId(`recipe-macros-${recipeId}`);
      await expect(macroGrid).toBeVisible();

      // Macros should contain numeric content (calories/protein from ingredients)
      await expect(macroGrid).toContainText(/\d+/);
    } finally {
      await cleanup();
    }
  });

  test('recipe search filters results', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'rec-search');
    try {
      const { recipeId } = await seedChefByteData(client, userId);

      await page.goto('/chef/recipes');
      await expect(page.getByTestId('recipe-list')).toBeVisible({ timeout: 15000 });

      // Search input should be visible
      const searchInput = page.getByTestId('recipe-search').locator('input');
      await expect(searchInput).toBeVisible();

      // Type "Chicken" — seeded recipe should still be visible
      await searchInput.fill('Chicken');
      await expect(page.getByTestId(`recipe-card-${recipeId}`)).toBeVisible();

      // Clear and type "Pizza" (nonexistent) — recipe should disappear
      await searchInput.fill('Pizza');
      await expect(page.getByTestId(`recipe-card-${recipeId}`)).not.toBeVisible({ timeout: 5000 });

      // Either no-recipes empty state appears or the recipe card is simply hidden
      const noRecipes = page.getByTestId('no-recipes');
      const cardHidden = page.getByTestId(`recipe-card-${recipeId}`);
      // At least one of these conditions should be true
      const noRecipesVisible = await noRecipes.isVisible().catch(() => false);
      const cardGone = await cardHidden.isHidden().catch(() => true);
      expect(noRecipesVisible || cardGone).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  test('new recipe button is present', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'rec-newbtn');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/recipes');
      await expect(page.getByTestId('recipe-list')).toBeVisible({ timeout: 15000 });

      // New recipe button should be visible
      await expect(page.getByTestId('new-recipe-btn')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('clicking recipe card navigates to edit form with pre-filled data', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'rec-card-nav');
    try {
      const { recipeId } = await seedChefByteData(client, userId);

      await page.goto('/chef/recipes');
      await expect(page.getByTestId('recipe-list')).toBeVisible({ timeout: 15000 });

      // Click the recipe name link on the card
      const recipeName = page.getByTestId(`recipe-name-${recipeId}`);
      await expect(recipeName).toBeVisible();
      await recipeName.click();

      // Should navigate to the edit form for this recipe
      await page.waitForURL(new RegExp(`/chef/recipes/${recipeId}`), { timeout: 5000 });

      // Recipe form should load with pre-filled name
      await page.getByTestId('recipe-fields').waitFor({ state: 'visible', timeout: 15000 });
      const nameInput = page.getByTestId('recipe-name').locator('input');
      await expect(nameInput).toHaveValue('Chicken & Rice');
    } finally {
      await cleanup();
    }
  });

  test('stock badge shows CAN MAKE when all ingredients are in stock', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'rec-canmake');
    try {
      const { recipeId } = await seedChefByteData(client, userId);

      await page.goto('/chef/recipes');
      await expect(page.getByTestId('recipe-list')).toBeVisible({ timeout: 15000 });

      // Chicken & Rice recipe: Chicken Breast (3 ctn in stock, needs 0.5) + Brown Rice (2 ctn in stock, needs 0.25)
      // Both ingredients fully stocked -> CAN MAKE
      const badge = page.getByTestId(`stock-status-${recipeId}`);
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText('CAN MAKE');
    } finally {
      await cleanup();
    }
  });

  test('stock badge shows PARTIAL when some ingredients are missing', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'rec-partial');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      // Create a recipe using Chicken Breast (3 ctn in stock) + Bananas (0 ctn in stock)
      const partialRecipeId = await seedRecipe(client, userId, 'Partial Bowl', [
        { productId: productMap['Great Value Boneless Skinless Chicken Breasts'], quantity: 1, unit: 'container' },
        { productId: productMap['Banquet Chicken Breast Patties'], quantity: 2, unit: 'container' },
      ]);

      await page.goto('/chef/recipes');
      await expect(page.getByTestId('recipe-list')).toBeVisible({ timeout: 15000 });

      // Chicken in stock, Bananas out -> PARTIAL
      const badge = page.getByTestId(`stock-status-${partialRecipeId}`);
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText('PARTIAL');
    } finally {
      await cleanup();
    }
  });

  test('stock badge shows NO STOCK when no ingredients are in stock', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'rec-nostock');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      // Create a recipe using only Bananas (0 ctn in stock)
      const noStockRecipeId = await seedRecipe(client, userId, 'Banana Only', [
        { productId: productMap['Banquet Chicken Breast Patties'], quantity: 1, unit: 'container' },
      ]);

      await page.goto('/chef/recipes');
      await expect(page.getByTestId('recipe-list')).toBeVisible({ timeout: 15000 });

      // Bananas 0 stock -> NO STOCK
      const badge = page.getByTestId(`stock-status-${noStockRecipeId}`);
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText('NO STOCK');
    } finally {
      await cleanup();
    }
  });

  test('delete recipe button removes recipe and redirects', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'rec-delete');
    try {
      const { recipeId } = await seedChefByteData(client, userId);

      // Navigate directly to the edit form for the seeded recipe
      await page.goto(`/chef/recipes/${recipeId}`);
      await page.getByTestId('recipe-fields').waitFor({ state: 'visible', timeout: 15000 });

      // Verify we are editing the correct recipe
      const nameInput = page.getByTestId('recipe-name').locator('input');
      await expect(nameInput).toHaveValue('Chicken & Rice');

      // Click the delete button
      const deleteBtn = page.getByTestId('delete-recipe-btn');
      await expect(deleteBtn).toBeVisible();
      await deleteBtn.click();

      // Confirm the IonAlert dialog by clicking "Delete" inside the alert overlay
      const alert = page.locator('ion-alert');
      await expect(alert).toBeVisible({ timeout: 5000 });
      const alertDelete = alert.locator('button', { hasText: 'Delete' });
      await alertDelete.click();

      // Should redirect back to recipe list
      await page.waitForURL(/\/chef\/recipes(?:\?|$)/, { timeout: 5000 });

      // The deleted recipe should no longer appear in the list
      await expect(page.getByTestId('recipe-list')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId(`recipe-card-${recipeId}`)).not.toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });
});
