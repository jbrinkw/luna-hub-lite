/**
 * Live Shelf E2E suite
 *
 * Covers every interactive element added in the 2026-04-19 Live Shelf rollout:
 *   - ChefByte Settings → Scales tab (device CRUD, key lifecycle, LAN IP
 *     validation, scale pairing, delete-dialog UX hardening)
 *   - Inventory page additions (source-tag pill + Review(N) deep-link)
 *
 * Runs against production Supabase with a fresh, isolated user per test.
 */

import { test, expect, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { seedFullAndLogin } from '../helpers/seed';
import { SUPABASE_URL, SERVICE_ROLE_KEY, admin } from '../helpers/constants';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const HEX_64 = /^[a-f0-9]{64}$/;

function chef(client: SupabaseClient) {
  return (client as any).schema('chefbyte');
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Admin-seed a Live Shelf device with a known raw import key. Returns the raw
 * key + device_id so tests can impersonate the Pi at the shelf-ingest edge
 * function.
 */
async function seedDeviceAdmin(params: {
  userId: string;
  name: string;
  lanIp?: string | null;
  pendingReviewCount?: number;
  isActive?: boolean;
}): Promise<{ deviceId: string; rawKey: string }> {
  const rawKey = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const keyHash = await sha256Hex(rawKey);

  const { data, error } = await chef(admin)
    .from('live_shelf_devices')
    .insert({
      user_id: params.userId,
      device_name: params.name,
      import_key_hash: keyHash,
      lan_ip: params.lanIp ?? null,
      pending_review_count: params.pendingReviewCount ?? 0,
      is_active: params.isActive ?? true,
    })
    .select('device_id')
    .single();

  if (error || !data) throw new Error(`seedDeviceAdmin failed: ${error?.message ?? 'no row'}`);
  return { deviceId: data.device_id as string, rawKey };
}

/** POST to the shelf-ingest heartbeat endpoint as if we were the Pi. */
async function postHeartbeat(rawKey: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${SUPABASE_URL}/functions/v1/shelf-ingest/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
    body: JSON.stringify(body),
  });
}

/** Navigate to the Scales tab via the Settings page URL param. */
async function gotoScalesTab(page: Page) {
  await page.goto('/chef/settings?tab=scales');
  await expect(page.getByTestId('scales-tab')).toBeVisible({ timeout: 30_000 });
}

/** Grant write-permission by seeding a product under this user. Returns product_id. */
async function seedProduct(client: SupabaseClient, userId: string, name: string, extra: Record<string, any> = {}) {
  const { data, error } = await chef(client)
    .from('products')
    .insert({
      user_id: userId,
      name,
      servings_per_container: 1,
      calories_per_serving: 100,
      carbs_per_serving: 10,
      protein_per_serving: 5,
      fat_per_serving: 2,
      min_stock_amount: 1,
      ...extra,
    })
    .select('product_id')
    .single();
  if (error || !data) throw new Error(`seedProduct("${name}") failed: ${error?.message}`);
  return data.product_id as string;
}

async function firstLocationId(client: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await chef(client)
    .from('locations')
    .select('location_id')
    .eq('user_id', userId)
    .order('created_at')
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error(`no location for user: ${error?.message ?? 'none'}`);
  return data.location_id as string;
}

async function seedStockLot(
  client: SupabaseClient,
  userId: string,
  productId: string,
  locationId: string,
  source: 'manual' | 'live_shelf' | 'live_scale' | 'catch_all' | null,
  qtyContainers = 1,
) {
  const payload: Record<string, unknown> = {
    user_id: userId,
    product_id: productId,
    location_id: locationId,
    qty_containers: qtyContainers,
    last_update_source: source,
  };
  // last_update_ts is not strictly required; leave null for null-source rows.
  if (source !== null) payload.last_update_ts = new Date().toISOString();
  const { error } = await chef(client).from('stock_lots').insert(payload);
  if (error) throw new Error(`seedStockLot failed: ${error.message}`);
}

/* ================================================================== */
/*  Live Shelf Scales tab                                              */
/* ================================================================== */

test.describe('Live Shelf Scales tab', () => {
  test('empty state + new-device form visibility + disabled generate', async ({ page }) => {
    const { cleanup } = await seedFullAndLogin(page, 'shelf-empty');
    try {
      await gotoScalesTab(page);

      // 1. Empty state copy
      await expect(page.getByTestId('no-shelf-devices')).toHaveText(/No devices registered yet/i, { timeout: 15_000 });

      // 2. Toggle the add form
      await page.getByTestId('toggle-add-shelf-device').click();
      await expect(page.getByTestId('add-shelf-device-form')).toBeVisible();
      await expect(page.getByTestId('shelf-device-name-input')).toBeVisible();
      await expect(page.getByTestId('shelf-device-location-input')).toBeVisible();

      // 3. Empty name → Generate disabled
      await expect(page.getByTestId('generate-shelf-device-btn')).toBeDisabled();
    } finally {
      await cleanup();
    }
  });

  test('generate device surfaces device id + 64-hex import key + warning', async ({ page }) => {
    const { cleanup } = await seedFullAndLogin(page, 'shelf-generate');
    try {
      await gotoScalesTab(page);
      await page.getByTestId('toggle-add-shelf-device').click();
      await page.getByTestId('shelf-device-name-input').fill('Kitchen Pi');
      await page.getByTestId('shelf-device-location-input').fill('Top shelf');

      const genBtn = page.getByTestId('generate-shelf-device-btn');
      await expect(genBtn).toBeEnabled();
      await genBtn.click();

      // 4. Modal-ish area surfaces the key material + warning
      const info = page.getByTestId('generated-shelf-device-info');
      await expect(info).toBeVisible({ timeout: 15_000 });
      await expect(info).toContainText(/Save this key now/i);
      await expect(page.getByTestId('copy-shelf-device-id-btn')).toBeVisible();
      await expect(page.getByTestId('copy-shelf-import-key-btn')).toBeVisible();

      // The raw key should be 64 hex chars
      const rawKey = (await info.locator('code').nth(1).textContent())?.trim() ?? '';
      expect(rawKey).toMatch(HEX_64);
    } finally {
      await cleanup();
    }
  });

  test('copy import key writes the exact 64-char key to the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const { cleanup } = await seedFullAndLogin(page, 'shelf-clip');
    try {
      await gotoScalesTab(page);
      await page.getByTestId('toggle-add-shelf-device').click();
      await page.getByTestId('shelf-device-name-input').fill('Clipboard Pi');
      await page.getByTestId('generate-shelf-device-btn').click();

      const info = page.getByTestId('generated-shelf-device-info');
      await expect(info).toBeVisible({ timeout: 15_000 });
      const rawKey = (await info.locator('code').nth(1).textContent())?.trim() ?? '';
      expect(rawKey).toMatch(HEX_64);

      // 5. Copy the key → clipboard equals the hex key + "Copied!" feedback appears
      await page.getByTestId('copy-shelf-import-key-btn').click();
      await expect(page.getByTestId('copy-shelf-import-key-btn')).toContainText(/Copied/i, { timeout: 5_000 });
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      expect(clip).toBe(rawKey);
    } finally {
      await cleanup();
    }
  });

  test('dismiss modal removes raw key from DOM; device card persists', async ({ page }) => {
    const { cleanup } = await seedFullAndLogin(page, 'shelf-dismiss');
    try {
      await gotoScalesTab(page);
      await page.getByTestId('toggle-add-shelf-device').click();
      await page.getByTestId('shelf-device-name-input').fill('Ephemeral Pi');
      await page.getByTestId('generate-shelf-device-btn').click();

      const info = page.getByTestId('generated-shelf-device-info');
      await expect(info).toBeVisible({ timeout: 15_000 });
      const rawKey = (await info.locator('code').nth(1).textContent())?.trim() ?? '';
      expect(rawKey).toMatch(HEX_64);

      // Dismiss
      await info.getByRole('button', { name: 'Dismiss' }).click();
      await expect(info).not.toBeVisible();

      // 6. Device card appears in list
      await expect(page.getByTestId('shelf-device-list')).toContainText('Ephemeral Pi', { timeout: 10_000 });

      // Raw key should be gone from the rendered DOM
      const html = await page.content();
      expect(html).not.toContain(rawKey);
    } finally {
      await cleanup();
    }
  });

  test('LAN IP validation rejects javascript: and data: schemes and port-embedded addresses; accepts IPv4 and hostname', async ({
    page,
  }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shelf-lanip');
    try {
      const { deviceId } = await seedDeviceAdmin({ userId, name: 'Test Pi' });

      await gotoScalesTab(page);
      const card = page.getByTestId(`shelf-device-${deviceId}`);
      await expect(card).toBeVisible({ timeout: 15_000 });

      const openEditor = async () => {
        await card.getByTestId(`edit-shelf-lan-ip-${deviceId}`).click();
        return card.getByTestId(`shelf-lan-ip-edit-${deviceId}`);
      };
      const save = () => card.getByRole('button', { name: 'Save' }).click();

      const expectPersistedLanIp = async (expected: string | null) => {
        await expect(async () => {
          const { data, error } = await chef(client)
            .from('live_shelf_devices')
            .select('lan_ip')
            .eq('device_id', deviceId)
            .single();
          expect(error).toBeNull();
          expect(data?.lan_ip ?? null).toBe(expected);
        }).toPass({ timeout: 15_000 });
      };

      // 7. javascript:// scheme → rejected, not persisted, error shown
      let input = await openEditor();
      await input.fill('javascript://evil.com');
      await save();
      await expect(page.locator('text=/Invalid LAN IP/i')).toBeVisible({ timeout: 10_000 });
      // Cancel the still-open editor and verify no write happened
      await card.getByRole('button', { name: 'Cancel' }).click();
      await expectPersistedLanIp(null);

      // 8. data:text/html scheme → rejected
      input = await openEditor();
      await input.fill('data:text/html,<script>');
      await save();
      await expect(page.locator('text=/Invalid LAN IP/i')).toBeVisible({ timeout: 10_000 });
      await card.getByRole('button', { name: 'Cancel' }).click();
      await expectPersistedLanIp(null);

      // 11. Port embedded → rejected (security audit fix)
      input = await openEditor();
      await input.fill('192.168.0.181:9000');
      await save();
      await expect(page.locator('text=/Invalid LAN IP/i')).toBeVisible({ timeout: 10_000 });
      await card.getByRole('button', { name: 'Cancel' }).click();
      await expectPersistedLanIp(null);

      // 11b. Out-of-range IPv4 octets → rejected (audit pass-2 stricter validator).
      // Previously the permissive digits+dots hostname fallback let this slip
      // through; the tightened validator gates on IPv4 shape first and
      // enforces per-octet range 0–255.
      input = await openEditor();
      await input.fill('999.999.999.999');
      await save();
      await expect(page.locator('text=/Invalid LAN IP/i')).toBeVisible({ timeout: 10_000 });
      await card.getByRole('button', { name: 'Cancel' }).click();
      await expectPersistedLanIp(null);

      // 9. Plain IPv4 → persists
      input = await openEditor();
      await input.fill('192.168.0.181');
      await save();
      await expectPersistedLanIp('192.168.0.181');

      // 10. Hostname → persists
      input = await openEditor();
      await input.fill('my-pi.local');
      await save();
      await expectPersistedLanIp('my-pi.local');
    } finally {
      await cleanup();
    }
  });

  test('rename device updates card heading', async ({ page }) => {
    const { userId, cleanup } = await seedFullAndLogin(page, 'shelf-rename');
    try {
      const { deviceId } = await seedDeviceAdmin({ userId, name: 'Old Name' });
      await gotoScalesTab(page);
      const card = page.getByTestId(`shelf-device-${deviceId}`);
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card).toContainText('Old Name');

      // 12. Rename
      await card.getByTestId(`rename-shelf-device-${deviceId}`).click();
      const nameInput = card.getByTestId(`shelf-device-name-edit-${deviceId}`);
      await nameInput.fill('Brand New Name');
      await card.getByRole('button', { name: 'Save' }).click();

      await expect(card.locator('h4')).toHaveText('Brand New Name', { timeout: 10_000 });
    } finally {
      await cleanup();
    }
  });

  test('regenerate key produces a different key and triggers a devices refetch without reload', async ({ page }) => {
    const { userId, cleanup } = await seedFullAndLogin(page, 'shelf-regen');
    try {
      // Seed a device with a known key so we can compare
      const seeded = await seedDeviceAdmin({ userId, name: 'Regen Pi' });

      await gotoScalesTab(page);
      const card = page.getByTestId(`shelf-device-${seeded.deviceId}`);
      await expect(card).toBeVisible({ timeout: 15_000 });

      // 13. Trigger regen, expect confirm dialog, confirm, capture new key
      await card.getByTestId(`regen-shelf-key-${seeded.deviceId}`).click();
      const confirmDialog = page.getByRole('dialog', { name: 'Regenerate Import Key' });
      await expect(confirmDialog).toBeVisible();
      await confirmDialog.getByRole('button', { name: 'Regenerate' }).click();

      const info = page.getByTestId('generated-shelf-device-info');
      await expect(info).toBeVisible({ timeout: 15_000 });
      const newRawKey = (await info.locator('code').nth(1).textContent())?.trim() ?? '';
      expect(newRawKey).toMatch(HEX_64);
      // The newly generated key must differ from the one we seeded with
      expect(newRawKey).not.toBe(seeded.rawKey);

      // 14. After regen, the device list must refetch. Issue a targeted DB
      // mutation and watch the UI reflect it without a page reload — proves
      // either the Realtime invalidation or the post-mutation refetch is
      // firing (both are wired by the audit fix).
      await info.getByRole('button', { name: 'Dismiss' }).click();

      const newName = `Renamed-${Date.now()}`;
      await chef(admin).from('live_shelf_devices').update({ device_name: newName }).eq('device_id', seeded.deviceId);

      await expect(card.locator('h4')).toHaveText(newName, { timeout: 30_000 });
    } finally {
      await cleanup();
    }
  });

  test('revoke flips is_active false and reactivate flips it back', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shelf-revoke');
    try {
      const { deviceId } = await seedDeviceAdmin({ userId, name: 'Revoke Pi' });
      await gotoScalesTab(page);
      const card = page.getByTestId(`shelf-device-${deviceId}`);
      await expect(card).toBeVisible({ timeout: 15_000 });

      // 15. Revoke → confirm → DB reflects, UI shows "Revoked"
      await card.getByTestId(`revoke-shelf-device-${deviceId}`).click();
      const revokeDialog = page.getByRole('dialog', { name: 'Revoke Device' });
      await expect(revokeDialog).toBeVisible();
      await revokeDialog.getByRole('button', { name: 'Revoke' }).click();

      await expect(async () => {
        const { data } = await chef(client)
          .from('live_shelf_devices')
          .select('is_active')
          .eq('device_id', deviceId)
          .single();
        expect(data?.is_active).toBe(false);
      }).toPass({ timeout: 15_000 });
      await expect(card).toContainText('Revoked', { timeout: 10_000 });

      // 16. Reactivate
      await card.getByTestId(`reactivate-shelf-device-${deviceId}`).click();
      await expect(async () => {
        const { data } = await chef(client)
          .from('live_shelf_devices')
          .select('is_active')
          .eq('device_id', deviceId)
          .single();
        expect(data?.is_active).toBe(true);
      }).toPass({ timeout: 15_000 });
      await expect(card).toContainText('Active', { timeout: 10_000 });
    } finally {
      await cleanup();
    }
  });

  test('silent-revoke banner surfaces when the only device is inactive', async ({ page }) => {
    // Bug A (2026-04-24): the invariant_batch consolidation silently
    // flipped kitchen-pi is_active=false. The generic "Revoked" badge
    // on the device card was the only UX surface — easy to miss on a
    // dashboard with only one device. This test asserts the prominent
    // reactivation banner shows up AND the Reactivate button works.
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shelf-silent-revoke');
    try {
      // Seed an already-inactive device (simulating the post-migration state).
      const { deviceId } = await seedDeviceAdmin({ userId, name: 'Silent Revoke Pi' });
      await chef(client)
        .from('live_shelf_devices')
        .update({ is_active: false })
        .eq('device_id', deviceId);

      await gotoScalesTab(page);

      // Banner visible
      const banner = page.getByTestId('scales-silent-revoke-banner');
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toContainText(/Your Pi key was deactivated/i);
      await expect(banner).toContainText('Silent Revoke Pi');

      // Click Reactivate on the banner
      await banner.getByTestId('scales-silent-revoke-reactivate-btn').click();

      // DB reflects active=true
      await expect(async () => {
        const { data } = await chef(client)
          .from('live_shelf_devices')
          .select('is_active')
          .eq('device_id', deviceId)
          .single();
        expect(data?.is_active).toBe(true);
      }).toPass({ timeout: 15_000 });

      // Banner disappears
      await expect(banner).toBeHidden({ timeout: 10_000 });
    } finally {
      await cleanup();
    }
  });

  test('silent-revoke banner is NOT shown when user has multiple devices (one retired is OK)', async ({ page }) => {
    // Guard: the banner should only surface for the one-device case.
    // A user who has an active primary + an intentionally-retired
    // secondary shouldn't see the banner — the retired device's
    // "Revoked" badge on its own card is sufficient.
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shelf-two-dev');
    try {
      await seedDeviceAdmin({ userId, name: 'Primary Active Pi' });
      const { deviceId: secondaryId } = await seedDeviceAdmin({ userId, name: 'Retired Pi' });
      await chef(client)
        .from('live_shelf_devices')
        .update({ is_active: false })
        .eq('device_id', secondaryId);

      await gotoScalesTab(page);

      const banner = page.getByTestId('scales-silent-revoke-banner');
      await expect(banner).toBeHidden({ timeout: 5_000 });
    } finally {
      await cleanup();
    }
  });

  test('scales list: empty before heartbeat, 3 rows after, correct kind UI, product picker only on live_scale', async ({
    page,
  }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shelf-scales');
    try {
      // Seed a device with a known raw key so we can POST heartbeats
      const { deviceId, rawKey } = await seedDeviceAdmin({ userId, name: 'Heartbeat Pi' });

      // Also seed a product we'll pair to
      const productId = await seedProduct(client, userId, 'Test Product for Pairing');

      await gotoScalesTab(page);
      const card = page.getByTestId(`shelf-device-${deviceId}`);
      await expect(card).toBeVisible({ timeout: 15_000 });

      // 17. Before any heartbeat: Show Scales (0) + empty pairing list when expanded
      const toggleBtn = card.getByTestId(`toggle-shelf-scales-${deviceId}`);
      await expect(toggleBtn).toContainText(/Scales \(0\)/);
      await toggleBtn.click();
      await expect(card.getByTestId(`shelf-scales-${deviceId}`)).toContainText(/No scales seen yet/i);

      // 18. Simulate the Pi's heartbeat with 3 scales
      const hbResp = await postHeartbeat(rawKey, {
        pending_review_count: 0,
        scales: [
          { scale_id: 'shelf-001', kind: 'live_shelf' },
          { scale_id: 'catch-001', kind: 'catch_all' },
          { scale_id: 'scale-001', kind: 'live_scale' },
        ],
      });
      expect(hbResp.status).toBe(200);

      // Wait for the three pairings to land + render
      await expect(async () => {
        await expect(toggleBtn).toContainText(/Scales \(3\)/, { timeout: 5_000 });
      }).toPass({ timeout: 30_000 });

      // 19. Ensure expansion is on and rows are present
      if ((await card.getByTestId(`shelf-scales-${deviceId}`).count()) === 0) {
        await toggleBtn.click();
      }
      const scalesPanel = card.getByTestId(`shelf-scales-${deviceId}`);
      await expect(scalesPanel).toContainText('shelf-001');
      await expect(scalesPanel).toContainText('catch-001');
      await expect(scalesPanel).toContainText('scale-001');
      await expect(scalesPanel).toContainText('live shelf');
      await expect(scalesPanel).toContainText('catch-all');
      await expect(scalesPanel).toContainText('live scale');

      // 20. live_scale has product picker; live_shelf + catch_all show auto-classified label
      // Locate the three pairing rows by scale_id
      const liveScaleRow = scalesPanel.locator('div', { hasText: 'scale-001' }).first();
      await expect(liveScaleRow.getByRole('combobox')).toBeVisible();
      // "Auto-classified via camera" should be in the panel at least once (both
      // live_shelf + catch_all use that label, so expect >= 2 matches).
      await expect(scalesPanel.locator('text=/Auto-classified via camera/i')).toHaveCount(2);

      // 21. Pair the live_scale row → DB reflects the update
      const pairingRow = await chef(client)
        .from('scale_pairings')
        .select('pairing_id, scale_id')
        .eq('device_id', deviceId)
        .eq('scale_id', 'scale-001')
        .single();
      const pairingId = (pairingRow.data as any).pairing_id as string;

      const picker = scalesPanel.getByTestId(`scale-product-picker-${pairingId}`);
      await picker.selectOption(productId);

      await expect(async () => {
        const { data } = await chef(client)
          .from('scale_pairings')
          .select('product_id')
          .eq('pairing_id', pairingId)
          .single();
        expect(data?.product_id).toBe(productId);
      }).toPass({ timeout: 15_000 });
    } finally {
      await cleanup();
    }
  });

  test('delete dialog: Escape closes without deleting, Cancel is autofocused, focus trap holds, Confirm deletes device + pairings', async ({
    page,
  }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shelf-del');
    try {
      const { deviceId, rawKey } = await seedDeviceAdmin({ userId, name: 'Delete Pi' });
      // Make at least one scale pairing via a heartbeat so we can assert cascade
      await postHeartbeat(rawKey, {
        pending_review_count: 0,
        scales: [{ scale_id: 'scale-del-1', kind: 'live_shelf' }],
      });

      await gotoScalesTab(page);
      const card = page.getByTestId(`shelf-device-${deviceId}`);
      await expect(card).toBeVisible({ timeout: 15_000 });

      // 22. Open the delete dialog — role="dialog" + aria-modal="true"
      await card.getByTestId(`delete-shelf-device-${deviceId}`).click();
      const dialog = page.getByRole('dialog', { name: 'Delete Device' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('aria-modal', 'true');

      // 23. Escape closes, device NOT deleted
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible({ timeout: 5_000 });
      // DB row still exists
      const stillThere = await chef(client)
        .from('live_shelf_devices')
        .select('device_id')
        .eq('device_id', deviceId)
        .maybeSingle();
      expect(stillThere.data?.device_id).toBe(deviceId);

      // 24. Reopen → Cancel has autofocus
      await card.getByTestId(`delete-shelf-device-${deviceId}`).click();
      const dialog2 = page.getByRole('dialog', { name: 'Delete Device' });
      await expect(dialog2).toBeVisible();
      const initialActive = await page.evaluate(() => document.activeElement?.textContent ?? '');
      expect(initialActive).toMatch(/Cancel/i);

      // 25. Tab twice from Cancel; focus must remain inside the dialog (trap)
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      const trapped = await page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]');
        return dlg ? dlg.contains(document.activeElement) : false;
      });
      expect(trapped).toBe(true);

      // 26. Confirm delete → device + pairings gone
      await dialog2.getByRole('button', { name: 'Delete' }).click();
      await expect(async () => {
        const { data } = await chef(client)
          .from('live_shelf_devices')
          .select('device_id')
          .eq('device_id', deviceId)
          .maybeSingle();
        expect(data).toBeNull();
      }).toPass({ timeout: 15_000 });

      const { data: pairingsAfter } = await chef(client)
        .from('scale_pairings')
        .select('pairing_id')
        .eq('device_id', deviceId);
      expect(pairingsAfter?.length ?? 0).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test('after deleting the only device the empty state returns', async ({ page }) => {
    const { userId, cleanup } = await seedFullAndLogin(page, 'shelf-empty-return');
    try {
      const { deviceId } = await seedDeviceAdmin({ userId, name: 'Only Pi' });
      await gotoScalesTab(page);
      await expect(page.getByTestId(`shelf-device-${deviceId}`)).toBeVisible({ timeout: 15_000 });

      await page.getByTestId(`delete-shelf-device-${deviceId}`).click();
      await page.getByRole('dialog', { name: 'Delete Device' }).getByRole('button', { name: 'Delete' }).click();

      // 27. Empty state shown again
      await expect(page.getByTestId('no-shelf-devices')).toBeVisible({ timeout: 15_000 });
    } finally {
      await cleanup();
    }
  });
});

/* ================================================================== */
/*  Live Shelf inventory integration                                   */
/* ================================================================== */

test.describe('Live Shelf inventory integration', () => {
  test('source pills: live_shelf, catch_all, live_scale rows show their pill; manual row shows none', async ({
    page,
  }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shelf-inv-pills');
    try {
      // 28. Seed one product per source (+ one manual fallback)
      const locationId = await firstLocationId(client, userId);
      const liveShelfPid = await seedProduct(client, userId, 'Shelf Tagged Product');
      const catchAllPid = await seedProduct(client, userId, 'Catch All Product');
      const liveScalePid = await seedProduct(client, userId, 'Live Scale Product');
      const manualPid = await seedProduct(client, userId, 'Manual-Only Product');

      await seedStockLot(client, userId, liveShelfPid, locationId, 'live_shelf', 2);
      await seedStockLot(client, userId, catchAllPid, locationId, 'catch_all', 2);
      await seedStockLot(client, userId, liveScalePid, locationId, 'live_scale', 2);
      // manualPid: intentionally seed with NULL source to prove the pill is absent.
      await seedStockLot(client, userId, manualPid, locationId, null, 2);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30_000 });

      // 29. Each non-manual row shows its source pill, correctly labelled
      await expect(page.getByTestId(`source-pill-${liveShelfPid}`)).toHaveText(/live shelf/i);
      await expect(page.getByTestId(`source-pill-${catchAllPid}`)).toHaveText(/catch-all/i);
      await expect(page.getByTestId(`source-pill-${liveScalePid}`)).toHaveText(/live scale/i);

      // 30. Manual row: no pill
      await expect(page.getByTestId(`inv-product-${manualPid}`)).toBeVisible();
      await expect(page.getByTestId(`source-pill-${manualPid}`)).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });

  test('Review(N) button: shows pending count, opens LAN URL in new tab, stays visible at 0, disables when no LAN IP', async ({
    page,
    context,
  }) => {
    const { userId, cleanup } = await seedFullAndLogin(page, 'shelf-inv-review');
    try {
      // 31. Register device with 3 pending + LAN IP
      const { deviceId } = await seedDeviceAdmin({
        userId,
        name: 'Review Pi',
        lanIp: '192.168.0.181',
        pendingReviewCount: 3,
      });

      await page.goto('/chef/inventory');
      const reviewBtn = page.getByTestId('inventory-review-btn');
      await expect(reviewBtn).toBeVisible({ timeout: 30_000 });
      await expect(reviewBtn).toHaveText(/Review \(3\)/);

      // 32. Clicking opens new tab pointing at the Pi's local review URL.
      //    Use expect.toPass since some browsers take a tick to fire popup event.
      const [popup] = await Promise.all([context.waitForEvent('page'), reviewBtn.click()]);
      // The Pi URL is unreachable in CI so we don't wait for load; just verify the URL.
      expect(popup.url()).toBe('http://192.168.0.181:8000/inventory#review');
      await popup.close();

      // 33. Drop pending_review_count to 0; button remains visible + enabled, label updates
      await chef(admin).from('live_shelf_devices').update({ pending_review_count: 0 }).eq('device_id', deviceId);
      await page.reload();
      const reviewBtnReloaded = page.getByTestId('inventory-review-btn');
      await expect(reviewBtnReloaded).toBeVisible({ timeout: 30_000 });
      await expect(reviewBtnReloaded).toHaveText(/Review \(0\)/);

      // 34. Clear lan_ip → button becomes the disabled surface
      await chef(admin).from('live_shelf_devices').update({ lan_ip: null }).eq('device_id', deviceId);
      await page.reload();
      const disabled = page.getByTestId('inventory-review-btn-disabled');
      await expect(disabled).toBeVisible({ timeout: 30_000 });
      await expect(disabled).toBeDisabled();
      await expect(disabled).toHaveAttribute('title', /Settings.*Scales/i);
      // And the enabled variant must not be present
      await expect(page.getByTestId('inventory-review-btn')).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });
});
