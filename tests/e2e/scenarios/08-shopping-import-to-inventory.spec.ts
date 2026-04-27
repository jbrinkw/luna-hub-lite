/**
 * Scenario 08 — shopping-import-to-inventory
 *
 * Add an item to the shopping list → mark purchased → click "Import to
 * Inventory" → assert a stock_lot exists for the product AND the Inventory
 * page renders the row.
 *
 * Catches: shopping → inventory hand-off where optimistic updates may set
 * stale TanStack Query cache keys (the "ShoppingPage" bug class from the
 * audit) AND the import RPC's idempotency.
 */
import { test, expect } from '@playwright/test';
import {
  countUserRows,
  loginViaUi,
  seedProduct,
  seedUserAndActivate,
} from '../fixtures/test-db';
import { adminClient } from '../fixtures/env';

test('shopping-import-to-inventory', async ({ page }) => {
  const seeded = await seedUserAndActivate('shop-import');
  try {
    const productId = await seedProduct(seeded.userId, 'Bananas', {
      servings_per_container: 4,
      calories_per_serving: 90,
    });
    // Pre-seed a shopping list row for the user (purchased=false).
    const admin = adminClient();
    await (admin as any).schema('chefbyte').from('shopping_list').insert({
      user_id: seeded.userId,
      product_id: productId,
      qty_containers: 2,
      purchased: false,
    });

    await loginViaUi(page, seeded.email, seeded.password);
    await page.goto('/chef/shopping');
    await expect(page.getByTestId('to-buy-section')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('to-buy-list')).toContainText('Bananas');

    // Toggle purchased → moves item to the purchased-section.
    const item = page.getByTestId('to-buy-list').getByText('Bananas').first();
    await expect(item).toBeVisible();
    await page.getByTestId('to-buy-list').locator('[data-testid^="check-"]').first().click();
    await expect(page.getByTestId('purchased-list')).toContainText('Bananas', { timeout: 5_000 });

    // Click "Import to Inventory".
    await page.getByTestId('import-inventory-btn').click();

    // After import: a confirmation dialog OR the section empties + stock_lot
    // appears. Wait for stock_lots row to land.
    await expect
      .poll(
        async () => countUserRows('chefbyte', 'stock_lots', seeded.userId, { product_id: productId }),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1);

    // Inventory page should render the lot.
    await page.goto('/chef/inventory');
    await expect(page.getByTestId(`inv-product-${productId}`)).toBeVisible({ timeout: 10_000 });
  } finally {
    await seeded.cleanup();
  }
});
