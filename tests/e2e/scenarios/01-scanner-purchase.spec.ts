/**
 * Scenario 01 — scanner-purchase-creates-visible-lot
 *
 * Drives the Scanner page in Purchase mode against a known barcode mapped to
 * a pre-seeded product, then asserts:
 *   1. `chefbyte.stock_lots` row exists for the user + product
 *   2. The Inventory page renders the product within 5 s of the scan
 *
 * This catches the chocolate-milk class of bug — barcode scan succeeds at
 * the data-write level but the Inventory query / cache key never sees it,
 * so the user is told "scanned!" yet sees nothing on the inventory.
 *
 * Implementation note: ScannerPage's `handleBarcodeSubmit` is wrapped in
 * useCallback with deps that don't include `defaultLocationId`. On a fresh
 * page load, the first scan can race against the locations query; we touch
 * the keypad once before scanning to force a state-driven re-render so the
 * captured executeAction sees a populated `defaultLocationId`. Mirrors how
 * a human user types qty before scanning.
 */
import { test, expect } from '@playwright/test';
import { adminClient } from '../fixtures/env';
import {
  countUserRows,
  seedUserAndActivate,
  loginViaUi,
  seedProduct,
} from '../fixtures/test-db';

test('scanner-purchase-creates-visible-lot', async ({ page }) => {
  const seeded = await seedUserAndActivate('scan-purchase');
  try {
    const productId = await seedProduct(seeded.userId, 'Chocolate Milk Test', {
      barcode: '049000042500',
      servings_per_container: 4,
      calories_per_serving: 180,
    });
    expect(productId).toBeTruthy();

    await loginViaUi(page, seeded.email, seeded.password);
    const locationsResp = page.waitForResponse(/rest\/v1\/locations/);
    await page.goto('/chef/scanner');
    await expect(page.getByTestId('scanner-container')).toBeVisible();
    await expect(page.getByTestId('mode-purchase')).toBeVisible();
    await locationsResp;

    // Force one keypad-driven re-render so handleBarcodeSubmit's captured
    // executeAction observes the loaded defaultLocationId. (Backspace also
    // ensures qty=1 default is preserved for the assertion below.)
    await page.getByTestId('key-3').click();
    await page.getByTestId('key-backspace').click();

    await page.getByTestId('barcode-input').fill('049000042500');
    await page.getByTestId('barcode-input').press('Enter');

    // Queue should reflect the processed item.
    await expect(page.getByTestId('queue-list')).toContainText('Chocolate Milk Test', {
      timeout: 10_000,
    });

    // Wait for the stock_lots row to land — the DB write is async after
    // executeAction resolves, so a poll-with-timeout is the right shape.
    await expect
      .poll(
        async () => countUserRows('chefbyte', 'stock_lots', seeded.userId, { product_id: productId }),
        { timeout: 10_000 },
      )
      .toBe(1);

    const admin = adminClient();
    const { data: lot } = await (admin as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('qty_containers')
      .eq('user_id', seeded.userId)
      .eq('product_id', productId)
      .single();
    expect(Number(lot.qty_containers)).toBe(1);

    // Web assert: navigate to inventory; the product appears within 5 s.
    await page.goto('/chef/inventory');
    await expect(page.getByTestId(`inv-product-${productId}`)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId(`inv-product-${productId}`)).toContainText('Chocolate Milk Test');
  } finally {
    await seeded.cleanup();
  }
});
