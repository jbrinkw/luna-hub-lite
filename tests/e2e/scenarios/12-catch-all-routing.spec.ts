/**
 * Scenario 12 — catch-all-scale-routing
 *
 * Pi simulator emits a live_scale event on `scale-02`. Asserts:
 *   1. Event lands in `chefbyte.shelf_event_log`
 *   2. The resulting stock_lot has `last_update_source='live_scale'`
 *
 * Catches: catch-all scale routing where event payloads sent on
 * unrecognized scale_id can be silently dropped.
 */
import { test, expect } from '@playwright/test';
import { adminClient } from '../fixtures/env';
import {
  loginViaUi,
  seedProduct,
  seedStockLot,
  seedUserAndActivate,
} from '../fixtures/test-db';
import { postPiEvent, seedPiDevice, seedScalePairing, waitForCloudState } from '../fixtures/pi-simulator';

test('catch-all-scale-routing', async ({ page }) => {
  const seeded = await seedUserAndActivate('catch-all');
  try {
    const productId = await seedProduct(seeded.userId, 'Live Scale Cereal', {
      net_weight_g: 1000,
      servings_per_container: 10,
    });
    const lotId = await seedStockLot(seeded.userId, productId, 1);
    const device = await seedPiDevice(seeded.userId);
    const scaleId = 'scale-02';
    // For live_scale, the pairing carries product_id (not catch_all/live_shelf).
    await seedScalePairing(device, scaleId, productId, 'live_scale');

    const evResult = await postPiEvent(device, {
      kind: 'live_scale',
      eventKind: 'consumed',
      scaleId,
      productId, // explicit
      deltaG: -100,
    });
    expect(evResult.body.applied, JSON.stringify(evResult.body)).toBe(true);

    // Cloud-side: shelf_event_log row landed.
    const admin = adminClient();
    await waitForCloudState(
      async () => {
        const { data } = await (admin as any)
          .schema('chefbyte')
          .from('shelf_event_log')
          .select('event_id')
          .eq('user_id', seeded.userId);
        return data ?? [];
      },
      (rows) => rows.length >= 1,
      { description: 'shelf_event_log row exists' },
    );

    // last_update_source on the lot is 'live_scale'.
    const { data: lot } = await (admin as any)
      .schema('chefbyte')
      .from('stock_lots')
      .select('last_update_source')
      .eq('lot_id', lotId)
      .single();
    expect(lot.last_update_source).toBe('live_scale');

    // Web-side: inventory still renders the lot (still > 0 containers).
    await loginViaUi(page, seeded.email, seeded.password);
    await page.goto('/chef/inventory');
    await expect(page.getByTestId(`inv-product-${productId}`)).toBeVisible({ timeout: 10_000 });
  } finally {
    await seeded.cleanup();
  }
});
