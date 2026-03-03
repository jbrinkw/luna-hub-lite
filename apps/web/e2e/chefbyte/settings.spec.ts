import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData } from '../helpers/seed';

test.describe('ChefByte Settings', () => {
  test('settings page loads with products tab active', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-load');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      const productsTab = page.getByTestId('products-tab');
      await expect(productsTab).toBeVisible();

      const productList = page.getByTestId('product-list');
      await expect(productList).toBeVisible();

      // Should have seeded products
      const products = productList.locator('[data-testid^="product-"]');
      const count = await products.count();
      expect(count).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  test('product search filters product list', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-search');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      await page.getByTestId('product-list').waitFor({ state: 'visible' });

      // Type in search
      const searchInput = page.getByTestId('product-search').locator('input');
      await searchInput.fill('Chicken');

      // Wait for filtering to take effect
      await page.waitForTimeout(300);

      // Only Chicken-related products should be visible
      const productList = page.getByTestId('product-list');
      const visibleProducts = productList.locator('[data-testid^="product-"]:visible');
      const count = await visibleProducts.count();
      expect(count).toBeGreaterThanOrEqual(1);

      // Check that the visible product contains "Chicken"
      const firstProduct = visibleProducts.first();
      const text = await firstProduct.textContent();
      expect(text?.toLowerCase()).toContain('chicken');
    } finally {
      await cleanup();
    }
  });

  test('can toggle add product form', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-toggle-add');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      await page.getByTestId('product-list').waitFor({ state: 'visible' });

      // Initially the add product form should be hidden
      const addForm = page.getByTestId('add-product-form');
      await expect(addForm).toBeHidden();

      // Click toggle to open
      const toggleBtn = page.getByTestId('toggle-add-product');
      await toggleBtn.click();

      await expect(addForm).toBeVisible();

      // Click toggle again to close
      await toggleBtn.click();

      await expect(addForm).toBeHidden();
    } finally {
      await cleanup();
    }
  });

  test('can switch to liquidtrack tab', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-lt-tab');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      await page.getByTestId('products-tab').waitFor({ state: 'visible' });

      // Click LiquidTrack segment button to switch tabs
      await page.getByTestId('settings-tabs').locator('ion-segment-button[value="liquidtrack"]').click();

      // LiquidTrack tab content should be visible
      await expect(page.getByTestId('liquidtrack-tab')).toBeVisible({ timeout: 5000 });

      // Add device section should be visible
      const addDeviceSection = page.getByTestId('add-device-section');
      await expect(addDeviceSection).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('can edit a product', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-edit-prod');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      await page.getByTestId('product-list').waitFor({ state: 'visible' });

      // Click edit on the first product
      const editBtn = page.locator('[data-testid^="edit-product-"]').first();
      await editBtn.click();

      // Edit form should appear
      const saveEditBtn = page.getByTestId('save-edit-product');
      await expect(saveEditBtn).toBeVisible();

      const cancelBtn = page.getByTestId('cancel-edit-product');
      await expect(cancelBtn).toBeVisible();

      // Click cancel
      await cancelBtn.click();

      // Edit form should close
      await expect(saveEditBtn).toBeHidden();
    } finally {
      await cleanup();
    }
  });
});
