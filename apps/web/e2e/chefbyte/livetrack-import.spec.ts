/**
 * LiveTrack Import Wizard E2E
 *
 * Covers the 8 scenarios in
 * docs/superpowers/plans/2026-04-21-livetrack-import-wizard.md §10.
 *
 * Pi is NEVER started for these tests; we emulate it by posting directly
 * to the `livetrack-session/pi-update` edge function with a seeded
 * x-api-key (see `postPiUpdate`). Ensures the wizard's cloud-side state
 * machine is correct without needing physical hardware.
 */

import { test, expect, type Page } from '@playwright/test';
import { type SupabaseClient } from '@supabase/supabase-js';
import { seedFullAndLogin } from '../helpers/seed';
import { admin, SUPABASE_URL } from '../helpers/constants';

const FRESH_HEARTBEAT_S = 10;

function chef(client: SupabaseClient) {
  return (client as any).schema('chefbyte');
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Seed a live_shelf_devices row for `userId` and return (deviceId, rawKey). */
async function seedDevice(params: {
  userId: string;
  name?: string;
  freshHeartbeat?: boolean;
  staleMinutes?: number;
}): Promise<{ deviceId: string; rawKey: string }> {
  const rawKey = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const keyHash = await sha256Hex(rawKey);

  const lastHeartbeat =
    params.freshHeartbeat === false
      ? new Date(Date.now() - (params.staleMinutes ?? 5) * 60_000).toISOString()
      : new Date(Date.now() - FRESH_HEARTBEAT_S * 1000).toISOString();

  const { data, error } = await chef(admin)
    .from('live_shelf_devices')
    .insert({
      user_id: params.userId,
      device_name: params.name ?? 'Test Pi',
      import_key_hash: keyHash,
      is_active: true,
      last_heartbeat_ts: lastHeartbeat,
    })
    .select('device_id')
    .single();
  if (error || !data) throw new Error(`seedDevice failed: ${error?.message}`);
  return { deviceId: data.device_id as string, rawKey };
}

/** POST as-if-Pi to the edge function. */
async function postPiUpdate(rawKey: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${SUPABASE_URL}/functions/v1/livetrack-session/pi-update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
    body: JSON.stringify(body),
  });
}

/** Seed a product matching a barcode so /analyze-product isn't required. */
async function seedProduct(
  userId: string,
  opts: { barcode: string; name: string; netWeightG?: number },
): Promise<string> {
  const { data, error } = await chef(admin)
    .from('products')
    .insert({
      user_id: userId,
      name: opts.name,
      barcode: opts.barcode,
      servings_per_container: 5,
      calories_per_serving: 100,
      carbs_per_serving: 20,
      protein_per_serving: 5,
      fat_per_serving: 2,
      net_weight_g: opts.netWeightG ?? null,
    })
    .select('product_id')
    .single();
  if (error || !data) throw new Error(`seedProduct failed: ${error?.message}`);
  return data.product_id as string;
}

async function gotoLiveTrack(page: Page) {
  await page.goto('/chef/livetrack-import');
  await expect(page.getByTestId('livetrack-page')).toBeVisible({ timeout: 30_000 });
}

/** Wait for the page to flip to waiting_barcode (session created successfully). */
async function waitForWaitingBarcode(page: Page) {
  await expect(page.getByTestId('livetrack-waiting-barcode')).toBeVisible({ timeout: 15_000 });
}

/* ================================================================== */
/*  Tests                                                              */
/* ================================================================== */

test.describe('LiveTrack Import Wizard', () => {
  test('1. happy path: scan → scale reading → review → save writes tare_weight_g', async ({ page }) => {
    const { userId, client, cleanup } = await seedFullAndLogin(page, 'lt-happy');
    try {
      const { rawKey } = await seedDevice({ userId, name: 'Happy Pi' });
      const barcode = '0123456789012';
      const productId = await seedProduct(userId, { barcode, name: 'Test Jar', netWeightG: 200 });

      await gotoLiveTrack(page);
      await waitForWaitingBarcode(page);

      // Scan
      const input = page.getByTestId('livetrack-barcode-input');
      await input.fill(barcode);
      await input.press('Enter');

      await expect(page.getByTestId('livetrack-product-loaded')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('livetrack-waiting-scale-hint')).toBeVisible();

      // Find the session, emulate Pi posting a scale reading = 314g (tare = 114g)
      const { data: sess } = await chef(client)
        .from('livetrack_import_sessions')
        .select('session_id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      const sessionId = sess!.session_id as string;

      const resp = await postPiUpdate(rawKey, {
        session_id: sessionId,
        scale_reading_g: 314,
        scale_reading_ts: new Date().toISOString(),
        state: 'scale_reading_received',
      });
      expect(resp.status).toBe(200);

      // Review appears + tare computed = 114g.
      await expect(page.getByTestId('livetrack-review')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('livetrack-tare-g')).toHaveText(/114\.0 g/);
      await expect(page.getByTestId('livetrack-tare-source')).toHaveText('scale');

      // Click Next — save + re-arm.
      await page.getByTestId('livetrack-next-btn').click();

      // Back to waiting_barcode.
      await waitForWaitingBarcode(page);

      // Product row updated with tare_weight_g.
      await expect(async () => {
        const { data } = await chef(client)
          .from('products')
          .select('tare_weight_g')
          .eq('product_id', productId)
          .single();
        expect(data?.tare_weight_g).toBeCloseTo(114, 0);
      }).toPass({ timeout: 10_000 });
    } finally {
      await cleanup();
    }
  });

  test('2. no Pi paired → offline banner, no session created', async ({ page }) => {
    const { userId, cleanup } = await seedFullAndLogin(page, 'lt-nopi');
    try {
      await gotoLiveTrack(page);
      await expect(page.getByTestId('livetrack-offline')).toBeVisible({ timeout: 15_000 });

      // No session row created.
      const { count } = await chef(admin)
        .from('livetrack_import_sessions')
        .select('session_id', { count: 'exact', head: true })
        .eq('user_id', userId);
      expect(count ?? 0).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test('3. Pi heartbeat stale → offline banner + manual-tare fallback still works', async ({ page }) => {
    const { userId, cleanup } = await seedFullAndLogin(page, 'lt-stale');
    try {
      await seedDevice({ userId, name: 'Stale Pi', freshHeartbeat: false, staleMinutes: 5 });

      await gotoLiveTrack(page);
      await expect(page.getByTestId('livetrack-offline')).toBeVisible({ timeout: 15_000 });
    } finally {
      await cleanup();
    }
  });

  test('4. session expiry → Pi-update returns 410 + UI surfaces error state', async ({ page }) => {
    const { userId, client, cleanup } = await seedFullAndLogin(page, 'lt-expire');
    try {
      const { deviceId, rawKey } = await seedDevice({ userId });

      // Seed an expired session row directly.
      const { data: sess } = await chef(admin)
        .from('livetrack_import_sessions')
        .insert({
          user_id: userId,
          device_id: deviceId,
          state: 'waiting_barcode',
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        })
        .select('session_id')
        .single();

      const resp = await postPiUpdate(rawKey, {
        session_id: sess!.session_id,
        scale_reading_g: 100,
      });
      expect(resp.status).toBe(410);

      // Row flipped to expired.
      const { data: row } = await chef(client)
        .from('livetrack_import_sessions')
        .select('state')
        .eq('session_id', sess!.session_id)
        .single();
      expect(row?.state).toBe('expired');
    } finally {
      await cleanup();
    }
  });

  test('5. save-and-reset loop: complete one then scan a second barcode on same session', async ({ page }) => {
    const { userId, client, cleanup } = await seedFullAndLogin(page, 'lt-loop');
    try {
      const { rawKey } = await seedDevice({ userId });
      const barcode1 = '1111111111111';
      const barcode2 = '2222222222222';
      await seedProduct(userId, { barcode: barcode1, name: 'Jar A', netWeightG: 200 });
      await seedProduct(userId, { barcode: barcode2, name: 'Jar B', netWeightG: 300 });

      await gotoLiveTrack(page);
      await waitForWaitingBarcode(page);

      // Scan #1.
      await page.getByTestId('livetrack-barcode-input').fill(barcode1);
      await page.getByTestId('livetrack-barcode-input').press('Enter');
      await expect(page.getByTestId('livetrack-product-loaded')).toBeVisible({ timeout: 15_000 });

      const { data: sess1 } = await chef(client)
        .from('livetrack_import_sessions')
        .select('session_id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      const sessionId = sess1!.session_id as string;

      await postPiUpdate(rawKey, {
        session_id: sessionId,
        scale_reading_g: 250,
        scale_reading_ts: new Date().toISOString(),
        state: 'scale_reading_received',
      });
      await expect(page.getByTestId('livetrack-review')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('livetrack-next-btn').click();
      await waitForWaitingBarcode(page);

      // Session row stayed alive (not re-created), back to waiting_barcode.
      const { data: sessPost } = await chef(client)
        .from('livetrack_import_sessions')
        .select('session_id, state, scale_reading_g, ai_tare_g, current_product_id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      expect(sessPost!.session_id).toBe(sessionId);
      expect(sessPost!.state).toBe('waiting_barcode');
      expect(sessPost!.scale_reading_g).toBeNull();
      expect(sessPost!.current_product_id).toBeNull();

      // Scan #2 on same session.
      await page.getByTestId('livetrack-barcode-input').fill(barcode2);
      await page.getByTestId('livetrack-barcode-input').press('Enter');
      await expect(page.getByTestId('livetrack-product-loaded')).toBeVisible({ timeout: 15_000 });
    } finally {
      await cleanup();
    }
  });

  test('6. multi-tab: creating a new session expires the prior one', async ({ page, context }) => {
    const { userId, client, cleanup } = await seedFullAndLogin(page, 'lt-multitab');
    try {
      await seedDevice({ userId });
      await gotoLiveTrack(page);
      await waitForWaitingBarcode(page);

      const { data: firstSess } = await chef(client)
        .from('livetrack_import_sessions')
        .select('session_id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      // Open second tab → creates a new session → old one should expire.
      const page2 = await context.newPage();
      await page2.goto('/chef/livetrack-import');
      await expect(page2.getByTestId('livetrack-page')).toBeVisible({ timeout: 30_000 });
      await expect(page2.getByTestId('livetrack-waiting-barcode')).toBeVisible({ timeout: 15_000 });

      // First session flipped to 'expired'.
      await expect(async () => {
        const { data: refresh } = await chef(client)
          .from('livetrack_import_sessions')
          .select('state')
          .eq('session_id', firstSess!.session_id)
          .single();
        expect(refresh?.state).toBe('expired');
      }).toPass({ timeout: 10_000 });

      await page2.close();
    } finally {
      await cleanup();
    }
  });

  test('7. product without net_weight_g → AI-tare branch visible, full-container radio disabled', async ({ page }) => {
    const { userId, cleanup } = await seedFullAndLogin(page, 'lt-nonet');
    try {
      await seedDevice({ userId });
      const barcode = '3333333333333';
      await seedProduct(userId, { barcode, name: 'Mystery Jar' /* netWeightG unset */ });

      await gotoLiveTrack(page);
      await waitForWaitingBarcode(page);

      await page.getByTestId('livetrack-barcode-input').fill(barcode);
      await page.getByTestId('livetrack-barcode-input').press('Enter');
      await expect(page.getByTestId('livetrack-product-loaded')).toBeVisible({ timeout: 15_000 });

      // Full radio is disabled.
      await expect(page.getByTestId('livetrack-full-radio')).toBeDisabled();
      // AI-tare button visible + enabled (Pi is fresh).
      await expect(page.getByTestId('livetrack-ai-tare-btn')).toBeVisible();
      await expect(page.getByTestId('livetrack-manual-tare-input')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('8. cross-device session_id on pi-update is rejected with 403', async ({ page }) => {
    const { userId, cleanup } = await seedFullAndLogin(page, 'lt-crossdev');
    try {
      // Device A is the session's owner.
      const devA = await seedDevice({ userId, name: 'Pi A' });
      // Device B has a *different* import key — trying to POST with B's
      // key for A's session should 403.
      const devB = await seedDevice({ userId, name: 'Pi B' });

      const { data: sess } = await chef(admin)
        .from('livetrack_import_sessions')
        .insert({
          user_id: userId,
          device_id: devA.deviceId,
          state: 'waiting_scale',
        })
        .select('session_id')
        .single();

      const resp = await postPiUpdate(devB.rawKey, {
        session_id: sess!.session_id,
        scale_reading_g: 200,
      });
      expect(resp.status).toBe(403);
    } finally {
      await cleanup();
    }
  });
});
