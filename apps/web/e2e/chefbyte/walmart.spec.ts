import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData } from '../helpers/seed';

test.describe('ChefByte Walmart', () => {
  test('walmart page loads with missing links section', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'walmart-load');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/walmart');

      const missingLinks = page.getByTestId('missing-links-section');
      await expect(missingLinks).toBeVisible();

      // Products without walmart_link should be listed
      const linkItems = missingLinks.locator('[data-testid^="link-item-"]');
      const count = await linkItems.count();
      expect(count).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  test('not-on-walmart button marks product', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'walmart-not-on');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/walmart');

      const missingLinks = page.getByTestId('missing-links-section');
      await expect(missingLinks).toBeVisible();

      // Get the first product's not-on-walmart button
      const firstLinkItem = missingLinks.locator('[data-testid^="link-item-"]').first();
      await expect(firstLinkItem).toBeVisible();

      // Extract the product_id from the test id
      const firstNotOnWalmartBtn = missingLinks.locator('[data-testid^="not-on-walmart-"]').first();
      const testId = await firstNotOnWalmartBtn.getAttribute('data-testid');
      const productId = testId!.replace('not-on-walmart-', '');

      // Click not-on-walmart
      await firstNotOnWalmartBtn.click();

      // The link item for this product should disappear
      const linkItem = page.getByTestId(`link-item-${productId}`);
      await expect(linkItem).toBeHidden();
    } finally {
      await cleanup();
    }
  });

  test('missing prices section shows products needing prices', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'walmart-prices');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/walmart');

      const missingPrices = page.getByTestId('missing-prices-section');
      await expect(missingPrices).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('can save a price for a product', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'walmart-save-price');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      // Seed a product with a walmart_link but no price so it appears in missing prices
      const productId = Object.keys(productMap)[0];
      await client.from('products').update({ walmart_link: 'https://walmart.com/test-product' }).eq('id', productId);

      await page.goto('/chef/walmart');

      const missingPrices = page.getByTestId('missing-prices-section');
      await expect(missingPrices).toBeVisible();

      // Check if any price items exist
      const priceItems = missingPrices.locator('[data-testid^="price-item-"]');
      const count = await priceItems.count();

      if (count > 0) {
        // Get the first price item's product id
        const firstPriceItem = priceItems.first();
        const priceTestId = await firstPriceItem.getAttribute('data-testid');
        const priceProductId = priceTestId!.replace('price-item-', '');

        // Fill in the price
        const priceInput = page.getByTestId(`price-input-${priceProductId}`).locator('input');
        await priceInput.fill('4.99');

        // Save the price
        const saveBtn = page.getByTestId(`save-price-${priceProductId}`);
        await saveBtn.click();

        // Product should disappear from missing prices
        const priceItem = page.getByTestId(`price-item-${priceProductId}`);
        await expect(priceItem).toBeHidden();
      }
    } finally {
      await cleanup();
    }
  });
});
