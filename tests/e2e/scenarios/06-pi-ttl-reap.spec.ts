/**
 * Scenario 06 — pi-ttl-reap-removes-whole-lot
 *
 * Pi pickup with old in_flight_since → simulated TTL elapse → Pi emits a
 * `consumed` event matching the lot's pickup_event_id → cloud's whole-lot
 * branch zeroes qty + clears in_flight_since.
 *
 * Mocking the clock: rather than waiting 6 hours, we seed the lot with
 * in_flight_since 7 hours in the past, then drive a `consumed` event with
 * pi_event_id matching the lot's pickup_event_id. The cloud's
 * `apply_shelf_event` whole-lot branch (migration 20260427010000) recognizes
 * this pi_event_id == pickup_event_id case and zeroes the entire lot.
 *
 * Catches: TTL reaper landing on cloud → inventory shows the lot still at
 * its old qty (chocolate-milk-class but for the reap path).
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

test('pi-ttl-reap-removes-whole-lot', async ({ page }) => {
  const seeded = await seedUserAndActivate('pi-ttl-reap');
  try {
    const productId = await seedProduct(seeded.userId, 'TTL Reap Bottle', { net_weight_g: 500 });
    // Lot seeded already in-flight 7h ago + matching pickup_event_id.
    const pickupEventUuid = '11111111-2222-3333-4444-555555555555';
    const inFlightSince = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const lotId = await seedStockLot(seeded.userId, productId, 1, {
      in_flight_since: inFlightSince,
      pickup_event_id: pickupEventUuid,
    });

    const device = await seedPiDevice(seeded.userId);
    const scaleId = 'live_shelf_01';
    await seedScalePairing(device, scaleId, null, 'live_shelf');

    // Open inventory + verify pre-state: lot visible with In-flight badge.
    await loginViaUi(page, seeded.email, seeded.password);
    await page.goto('/chef/inventory');
    await expect(page.getByTestId(`inv-product-${productId}`)).toBeVisible({ timeout: 10_000 });

    // TTL reaper fires: Pi emits a consumed event with pi_event_id ==
    // pickup_event_id. Cloud's whole-lot branch zeroes qty regardless of
    // the (drifted) measured weight.
    const evResult = await postPiEvent(device, {
      kind: 'live_shelf',
      eventKind: 'consumed',
      scaleId,
      productId,
      deltaG: -150, // drifted measurement; whole-lot branch ignores this
      piEventId: pickupEventUuid,
    });
    expect(evResult.body.applied, JSON.stringify(evResult.body)).toBe(true);

    // DB state: qty=0, in_flight_since cleared, pickup_event_id cleared.
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
        r != null && Number(r.qty_containers) === 0 && r.in_flight_since == null && r.pickup_event_id == null,
      { description: 'whole-lot branch zeros lot' },
    );
    expect(Number(finalState.qty_containers)).toBe(0);

    // Web: refresh and confirm the lot is gone (qty=0 + no in-flight = hidden).
    await page.goto('/chef/scanner');
    await page.goto('/chef/inventory');
    await expect(page.getByTestId(`inv-product-${productId}`)).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await seeded.cleanup();
  }
});
