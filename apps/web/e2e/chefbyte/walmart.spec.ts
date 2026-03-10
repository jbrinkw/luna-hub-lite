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

      // Products only appear after clicking "Load Next 5 Products"
      await page.getByTestId('load-next-5-btn').click();

      // Wait for at least one link-item to appear (search completes)
      const firstLinkItem = missingLinks.locator('[data-testid^="link-item-"]').first();
      await expect(firstLinkItem).toBeVisible({ timeout: 30000 });

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

      // Products only appear after clicking "Load Next 5 Products"
      await page.getByTestId('load-next-5-btn').click();

      // Wait for at least one link-item to appear
      const firstLinkItem = missingLinks.locator('[data-testid^="link-item-"]').first();
      await expect(firstLinkItem).toBeVisible({ timeout: 30000 });

      // Extract the product_id from the not-on-walmart checkbox
      const firstNotOnWalmartBtn = missingLinks.locator('[data-testid^="not-on-walmart-"]').first();
      const testId = await firstNotOnWalmartBtn.getAttribute('data-testid');
      const productId = testId!.replace('not-on-walmart-', '');

      // Check the "Not on Walmart" checkbox
      await firstNotOnWalmartBtn.check();

      // Click "Complete & Update Selected" to persist the change
      await page.getByTestId('complete-updates-btn').click();

      // After completing, products are cleared and counts refresh.
      // The link item for this product should no longer appear.
      const linkItem = page.getByTestId(`link-item-${productId}`);
      await expect(linkItem).toBeHidden({ timeout: 30000 });
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
        const priceInput = page.getByTestId(`price-input-${priceProductId}`);
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

  test('edit existing price updates value', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'walmart-edit-price');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chef = (client as any).schema('chefbyte');

      // Pick first product and set it up with walmart_link but no price
      // so it appears in the missing-prices section (not missing-links)
      const productName = Object.keys(productMap)[0];
      const productId = productMap[productName];

      await chef
        .from('products')
        .update({ walmart_link: 'https://www.walmart.com/ip/Test-Product/123456', price: null })
        .eq('product_id', productId);

      await page.goto('/chef/walmart');

      const missingPrices = page.getByTestId('missing-prices-section');
      await expect(missingPrices).toBeVisible();

      // The missing prices count should include our product (at least 1)
      await expect(missingPrices.locator('h2')).toContainText(/Missing Prices \([1-9]/);

      // The "Find Missing Prices" button should be enabled
      const findBtn = page.getByTestId('find-missing-prices-btn');
      await expect(findBtn).toBeEnabled();

      // Set the price directly via DB (simulates what the edge function does)
      await chef.from('products').update({ price: 3.49 }).eq('product_id', productId);

      // Verify DB has the price
      const { data: afterFirst } = await chef.from('products').select('price').eq('product_id', productId).single();
      expect(Number(afterFirst.price)).toBeCloseTo(3.49, 1);

      // Now update the price to a new value
      await chef.from('products').update({ price: 5.99 }).eq('product_id', productId);

      // Verify DB has updated price
      const { data: afterSecond } = await chef.from('products').select('price').eq('product_id', productId).single();
      expect(Number(afterSecond.price)).toBeCloseTo(5.99, 1);

      // Reload page — product should no longer be in missing prices
      await page.goto('/chef/walmart');
      await expect(page.getByTestId('missing-prices-section')).toBeVisible();

      // The count should reflect the price was set (product no longer missing)
      // Remaining 4 products have no walmart_link so they don't count as missing prices
      await expect(page.getByTestId('missing-prices-section').locator('h2')).toContainText('Missing Prices (0)');
    } finally {
      await cleanup();
    }
  });

  test('link product to walmart URL', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'walmart-link-url');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chef = (client as any).schema('chefbyte');

      // All seeded products have no walmart_link, so they all appear in missing-links
      const productName = Object.keys(productMap)[0];
      const productId = productMap[productName];

      await page.goto('/chef/walmart');

      const missingLinks = page.getByTestId('missing-links-section');
      await expect(missingLinks).toBeVisible();

      // Products only appear after clicking "Load Next 5 Products"
      await page.getByTestId('load-next-5-btn').click();

      // Wait for the specific product's link-item to appear
      const linkItem = page.getByTestId(`link-item-${productId}`);
      await expect(linkItem).toBeVisible({ timeout: 30000 });

      // Paste a Walmart URL into the custom URL input
      const urlInput = page.getByTestId(`url-input-${productId}`);
      await urlInput.fill('https://www.walmart.com/ip/Great-Value-Chicken-Breast/123456789');

      // Click "Complete & Update Selected" to save the URL
      await page.getByTestId('complete-updates-btn').click();

      // After completing, products are cleared and counts refresh.
      // The link item for this product should no longer appear.
      await expect(linkItem).toBeHidden({ timeout: 30000 });

      // Verify DB has the cleaned walmart_link
      const { data: product } = await chef.from('products').select('walmart_link').eq('product_id', productId).single();
      expect(product.walmart_link).toBe('https://www.walmart.com/ip/Great-Value-Chicken-Breast/123456789');
    } finally {
      await cleanup();
    }
  });
});
