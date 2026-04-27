/**
 * Event Viewer E2E — /chef/events
 *
 * Covers the four required scenarios:
 *   1. Classifier events render with product name + macros.
 *   2. Edit servings → derived macros recompute → save → DB has an
 *      override row and food_logs reflect the override.
 *   3. Void an event → row greys out, "Voided" badge shows, stock +
 *      food_logs back out.
 *   4. Pi-offline path → image onError fires → "Pi offline" banner
 *      appears.
 *
 * Uses the standard seedFullAndLogin helper. Pi rows (shelf_event_log,
 * live_shelf_devices, food_logs) are seeded directly via service-role
 * admin client so we don't depend on the shelf-ingest edge fn.
 */

import { test, expect, type Page } from '@playwright/test';
import { type SupabaseClient } from '@supabase/supabase-js';
import { seedFullAndLogin } from '../helpers/seed';
import { admin } from '../helpers/constants';

function chef(client: SupabaseClient) {
  return (client as any).schema('chefbyte');
}

/** Seed a product + location + stock lot. Returns ids. */
async function seedProductAndLot(userId: string, delta: { productName: string }) {
  // Product with enough fields for the viewer to compute derived macros.
  const { data: prod, error: prodErr } = await chef(admin)
    .from('products')
    .insert({
      user_id: userId,
      name: delta.productName,
      net_weight_g: 100,
      servings_per_container: 2,
      calories_per_serving: 200,
      protein_per_serving: 20,
      carbs_per_serving: 10,
      fat_per_serving: 5,
      min_stock_amount: 1,
    })
    .select('product_id')
    .single();
  if (prodErr || !prod) throw new Error(`seedProduct failed: ${prodErr?.message}`);

  const { data: loc } = await chef(admin)
    .from('locations')
    .select('location_id')
    .eq('user_id', userId)
    .limit(1)
    .single();
  if (!loc) throw new Error('no location for user');

  const { data: lot, error: lotErr } = await chef(admin)
    .from('stock_lots')
    .insert({
      user_id: userId,
      product_id: prod.product_id,
      location_id: loc.location_id,
      qty_containers: 4,
      last_update_source: 'live_shelf',
      last_update_ts: new Date().toISOString(),
    })
    .select('lot_id')
    .single();
  if (lotErr || !lot) throw new Error(`seedLot failed: ${lotErr?.message}`);

  return { productId: prod.product_id as string, lotId: lot.lot_id as string };
}

/** Seed a device + shelf_event_log row + food_logs row mimicking a Pi event. */
async function seedShelfEvent(
  userId: string,
  productId: string,
  lotId: string,
  opts: { clientEventId: string; piEventId: string; lanIp?: string; occurredAt?: string },
) {
  const { data: dev, error: devErr } = await chef(admin)
    .from('live_shelf_devices')
    .insert({
      user_id: userId,
      device_name: 'e2e-device',
      import_key_hash: `e2e-hash-${Math.random().toString(36).slice(2)}`,
      lan_ip: opts.lanIp ?? '192.168.0.181',
    })
    .select('device_id')
    .single();
  if (devErr || !dev) throw new Error(`seedDevice failed: ${devErr?.message}`);

  const occurred = opts.occurredAt ?? new Date().toISOString();
  const { error: evErr } = await chef(admin)
    .from('shelf_event_log')
    .insert({
      user_id: userId,
      device_id: dev.device_id,
      client_event_id: opts.clientEventId,
      pi_event_id: opts.piEventId,
      payload: {
        scale_id: 'scale-01',
        kind: 'live_shelf',
        event_kind: 'consumed',
        product_id: productId,
        delta_g: -100,
        occurred_at: occurred,
      },
      applied: true,
      resolved_lot_id: lotId,
      reason: 'decremented',
    });
  if (evErr) throw new Error(`seedEvent failed: ${evErr.message}`);

  // Decrement the lot to mimic apply_shelf_event
  await chef(admin).from('stock_lots').update({ qty_containers: 3 }).eq('lot_id', lotId);

  // Food log tagged to the event
  const { error: flErr } = await chef(admin)
    .from('food_logs')
    .insert({
      user_id: userId,
      product_id: productId,
      logical_date: occurred.slice(0, 10),
      qty_consumed: 2,
      unit: 'serving',
      calories: 400,
      carbs: 20,
      protein: 40,
      fat: 10,
      source_client_event_id: opts.clientEventId,
    });
  if (flErr) throw new Error(`seedFoodLog failed: ${flErr.message}`);

  return { deviceId: dev.device_id as string };
}

async function gotoEvents(page: Page) {
  await page.goto('/chef/events');
  await expect(page.getByTestId('event-viewer-page')).toBeVisible({ timeout: 30_000 });
}

test.describe('Event Viewer', () => {
  test('1. events render with product name + macros', async ({ page }) => {
    const { userId, cleanup } = await seedFullAndLogin(page, 'event-viewer-1');
    try {
      const { productId, lotId } = await seedProductAndLot(userId, {
        productName: 'Test Classifier Apple',
      });
      await seedShelfEvent(userId, productId, lotId, {
        clientEventId: `ev-${userId}-1`,
        piEventId: 'pi-evt-1',
      });

      await gotoEvents(page);

      const row = page.getByTestId(`event-row-ev-${userId}-1`);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row.getByTestId('event-product-name')).toHaveText('Test Classifier Apple');
      await expect(row.getByTestId('event-cal')).toContainText('400');
    } finally {
      await cleanup();
    }
  });

  test('2. edit servings → macros recompute → save writes override', async ({ page }) => {
    const { userId, client, cleanup } = await seedFullAndLogin(page, 'event-viewer-2');
    try {
      const { productId, lotId } = await seedProductAndLot(userId, {
        productName: 'Editable Product',
      });
      const clientEventId = `ev-${userId}-2`;
      await seedShelfEvent(userId, productId, lotId, {
        clientEventId,
        piEventId: 'pi-evt-2',
      });

      await gotoEvents(page);

      const row = page.getByTestId(`event-row-${clientEventId}`);
      await row.getByTestId('toggle-edit-btn').click();
      await expect(row.getByTestId('edit-panel')).toBeVisible();

      // Set servings=1 → derived cal should show 200
      const servingsInput = row.getByTestId('servings-input');
      await servingsInput.fill('1');
      await expect(row.getByTestId('derived-cal')).toHaveText('200');

      await row.getByTestId('save-override-btn').click();

      // Override row should appear in DB
      await expect
        .poll(
          async () => {
            const { data } = await chef(client)
              .from('event_overrides')
              .select('macros_servings_override')
              .eq('client_event_id', clientEventId)
              .maybeSingle();
            return data?.macros_servings_override;
          },
          { timeout: 15_000 },
        )
        .toBe(1);

      // food_logs reflects the override (200 cal)
      await expect
        .poll(
          async () => {
            const { data } = await chef(client)
              .from('food_logs')
              .select('calories')
              .eq('source_client_event_id', clientEventId)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            return data?.calories;
          },
          { timeout: 15_000 },
        )
        .toBe(200);
    } finally {
      await cleanup();
    }
  });

  test('3. void → greyed out + badge + stock/macros backed out', async ({ page }) => {
    const { userId, client, cleanup } = await seedFullAndLogin(page, 'event-viewer-3');
    try {
      const { productId, lotId } = await seedProductAndLot(userId, {
        productName: 'Voidable Product',
      });
      const clientEventId = `ev-${userId}-3`;
      await seedShelfEvent(userId, productId, lotId, {
        clientEventId,
        piEventId: 'pi-evt-3',
      });

      await gotoEvents(page);

      const row = page.getByTestId(`event-row-${clientEventId}`);
      await row.getByTestId('void-btn').click();

      await expect(row.getByTestId('voided-badge')).toBeVisible({ timeout: 15_000 });

      // Stock restored to 4
      await expect
        .poll(
          async () => {
            const { data } = await chef(client)
              .from('stock_lots')
              .select('qty_containers')
              .eq('lot_id', lotId)
              .maybeSingle();
            return data?.qty_containers;
          },
          { timeout: 15_000 },
        )
        .toBe(4);

      // food_logs rows removed
      await expect
        .poll(
          async () => {
            const { count } = await chef(client)
              .from('food_logs')
              .select('log_id', { count: 'exact', head: true })
              .eq('source_client_event_id', clientEventId);
            return count;
          },
          { timeout: 15_000 },
        )
        .toBe(0);
    } finally {
      await cleanup();
    }
  });

  test('4. Pi-offline image error triggers banner', async ({ page }) => {
    const { userId, cleanup } = await seedFullAndLogin(page, 'event-viewer-4');
    try {
      const { productId, lotId } = await seedProductAndLot(userId, {
        productName: 'Offline Pi Product',
      });
      // Use an unreachable LAN IP so image loads 404/timeout.
      await seedShelfEvent(userId, productId, lotId, {
        clientEventId: `ev-${userId}-4`,
        piEventId: 'pi-evt-4',
        lanIp: '10.255.255.254',
      });

      await gotoEvents(page);

      // Images hit the bogus IP → onError fires → banner mounts.
      await expect(page.getByTestId('pi-offline-banner')).toBeVisible({ timeout: 30_000 });
    } finally {
      await cleanup();
    }
  });

  test('5. independent stock + macros fields', async ({ page }) => {
    const { userId, client, cleanup } = await seedFullAndLogin(page, 'event-viewer-5');
    try {
      const { productId, lotId } = await seedProductAndLot(userId, {
        productName: 'Independent Fields Product',
      });
      const clientEventId = `ev-${userId}-5`;
      await seedShelfEvent(userId, productId, lotId, {
        clientEventId,
        piEventId: 'pi-evt-5',
      });

      await gotoEvents(page);

      const row = page.getByTestId(`event-row-${clientEventId}`);
      await row.getByTestId('toggle-edit-btn').click();
      await expect(row.getByTestId('edit-panel')).toBeVisible();

      // Stock field = -2 (consumed 2 containers), macros field = 5 svg.
      await row.getByTestId('stock-qty-input').fill('-2');
      await row.getByTestId('servings-input').fill('5');
      await row.getByTestId('save-override-btn').click();

      // stock_lots should reflect -2 delta (seed lot 3 + prior -1 backed out
      // → 4 then -2 = 2).
      await expect
        .poll(
          async () => {
            const { data } = await chef(client)
              .from('stock_lots')
              .select('qty_containers')
              .eq('lot_id', lotId)
              .maybeSingle();
            return data?.qty_containers;
          },
          { timeout: 15_000 },
        )
        .toBe(2);

      // food_logs reflects 5 svg × 200 cal = 1000.
      await expect
        .poll(
          async () => {
            const { data } = await chef(client)
              .from('food_logs')
              .select('calories,qty_consumed')
              .eq('source_client_event_id', clientEventId)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            return data;
          },
          { timeout: 15_000 },
        )
        .toMatchObject({ calories: 1000, qty_consumed: 5 });

      // Edited chip should render now that an override is present.
      await expect(row.getByTestId('edited-badge')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('6. toggle macros off → no food_logs, stock still changes', async ({ page }) => {
    const { userId, client, cleanup } = await seedFullAndLogin(page, 'event-viewer-6');
    try {
      const { productId, lotId } = await seedProductAndLot(userId, {
        productName: 'Spoiled Food Product',
      });
      const clientEventId = `ev-${userId}-6`;
      await seedShelfEvent(userId, productId, lotId, {
        clientEventId,
        piEventId: 'pi-evt-6',
      });

      await gotoEvents(page);

      const row = page.getByTestId(`event-row-${clientEventId}`);
      await row.getByTestId('toggle-edit-btn').click();

      // Flip the macros toggle off in the editor.
      await row.getByTestId('edit-macros-toggle').click();
      await row.getByTestId('save-override-btn').click();

      // food_logs row removed
      await expect
        .poll(
          async () => {
            const { count } = await chef(client)
              .from('food_logs')
              .select('log_id', { count: 'exact', head: true })
              .eq('source_client_event_id', clientEventId);
            return count;
          },
          { timeout: 15_000 },
        )
        .toBe(0);

      // Stock still decremented (3 as seeded — back out +1, re-apply -1 → 3).
      await expect
        .poll(
          async () => {
            const { data } = await chef(client)
              .from('stock_lots')
              .select('qty_containers')
              .eq('lot_id', lotId)
              .maybeSingle();
            return data?.qty_containers;
          },
          { timeout: 15_000 },
        )
        .toBe(3);

      // "Macros off" chip rendered in list header.
      await expect(row.getByTestId('macros-off-badge')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  // ────────────────────────────────────────────────────────────
  // Feature: rejected events get a retry-action badge + deep-link.
  // ────────────────────────────────────────────────────────────
  test('8. applied=false event shows needs-action badge + Configure pairing deep-link', async ({ page }) => {
    const { userId, cleanup } = await seedFullAndLogin(page, 'event-viewer-8');
    try {
      const { productId } = await seedProductAndLot(userId, {
        productName: 'Rejected Event Product',
      });

      // Device but NO scale_pairing — shelf-ingest would return "scale paired
      // but product unset". Seed the log row directly with applied=false so
      // we don't need the edge function.
      const { data: dev } = await chef(admin)
        .from('live_shelf_devices')
        .insert({
          user_id: userId,
          device_name: 'e2e-rejected',
          import_key_hash: `e2e-hash-r-${Math.random().toString(36).slice(2)}`,
          lan_ip: '192.168.0.181',
        })
        .select('device_id')
        .single();
      const clientEventId = `ev-${userId}-8`;
      await chef(admin)
        .from('shelf_event_log')
        .insert({
          user_id: userId,
          device_id: dev!.device_id,
          client_event_id: clientEventId,
          pi_event_id: 'pi-evt-8',
          payload: {
            scale_id: 'scale-unpaired',
            kind: 'live_scale',
            event_kind: 'consumed',
            product_id: productId,
            delta_g: -100,
            occurred_at: new Date().toISOString(),
          },
          applied: false,
          reason: 'scale paired but product unset',
        });

      await gotoEvents(page);

      const row = page.getByTestId(`event-row-${clientEventId}`);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row.getByTestId('needs-action-badge')).toBeVisible();
      await expect(row.getByTestId('event-reason')).toContainText('scale paired but product unset');

      const retryBtn = row.getByTestId('retry-action-btn');
      await expect(retryBtn).toHaveAttribute('data-retry-kind', 'configure_pairing');
      await expect(retryBtn).toHaveText(/Configure pairing/);
      await retryBtn.click();

      await expect(page).toHaveURL(/\/chef\/settings\?tab=scales/);
    } finally {
      await cleanup();
    }
  });

  // ────────────────────────────────────────────────────────────
  // Feature: Needs-Review filter + Accept-classifier-pick acceptance.
  // ────────────────────────────────────────────────────────────
  test('9. Needs Review filter + Accept classifier pick writes DB state', async ({ page }) => {
    const { userId, client, cleanup } = await seedFullAndLogin(page, 'event-viewer-9');
    try {
      const { productId, lotId } = await seedProductAndLot(userId, {
        productName: 'Review Queue Product',
      });

      const clientEventId = `ev-${userId}-9`;
      await seedShelfEvent(userId, productId, lotId, {
        clientEventId,
        piEventId: 'pi-evt-9',
      });

      // Flag the event as needing classifier review.
      await chef(admin)
        .from('shelf_event_log')
        .update({
          classifier_status: 'review',
          classification: { item_id: productId, confidence: 0.42, multi_match: [] },
        })
        .eq('client_event_id', clientEventId);

      // Also seed a second applied event so the filter actually narrows.
      const clientEventIdApplied = `ev-${userId}-9-applied`;
      await seedShelfEvent(userId, productId, lotId, {
        clientEventId: clientEventIdApplied,
        piEventId: 'pi-evt-9-applied',
      });

      await gotoEvents(page);

      // Review filter narrows to just the review event.
      await page.getByTestId('status-review').click();
      const reviewRow = page.getByTestId(`event-row-${clientEventId}`);
      await expect(reviewRow).toBeVisible({ timeout: 15_000 });
      await expect(reviewRow.getByTestId('needs-review-badge')).toBeVisible();
      await expect(page.getByTestId(`event-row-${clientEventIdApplied}`)).toHaveCount(0);

      // Open the review panel + accept the classifier pick.
      await reviewRow.getByTestId('toggle-edit-btn').click();
      await expect(reviewRow.getByTestId('review-panel')).toBeVisible();
      await reviewRow.getByTestId('accept-classifier-btn').click();

      // shelf_event_log.classifier_status flips to 'classified' AND an
      // override row is now present. Verify via fresh admin query (not
      // just the UI label) to catch reconcile-level regressions.
      await expect
        .poll(
          async () => {
            const { data } = await chef(client)
              .from('shelf_event_log')
              .select('classifier_status')
              .eq('client_event_id', clientEventId)
              .maybeSingle();
            return data?.classifier_status;
          },
          { timeout: 15_000 },
        )
        .toBe('classified');

      await expect
        .poll(
          async () => {
            const { data } = await chef(client)
              .from('event_overrides')
              .select('override_id')
              .eq('client_event_id', clientEventId)
              .maybeSingle();
            return data?.override_id ?? null;
          },
          { timeout: 15_000 },
        )
        .not.toBeNull();
    } finally {
      await cleanup();
    }
  });

  test('7. flip event kind consumed → added reverses stock direction', async ({ page }) => {
    const { userId, client, cleanup } = await seedFullAndLogin(page, 'event-viewer-7');
    try {
      const { productId, lotId } = await seedProductAndLot(userId, {
        productName: 'Kind Flip Product',
      });
      const clientEventId = `ev-${userId}-7`;
      await seedShelfEvent(userId, productId, lotId, {
        clientEventId,
        piEventId: 'pi-evt-7',
      });

      await gotoEvents(page);

      const row = page.getByTestId(`event-row-${clientEventId}`);
      await row.getByTestId('toggle-edit-btn').click();
      await row.getByTestId('event-kind-added').click();
      await row.getByTestId('save-override-btn').click();

      // Stock: seed 4 → Pi decrement to 3 → back out prior (+1 → 4) →
      // re-apply as +1 add → 5.
      await expect
        .poll(
          async () => {
            const { data } = await chef(client)
              .from('stock_lots')
              .select('qty_containers')
              .eq('lot_id', lotId)
              .maybeSingle();
            return data?.qty_containers;
          },
          { timeout: 15_000 },
        )
        .toBe(5);

      // No food_logs row for added events.
      await expect
        .poll(
          async () => {
            const { count } = await chef(client)
              .from('food_logs')
              .select('log_id', { count: 'exact', head: true })
              .eq('source_client_event_id', clientEventId);
            return count;
          },
          { timeout: 15_000 },
        )
        .toBe(0);

      // DB override row has event_kind_override='added'.
      await expect
        .poll(
          async () => {
            const { data } = await chef(client)
              .from('event_overrides')
              .select('event_kind_override')
              .eq('client_event_id', clientEventId)
              .maybeSingle();
            return data?.event_kind_override;
          },
          { timeout: 15_000 },
        )
        .toBe('added');

      // Effective-kind text in the row header reflects the override.
      await expect(row.getByTestId('event-effective-kind')).toHaveText('added');
      await expect(row.getByTestId('edited-badge')).toBeVisible();
    } finally {
      await cleanup();
    }
  });
});
