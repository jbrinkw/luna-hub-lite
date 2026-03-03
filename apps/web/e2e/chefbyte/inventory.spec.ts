import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData } from '../helpers/seed';

test.describe('ChefByte Inventory', () => {
  test('inventory page loads with seeded products', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-load');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 15000 });

      // All 5 product cards should be visible
      await expect(page.getByTestId(`inv-product-${productMap['Chicken Breast']}`)).toBeVisible();
      await expect(page.getByTestId(`inv-product-${productMap['Brown Rice']}`)).toBeVisible();
      await expect(page.getByTestId(`inv-product-${productMap['Eggs']}`)).toBeVisible();
      await expect(page.getByTestId(`inv-product-${productMap['Protein Powder']}`)).toBeVisible();
      await expect(page.getByTestId(`inv-product-${productMap['Bananas']}`)).toBeVisible();

      // Product names should be displayed within their cards
      await expect(page.getByTestId(`inv-product-${productMap['Chicken Breast']}`)).toContainText('Chicken Breast');
      await expect(page.getByTestId(`inv-product-${productMap['Brown Rice']}`)).toContainText('Brown Rice');
      await expect(page.getByTestId(`inv-product-${productMap['Eggs']}`)).toContainText('Eggs');
      await expect(page.getByTestId(`inv-product-${productMap['Protein Powder']}`)).toContainText('Protein Powder');
      await expect(page.getByTestId(`inv-product-${productMap['Bananas']}`)).toContainText('Bananas');
    } finally {
      await cleanup();
    }
  });

  test('stock badges show correct colors based on stock level', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-badges');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 15000 });

      // Chicken Breast: 3 ctn >= 2 min -> success
      await expect(page.getByTestId(`stock-badge-${productMap['Chicken Breast']}`)).toHaveAttribute('color', 'success');

      // Brown Rice: 2 ctn >= 1 min -> success
      await expect(page.getByTestId(`stock-badge-${productMap['Brown Rice']}`)).toHaveAttribute('color', 'success');

      // Eggs: 0.5 ctn < 1 min -> warning
      await expect(page.getByTestId(`stock-badge-${productMap['Eggs']}`)).toHaveAttribute('color', 'warning');

      // Protein Powder: 0.5 ctn >= 0.5 min -> success
      await expect(page.getByTestId(`stock-badge-${productMap['Protein Powder']}`)).toHaveAttribute('color', 'success');

      // Bananas: 0 ctn < 3 min -> danger
      await expect(page.getByTestId(`stock-badge-${productMap['Bananas']}`)).toHaveAttribute('color', 'danger');
    } finally {
      await cleanup();
    }
  });

  test('lots view shows stock lot table with location and expiry', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-lots');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 15000 });

      // Switch to Lots view via the segment toggle
      await page.getByTestId('inventory-view-toggle').locator('ion-segment-button[value="lots"]').click();

      // Lots view should be visible
      await expect(page.getByTestId('lots-view')).toBeVisible();

      // Lots table should exist
      await expect(page.getByTestId('lots-table')).toBeVisible();

      // Location names should appear in the table
      const lotsTable = page.getByTestId('lots-table');
      await expect(lotsTable).toContainText('Fridge');
      await expect(lotsTable).toContainText('Pantry');
    } finally {
      await cleanup();
    }
  });

  test('consume all shows confirmation dialog', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-consume');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 15000 });

      // Click consume all for Chicken Breast (has stock = 3 ctn)
      await page.getByTestId(`consume-all-${productMap['Chicken Breast']}`).click();

      // Verify the confirmation alert dialog appears with the expected message
      await expect(
        page.getByText('Are you sure you want to consume all remaining stock for this product?'),
      ).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });
});
