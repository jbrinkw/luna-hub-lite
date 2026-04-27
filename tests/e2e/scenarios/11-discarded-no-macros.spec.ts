/**
 * Scenario 11 — discarded-event-no-macros
 *
 * Pi emits a `discarded` event (manual remove button on the Pi). Cloud
 * should:
 *   1. Zero the lot (qty=0, in_flight_since=NULL, pickup_event_id=NULL)
 *   2. NOT write any food_logs row (manual discard = no macro tracking)
 *
 * Catches: a "discarded" leak that mirrors discarded items as consumed and
 * inflates the user's daily macro total.
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
import { postPiEvent, seedPiDevice, seedScalePairing, waitForCloudState } from '../fixtures/pi-simulator';

test('discarded-event-no-macros', async ({ page }) => {
  const seeded = await seedUserAndActivate('pi-discarded');
  try {
    const productId = await seedProduct(seeded.userId, 'Spilled Item', { net_weight_g: 500 });
    const inFlightSince = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const pickupEventUuid = '12345678-1234-1234-1234-123456789012';
    const lotId = await seedStockLot(seeded.userId, productId, 1, {
      in_flight_since: inFlightSince,
      pickup_event_id: pickupEventUuid,
    });
    const device = await seedPiDevice(seeded.userId);
    const scaleId = 'live_shelf_01';
    await seedScalePairing(device, scaleId, null, 'live_shelf');

    const evResult = await postPiEvent(device, {
      kind: 'live_shelf',
      eventKind: 'discarded',
      scaleId,
      productId,
      deltaG: -500,
      piEventId: pickupEventUuid,
    });
    expect(evResult.body.applied, JSON.stringify(evResult.body)).toBe(true);

    const admin = adminClient();
    const finalState = await waitForCloudState(
      async () => {
        const { data } = await (admin as any)
          .schema('chefbyte')
          .from('stock_lots')
          .select('qty_containers, in_flight_since, pickup_event_id')
          .eq('lot_id', lotId)
          .maybeSingle();
        return data;
      },
      (r) =>
        r != null &&
        Number(r.qty_containers) === 0 &&
        r.in_flight_since == null &&
        r.pickup_event_id == null,
      { description: 'discarded zeros qty + clears in-flight markers' },
    );
    expect(Number(finalState.qty_containers)).toBe(0);

    // CRITICAL: NO food_logs row for the discarded item.
    const foodLogCount = await countUserRows('chefbyte', 'food_logs', seeded.userId, {
      product_id: productId,
    });
    expect(foodLogCount, 'no macros for discarded').toBe(0);

    // Web: macros page shows no consumed entry for the discarded product.
    await loginViaUi(page, seeded.email, seeded.password);
    await page.goto('/chef/macros');
    await expect(page.getByTestId('macro-summary')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('consumed-section')).not.toContainText('Spilled Item', {
      timeout: 3_000,
    });
  } finally {
    await seeded.cleanup();
  }
});
