/**
 * Scenario 03 — scanner-consume-no-macros
 *
 * Drives the Scanner page in Consume / No-Macros mode (the "Eat (Skip)"
 * variant). Asserts:
 *   1. `chefbyte.stock_lots` qty decremented for the product's lot
 *   2. NO row inserted into `chefbyte.food_logs`
 *
 * The macro-skip path is the right behavior for items the user is consuming
 * but doesn't want to track (off-plan snacks, etc). Slipping a food_logs row
 * here is a regression that shifts macro totals for the day.
 */
import { test, expect } from '@playwright/test';
import { adminClient } from '../fixtures/env';
import {
  countUserRows,
  loginViaUi,
  seedProduct,
  seedStockLot,
  seedUserAndActivate,
} from '../fixtures/test-db';

test('scanner-consume-no-macros', async ({ page }) => {
  const seeded = await seedUserAndActivate('scan-consume-skip');
  try {
    const productId = await seedProduct(seeded.userId, 'Random Snack', {
      barcode: '111000111000',
      servings_per_container: 4,
      calories_per_serving: 120,
    });
    const lotId = await seedStockLot(seeded.userId, productId, 2);

    await loginViaUi(page, seeded.email, seeded.password);
    const locationsResp = page.waitForResponse(/rest\/v1\/locations/);
    await page.goto('/chef/scanner');
    await expect(page.getByTestId('scanner-container')).toBeVisible();
    await locationsResp;

    await page.getByTestId('mode-consume_no_macros').click();

    // Re-render to refresh handleBarcodeSubmit closure.
    await page.getByTestId('key-3').click();
    await page.getByTestId('key-backspace').click();

    await page.getByTestId('barcode-input').fill('111000111000');
    await page.getByTestId('barcode-input').press('Enter');

    await expect(page.getByTestId('queue-list')).toContainText('Random Snack', { timeout: 10_000 });

    // Assert the lot's qty decremented. consume_product RPC will subtract
    // qty=1 serving = 0.25 ctn, leaving qty_containers around 1.75.
    const admin = adminClient();
    await expect
      .poll(
        async () => {
          const { data } = await (admin as any)
            .schema('chefbyte')
            .from('stock_lots')
            .select('qty_containers')
            .eq('lot_id', lotId)
            .maybeSingle();
          return data ? Number(data.qty_containers) : 999;
        },
        { timeout: 10_000 },
      )
      .toBeLessThan(2);

    // CRITICAL invariant: NO food_logs row.
    const foodLogCount = await countUserRows('chefbyte', 'food_logs', seeded.userId, {
      product_id: productId,
    });
    expect(foodLogCount).toBe(0);
  } finally {
    await seeded.cleanup();
  }
});
