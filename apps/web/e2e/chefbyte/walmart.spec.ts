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

  test('edit existing price updates value', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'walmart-edit-price');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chef = (client as any).schema('chefbyte');

      // Pick first product and set it up with no walmart_link and no price
      // so it appears in the missing-prices section
      const productName = Object.keys(productMap)[0];
      const productId = productMap[productName];

      // Ensure no walmart_link so it shows in missing-prices
      await chef.from('products').update({ walmart_link: null, price: null }).eq('product_id', productId);

      await page.goto('/chef/walmart');

      const missingPrices = page.getByTestId('missing-prices-section');
      await expect(missingPrices).toBeVisible();

      // Fill in initial price of 3.49
      const priceInput = page.getByTestId(`price-input-${productId}`).locator('input');
      await priceInput.fill('3.49');
      await page.getByTestId(`save-price-${productId}`).click();

      // Product disappears from missing prices after save
      await expect(page.getByTestId(`price-item-${productId}`)).toBeHidden();

      // Verify DB has the price
      const { data: afterFirst } = await chef.from('products').select('price').eq('product_id', productId).single();
      expect(Number(afterFirst.price)).toBeCloseTo(3.49, 1);

      // Now reset price to null via DB so it reappears in missing prices
      await chef.from('products').update({ price: null }).eq('product_id', productId);

      // Reload page to pick up the change
      await page.goto('/chef/walmart');
      await expect(page.getByTestId('missing-prices-section')).toBeVisible();

      // Wait for the specific product's price item to reappear in missing-prices section
      await expect(page.getByTestId(`price-item-${productId}`)).toBeVisible({ timeout: 10000 });

      // Fill in new price of 5.99
      const priceInput2 = page.getByTestId(`price-input-${productId}`).locator('input');
      await expect(priceInput2).toBeVisible({ timeout: 5000 });
      await priceInput2.fill('5.99');
      await page.getByTestId(`save-price-${productId}`).click();

      // Wait for the price item to disappear (confirming save completed)
      await expect(page.getByTestId(`price-item-${productId}`)).toBeHidden({ timeout: 5000 });

      // Verify DB has updated price
      const { data: afterSecond } = await chef.from('products').select('price').eq('product_id', productId).single();
      expect(Number(afterSecond.price)).toBeCloseTo(5.99, 1);
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

      // Verify the product is listed in missing links
      const linkItem = page.getByTestId(`link-item-${productId}`);
      await expect(linkItem).toBeVisible();

      // Paste a Walmart URL into the input
      const urlInput = page.getByTestId(`url-input-${productId}`).locator('input');
      await urlInput.fill('https://www.walmart.com/ip/Great-Value-Chicken-Breast/123456789');

      // Click save URL
      await page.getByTestId(`save-url-${productId}`).click();

      // Product should disappear from missing links
      await expect(linkItem).toBeHidden();

      // Verify DB has the cleaned walmart_link
      const { data: product } = await chef.from('products').select('walmart_link').eq('product_id', productId).single();
      expect(product.walmart_link).toBe('https://www.walmart.com/ip/Great-Value-Chicken-Breast/123456789');
    } finally {
      await cleanup();
    }
  });
});
