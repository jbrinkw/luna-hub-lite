/**
 * Scenario 04 — pi-pickup-shows-inflight-badge
 *
 * Pi simulator emits an `in_flight_pickup` event. Asserts:
 *   1. `chefbyte.stock_lots.in_flight_since` is set on the cloud row
 *   2. The InventoryPage renders the amber "In-flight" badge with
 *      "(picked up)" label within 5 s
 *
 * Catches the chocolate-milk-class bug at a different layer: cloud receives
 * Pi event but the React inventory query never reflects the in-flight state.
 */
import { test, expect } from '@playwright/test';
import { adminClient } from '../fixtures/env';
import { loginViaUi, seedProduct, seedStockLot, seedUserAndActivate } from '../fixtures/test-db';
import { postPiEvent, seedPiDevice, seedScalePairing, waitForCloudState } from '../fixtures/pi-simulator';

test('pi-pickup-shows-inflight-badge', async ({ page }) => {
  const seeded = await seedUserAndActivate('pi-pickup-badge');
  try {
    const productId = await seedProduct(seeded.userId, 'Pi Pickup Bottle', {
      net_weight_g: 750,
    });
    const lotId = await seedStockLot(seeded.userId, productId, 1);
    const device = await seedPiDevice(seeded.userId);
    const scaleId = 'live_shelf_01';
    // live_shelf kind requires product_id NULL on the pairing — the cloud
    // resolves product per-event from the classifier output in the body.
    await seedScalePairing(device, scaleId, null, 'live_shelf');

    // Pi emits a pickup. Cloud should stamp in_flight_since on the lot.
    const evResult = await postPiEvent(device, {
      kind: 'live_shelf',
      eventKind: 'in_flight_pickup',
      scaleId,
      productId,
      deltaG: -750,
    });
    expect(evResult.status, JSON.stringify(evResult.body)).toBe(200);
    expect(evResult.body.applied).toBe(true);

    // Cloud-side: in_flight_since populated.
    const admin = adminClient();
    await waitForCloudState(
      async () => {
        const { data } = await (admin as any)
          .schema('chefbyte')
          .from('stock_lots')
          .select('in_flight_since')
          .eq('lot_id', lotId)
          .maybeSingle();
        return data;
      },
      (row) => row != null && row.in_flight_since != null,
      { timeoutMs: 5000, description: 'in_flight_since stamped' },
    );

    // Web-side: inventory page shows the in-flight badge.
    await loginViaUi(page, seeded.email, seeded.password);
    await page.goto('/chef/inventory');
    await expect(page.getByTestId(`inv-product-${productId}`)).toBeVisible({ timeout: 10_000 });

    // The amber In-flight badge renders. (The "(picked up)" label only
    // replaces the numeric qty once the lot reaches qty=0 — that's a
    // separate scenario, see #6 ttl-reap.)
    const badges = page
      .getByTestId(`inv-product-${productId}`)
      .getByTestId('inflight-badge');
    await expect(badges).toBeVisible({ timeout: 5_000 });
    await expect(badges).toContainText(/in.?flight/i);
  } finally {
    await seeded.cleanup();
  }
});
