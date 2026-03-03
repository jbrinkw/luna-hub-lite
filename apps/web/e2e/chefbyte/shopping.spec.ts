import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData } from '../helpers/seed';

test.describe('ChefByte Shopping', () => {
  test('shopping page loads with add form and empty lists', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-load');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/shopping');

      // Add item form should be visible
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 15000 });

      // To Buy section visible with empty state
      await expect(page.getByTestId('to-buy-section')).toBeVisible();
      await expect(page.getByTestId('no-to-buy')).toBeVisible();
      await expect(page.getByTestId('no-to-buy')).toContainText('No items to buy');

      // Purchased section visible with empty state
      await expect(page.getByTestId('purchased-section')).toBeVisible();
      await expect(page.getByTestId('no-purchased')).toBeVisible();
      await expect(page.getByTestId('no-purchased')).toContainText('No purchased items');
    } finally {
      await cleanup();
    }
  });

  test('auto-add button populates items below min stock', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-auto');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 15000 });

      // Initially the to-buy list should be empty
      await expect(page.getByTestId('no-to-buy')).toBeVisible();

      // Click the auto-add button
      await page.getByTestId('auto-add-btn').click();

      // To-buy list should now appear with items below min stock
      // Eggs: 0.5 stock < 1 min -> needs 1 container (ceil(1 - 0.5) = 1)
      // Bananas: 0 stock < 3 min -> needs 3 containers (ceil(3 - 0) = 3)
      await expect(page.getByTestId('to-buy-list')).toBeVisible({ timeout: 10000 });

      const toBuySection = page.getByTestId('to-buy-section');
      await expect(toBuySection).toContainText('Eggs');
      await expect(toBuySection).toContainText('Bananas');

      // Empty state should be gone now
      await expect(page.getByTestId('no-to-buy')).not.toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('can add a manual item to shopping list', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-manual');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 15000 });

      // Type a product name into the item name input (IonInput wraps native input)
      await page.getByTestId('add-item-name').locator('input').fill('Chicken');

      // Wait for dropdown to appear with matching product
      await expect(page.getByTestId('product-dropdown')).toBeVisible({ timeout: 5000 });

      // Click the first matching dropdown item (Chicken Breast)
      const dropdownItems = page.getByTestId('product-dropdown').locator('[data-testid^="dropdown-item-"]');
      await expect(dropdownItems.first()).toBeVisible();
      await dropdownItems.first().click();

      // Set quantity to 2
      await page.getByTestId('add-item-qty').locator('input').fill('2');

      // Click the Add button
      await page.getByTestId('add-item-btn').click();

      // Verify the item appears in the to-buy list
      await expect(page.getByTestId('to-buy-list')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('to-buy-section')).toContainText('Chicken Breast');
    } finally {
      await cleanup();
    }
  });

  test('checking an item moves it to purchased section', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-check');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 15000 });

      // Add items via auto-add so we have items to work with
      await page.getByTestId('auto-add-btn').click();
      await expect(page.getByTestId('to-buy-list')).toBeVisible({ timeout: 10000 });

      // Find the first item in the to-buy list and get its name for later verification
      const firstItem = page.getByTestId('to-buy-list').locator('[data-testid^="item-"]').first();
      await expect(firstItem).toBeVisible();
      const itemName = await firstItem.locator('span').first().innerText();

      // Click the checkbox on the first item to mark it as purchased
      const firstCheckbox = page.getByTestId('to-buy-list').locator('[data-testid^="check-"]').first();
      await firstCheckbox.click();

      // Wait for the purchased list to appear with the checked item
      await expect(page.getByTestId('purchased-list')).toBeVisible({ timeout: 10000 });

      // The purchased section should contain the item name
      await expect(page.getByTestId('purchased-section')).toContainText(itemName);

      // The empty purchased state should be gone
      await expect(page.getByTestId('no-purchased')).not.toBeVisible();
    } finally {
      await cleanup();
    }
  });
});
