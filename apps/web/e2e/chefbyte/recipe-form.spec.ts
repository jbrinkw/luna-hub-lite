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

  test('edit ingredient quantity in recipe form', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'recipe-edit-qty');
    try {
      const { recipeId } = await seedChefByteData(client, userId);
      await page.goto(`/chef/recipes/${recipeId}`);

      await page.getByTestId('recipe-fields').waitFor({ state: 'visible', timeout: 15000 });

      // Wait for the ingredients table to load
      const ingredientsTable = page.getByTestId('ingredients-table');
      await expect(ingredientsTable).toBeVisible();

      // Edit the quantity of the first ingredient (Chicken Breast, originally 0.5)
      const qtyInput = page.getByTestId('edit-qty-0').locator('input');
      await expect(qtyInput).toBeVisible();
      await qtyInput.fill('2');
      await expect(qtyInput).toHaveValue('2');

      // Save the recipe
      await page.getByTestId('save-recipe-btn').click();

      // Should redirect to recipes list
      await page.waitForURL(/\/chef\/recipes(?:\?|$)/, { timeout: 5000 });

      // Navigate back to the edit form and verify the quantity persisted
      await page.goto(`/chef/recipes/${recipeId}`);
      await page.getByTestId('recipe-fields').waitFor({ state: 'visible', timeout: 15000 });
      await expect(page.getByTestId('ingredients-table')).toBeVisible();

      const updatedQty = page.getByTestId('edit-qty-0').locator('input');
      await expect(updatedQty).toHaveValue('2');
    } finally {
      await cleanup();
    }
  });

  test('delete ingredient removes it from list', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'recipe-del-ing');
    try {
      const { recipeId } = await seedChefByteData(client, userId);
      await page.goto(`/chef/recipes/${recipeId}`);

      await page.getByTestId('recipe-fields').waitFor({ state: 'visible', timeout: 15000 });

      // Verify 2 ingredient rows exist (Chicken Breast + Brown Rice)
      const ingredientsTable = page.getByTestId('ingredients-table');
      await expect(ingredientsTable).toBeVisible();
      const rowsBefore = ingredientsTable.locator('[data-testid^="ingredient-row-"]');
      const countBefore = await rowsBefore.count();
      expect(countBefore).toBe(2);

      // Click the remove button on the first ingredient
      const removeBtn = page.getByTestId('remove-ingredient-0');
      await expect(removeBtn).toBeVisible();
      await removeBtn.click();

      // Now there should be only 1 ingredient row
      const rowsAfter = ingredientsTable.locator('[data-testid^="ingredient-row-"]');
      await expect(rowsAfter).toHaveCount(1);
    } finally {
      await cleanup();
    }
  });

  test('description and instructions textareas save', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'recipe-desc-instr');
    try {
      const { recipeId } = await seedChefByteData(client, userId);
      await page.goto(`/chef/recipes/${recipeId}`);

      await page.getByTestId('recipe-fields').waitFor({ state: 'visible', timeout: 15000 });

      // Fill description
      const descTextarea = page.getByTestId('recipe-description').locator('textarea');
      await descTextarea.fill('A delicious high-protein meal');

      // Fill instructions
      const instrTextarea = page.getByTestId('recipe-instructions').locator('textarea');
      await instrTextarea.fill('Step 1: Cook chicken. Step 2: Cook rice. Step 3: Combine.');

      // Save the recipe
      await page.getByTestId('save-recipe-btn').click();
      await page.waitForURL(/\/chef\/recipes(?:\?|$)/, { timeout: 5000 });

      // Navigate back and verify the values persisted
      await page.goto(`/chef/recipes/${recipeId}`);
      await page.getByTestId('recipe-fields').waitFor({ state: 'visible', timeout: 15000 });

      const descAfter = page.getByTestId('recipe-description').locator('textarea');
      await expect(descAfter).toHaveValue('A delicious high-protein meal');

      const instrAfter = page.getByTestId('recipe-instructions').locator('textarea');
      await expect(instrAfter).toHaveValue('Step 1: Cook chicken. Step 2: Cook rice. Step 3: Combine.');
    } finally {
      await cleanup();
    }
  });

  test('active_time and total_time fields save', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'recipe-times');
    try {
      const { recipeId } = await seedChefByteData(client, userId);
      await page.goto(`/chef/recipes/${recipeId}`);

      await page.getByTestId('recipe-fields').waitFor({ state: 'visible', timeout: 15000 });

      // Verify pre-filled values from seed (active_time: 15, total_time: 30)
      const activeInput = page.getByTestId('recipe-active-time').locator('input');
      const totalInput = page.getByTestId('recipe-total-time').locator('input');
      await expect(activeInput).toHaveValue('15');
      await expect(totalInput).toHaveValue('30');

      // Update to new values
      await activeInput.fill('25');
      await totalInput.fill('45');

      // Save
      await page.getByTestId('save-recipe-btn').click();
      await page.waitForURL(/\/chef\/recipes(?:\?|$)/, { timeout: 5000 });

      // Navigate back and verify persistence
      await page.goto(`/chef/recipes/${recipeId}`);
      await page.getByTestId('recipe-fields').waitFor({ state: 'visible', timeout: 15000 });

      await expect(page.getByTestId('recipe-active-time').locator('input')).toHaveValue('25');
      await expect(page.getByTestId('recipe-total-time').locator('input')).toHaveValue('45');
    } finally {
      await cleanup();
    }
  });

  test('unit selector works per ingredient', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'recipe-unit-sel');
    try {
      const { recipeId } = await seedChefByteData(client, userId);
      await page.goto(`/chef/recipes/${recipeId}`);

      await page.getByTestId('recipe-fields').waitFor({ state: 'visible', timeout: 15000 });
      await expect(page.getByTestId('ingredients-table')).toBeVisible();

      // The seeded ingredients use 'container' unit — verify first ingredient's unit select
      const unitSelect = page.getByTestId('edit-unit-0');
      await expect(unitSelect).toBeVisible();

      // The IonSelect should show the current value
      await expect(unitSelect).toContainText(/Container/i);

      // Change the unit to 'serving' via IonSelect
      await unitSelect.click();

      // IonSelect opens an alert/popover with options — click "Serving"
      const servingOption = page.getByRole('radio', { name: 'Serving' });
      await servingOption.click();

      // Confirm the selection (IonSelect alert has OK button)
      const okButton = page.getByRole('button', { name: 'OK' });
      await okButton.click();

      // Verify the unit select now shows "Serving"
      await expect(unitSelect).toContainText(/Serving/i);
    } finally {
      await cleanup();
    }
  });

  test('zero-ingredient save attempt shows validation error', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'recipe-zero-ing');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/recipes/new');

      await page.getByTestId('recipe-fields').waitFor({ state: 'visible', timeout: 15000 });

      // Fill in a recipe name but add no ingredients
      const nameInput = page.getByTestId('recipe-name').locator('input');
      await nameInput.fill('Empty Recipe');

      // The save button should be disabled because there are 0 ingredients
      const saveBtn = page.getByTestId('save-recipe-btn');
      await expect(saveBtn).toBeVisible();

      // Verify the button is disabled (disabled attribute on the inner button or ion-button)
      // IonButton renders a <button> inside the shadow DOM when disabled
      const isDisabled = await saveBtn.evaluate((el: HTMLElement) => {
        return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
      });
      expect(isDisabled).toBe(true);

      // Also verify the "no ingredients" message is shown
      await expect(page.getByTestId('no-ingredients')).toBeVisible();
    } finally {
      await cleanup();
    }
  });
});
