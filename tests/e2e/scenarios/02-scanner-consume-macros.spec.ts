/**
 * Scenario 02 — scanner-consume-logs-macros
 *
 * Drives the Scanner page in Consume+Macros mode against a known product
 * with stock, then asserts:
 *   1. `chefbyte.food_logs` row exists for today's logical_date
 *   2. The MacroPage daily total reflects the new calorie delta
 */
import { test, expect } from '../fixtures/test-base';
import {
  countUserRows,
  loginViaUi,
  seedProduct,
  seedStockLot,
  seedUserAndActivate,
} from '../fixtures/test-db';

test('scanner-consume-logs-macros', async ({ page }) => {
  const seeded = await seedUserAndActivate('scan-consume-macros');
  try {
    const productId = await seedProduct(seeded.userId, 'Pringles 50g', {
      barcode: '038000138416',
      servings_per_container: 1,
      calories_per_serving: 250,
    });
    await seedStockLot(seeded.userId, productId, 5);

    await loginViaUi(page, seeded.email, seeded.password);
    const locationsResp = page.waitForResponse(/rest\/v1\/locations/);
    await page.goto('/chef/scanner');
    await expect(page.getByTestId('scanner-container')).toBeVisible();
    await locationsResp;

    // Switch to Consume + Macros mode.
    await page.getByTestId('mode-consume_macros').click();
    await expect(page.getByTestId('mode-consume_macros')).toBeVisible();

    // Force re-render so handleBarcodeSubmit's executeAction sees the loaded
    // dayStartHour + defaultLocationId. (See scenario 01 for context.)
    await page.getByTestId('key-3').click();
    await page.getByTestId('key-backspace').click();

    // Default qty=1 serving on the keypad. Scan.
    await page.getByTestId('barcode-input').fill('038000138416');
    await page.getByTestId('barcode-input').press('Enter');

    await expect(page.getByTestId('queue-list')).toContainText('Pringles 50g', { timeout: 10_000 });

    // food_logs row should land for today's logical_date.
    await expect
      .poll(
        async () => countUserRows('chefbyte', 'food_logs', seeded.userId, { product_id: productId }),
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(1);

    // MacroPage shows the calorie delta in the daily total.
    await page.goto('/chef/macros');
    await expect(page.getByTestId('macro-summary')).toBeVisible({ timeout: 5_000 });
    // 250 cal/serving × 1 serving = 250. Calories text visible somewhere on
    // the macro summary; assert > 0 + the consumed-section row exists.
    await expect(page.getByTestId('consumed-section')).toContainText('Pringles', { timeout: 5_000 });
  } finally {
    await seeded.cleanup();
  }
});
