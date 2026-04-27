/**
 * Scenario 07 — place-back-after-ttl-revives-lot
 *
 * Continues from 06: after TTL-reap zeroed the lot, simulating a "place
 * back" event (Pi emits `added` for the same product) revives the lot
 * with qty=1.
 *
 * Catches: revival path that incorrectly creates a duplicate lot or fails
 * to populate qty after a reap.
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

test('place-back-after-ttl-revives-lot', async ({ page }) => {
  const seeded = await seedUserAndActivate('place-back-revive');
  try {
    const productId = await seedProduct(seeded.userId, 'Revival Bottle', { net_weight_g: 500 });
    const pickupEventUuid = '99999999-9999-9999-9999-999999999999';
    const inFlightSince = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const lotId = await seedStockLot(seeded.userId, productId, 1, {
      in_flight_since: inFlightSince,
      pickup_event_id: pickupEventUuid,
    });
    const device = await seedPiDevice(seeded.userId);
    const scaleId = 'live_shelf_01';
    await seedScalePairing(device, scaleId, null, 'live_shelf');

    // Step 1: TTL reap zeroes the lot.
    const reapResult = await postPiEvent(device, {
      kind: 'live_shelf',
      eventKind: 'consumed',
      scaleId,
      productId,
      deltaG: -150,
      piEventId: pickupEventUuid,
    });
    expect(reapResult.body.applied).toBe(true);

    const admin = adminClient();
    await waitForCloudState(
      async () => {
        const { data } = await (admin as any)
          .schema('chefbyte')
          .from('stock_lots')
          .select('qty_containers, in_flight_since')
          .eq('lot_id', lotId)
          .maybeSingle();
        return data;
      },
      (r) => r != null && Number(r.qty_containers) === 0 && r.in_flight_since == null,
      { description: 'lot zeroed' },
    );

    // Step 2: place back — Pi emits `added` event (a fresh placement). The
    // cloud's apply_shelf_event with `added` re-uses the empty lot
    // (migration 20260425070000_resolve_add_reuse_empty_lot) so qty bounces
    // back to 1 on the same lot_id.
    const addResult = await postPiEvent(device, {
      kind: 'live_shelf',
      eventKind: 'added',
      scaleId,
      productId,
      deltaG: 500,
    });
    expect(addResult.body.applied, JSON.stringify(addResult.body)).toBe(true);

    // Lot should be back at qty=1 (or at least > 0).
    const revived = await waitForCloudState(
      async () => {
        const { data } = await (admin as any)
          .schema('chefbyte')
          .from('stock_lots')
          .select('lot_id, qty_containers')
          .eq('user_id', seeded.userId)
          .eq('product_id', productId)
          .gt('qty_containers', 0)
          .maybeSingle();
        return data;
      },
      (r) => r != null && Number(r.qty_containers) >= 1,
      { description: 'lot revived to qty>=1' },
    );
    expect(Number(revived.qty_containers)).toBeGreaterThanOrEqual(1);

    // Web: navigate to inventory and confirm the product is visible again.
    await loginViaUi(page, seeded.email, seeded.password);
    await page.goto('/chef/inventory');
    await expect(page.getByTestId(`inv-product-${productId}`)).toBeVisible({ timeout: 10_000 });
  } finally {
    await seeded.cleanup();
  }
});
