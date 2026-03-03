import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData } from '../helpers/seed';

test.describe('ChefByte Recipe Create/Edit', () => {
  test('new recipe form loads with empty fields', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'recipe-new-empty');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/recipes/new');

      const fields = page.getByTestId('recipe-fields');
      await expect(fields).toBeVisible();

      const nameInput = page.getByTestId('recipe-name').locator('input');
      await expect(nameInput).toHaveValue('');

      const noIngredients = page.getByTestId('no-ingredients');
      await expect(noIngredients).toBeVisible();

      const saveBtn = page.getByTestId('save-recipe-btn');
      await expect(saveBtn).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('can fill recipe name and base servings', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'recipe-fill-fields');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/recipes/new');

      await page.getByTestId('recipe-fields').waitFor({ state: 'visible' });

      const nameInput = page.getByTestId('recipe-name').locator('input');
      await nameInput.fill('My Test Recipe');
      await expect(nameInput).toHaveValue('My Test Recipe');

      const servingsInput = page.getByTestId('recipe-base-servings').locator('input');
      await servingsInput.fill('4');
      await expect(servingsInput).toHaveValue('4');
    } finally {
      await cleanup();
    }
  });

  test('can add ingredient via product search', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'recipe-add-ing');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/recipes/new');

      await page.getByTestId('recipe-fields').waitFor({ state: 'visible' });

      // Search for a product
      const searchInput = page.getByTestId('ingredient-product-search').locator('input');
      await searchInput.fill('Chicken');

      // Wait for dropdown and click first item
      const dropdown = page.getByTestId('ingredient-product-dropdown');
      await expect(dropdown).toBeVisible();
      const firstItem = dropdown.locator('[data-testid^="ing-dropdown-item-"]').first();
      await firstItem.click();

      // Set quantity
      const qtyInput = page.getByTestId('ingredient-qty').locator('input');
      await qtyInput.fill('0.5');

      // Click add
      const addBtn = page.getByTestId('add-ingredient-btn');
      await addBtn.click();

      // Verify ingredient row appears
      const ingredientRow = page.getByTestId('ingredient-row-0');
      await expect(ingredientRow).toBeVisible();

      // no-ingredients message should be hidden
      const noIngredients = page.getByTestId('no-ingredients');
      await expect(noIngredients).toBeHidden();
    } finally {
      await cleanup();
    }
  });

  test('can save a new recipe', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'recipe-save-new');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/recipes/new');

      await page.getByTestId('recipe-fields').waitFor({ state: 'visible' });

      // Fill name
      const nameInput = page.getByTestId('recipe-name').locator('input');
      await nameInput.fill('Test Recipe');

      // Fill servings
      const servingsInput = page.getByTestId('recipe-base-servings').locator('input');
      await servingsInput.fill('2');

      // Add an ingredient
      const searchInput = page.getByTestId('ingredient-product-search').locator('input');
      await searchInput.fill('Chicken');

      const dropdown = page.getByTestId('ingredient-product-dropdown');
      await expect(dropdown).toBeVisible();
      const firstItem = dropdown.locator('[data-testid^="ing-dropdown-item-"]').first();
      await firstItem.click();

      const qtyInput = page.getByTestId('ingredient-qty').locator('input');
      await qtyInput.fill('1');

      await page.getByTestId('add-ingredient-btn').click();
      await expect(page.getByTestId('ingredient-row-0')).toBeVisible();

      // Save recipe
      await page.getByTestId('save-recipe-btn').click();

      // Should redirect to recipes list or show success
      await page.waitForURL(/\/chef\/recipes(?:\?|$)/, { timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('edit mode loads existing recipe data', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'recipe-edit-load');
    try {
      const { recipeId } = await seedChefByteData(client, userId);
      await page.goto(`/chef/recipes/${recipeId}`);

      await page.getByTestId('recipe-fields').waitFor({ state: 'visible' });

      // Recipe name should be pre-filled
      const nameInput = page.getByTestId('recipe-name').locator('input');
      await expect(nameInput).toHaveValue('Chicken & Rice');

      // Ingredients table should have rows
      const ingredientsTable = page.getByTestId('ingredients-table');
      await expect(ingredientsTable).toBeVisible();

      const rows = ingredientsTable.locator('[data-testid^="ingredient-row-"]');
      const count = await rows.count();
      expect(count).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });
});
