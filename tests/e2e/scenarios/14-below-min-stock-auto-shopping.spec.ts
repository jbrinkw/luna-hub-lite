/**
 * Scenario 14 — below-min-stock-auto-shopping
 *
 * A product with `min_stock_amount=2` and current stock=0 — clicking the
 * Shopping page's "Auto-add" button should add the product to the shopping
 * list with qty=ceil(min_stock_amount - currentStock) = 2.
 *
 * Catches: regressions in the auto-add path (rounding, products with
 * min_stock_amount=0 wrongly included, [MEAL] prefix exclusion drift).
 */
import { test, expect } from '@playwright/test';
import { adminClient } from '../fixtures/env';
import {
  loginViaUi,
  seedProduct,
  seedUserAndActivate,
} from '../fixtures/test-db';

test('below-min-stock-auto-shopping', async ({ page }) => {
  const seeded = await seedUserAndActivate('below-min-stock');
  try {
    const productId = await seedProduct(seeded.userId, 'Almost Out Item', {
      min_stock_amount: 2,
      servings_per_container: 4,
    });
    // Note: NO stock_lot — current stock = 0.

    await loginViaUi(page, seeded.email, seeded.password);
    await page.goto('/chef/shopping');
    await expect(page.getByTestId('to-buy-section')).toBeVisible({ timeout: 10_000 });

    // Click auto-add — adds the deficient product to the list.
    await page.getByTestId('auto-add-btn').click();

    // DB-side: shopping_list row inserted for the product with qty=2.
    const admin = adminClient();
    await expect
      .poll(
        async () => {
          const { data } = await (admin as any)
            .schema('chefbyte')
            .from('shopping_list')
            .select('qty_containers')
            .eq('user_id', seeded.userId)
            .eq('product_id', productId)
            .maybeSingle();
          return data ? Number(data.qty_containers) : 0;
        },
        { timeout: 5_000 },
      )
      .toBe(2);

    // Web-side: To-buy section shows the item.
    await expect(page.getByTestId('to-buy-list')).toContainText('Almost Out Item', {
      timeout: 5_000,
    });
  } finally {
    await seeded.cleanup();
  }
});
