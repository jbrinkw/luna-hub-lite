import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData } from '../helpers/seed';

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
