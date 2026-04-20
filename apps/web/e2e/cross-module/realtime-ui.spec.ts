/**
 * Cross-module Realtime resilience.
 *
 * Scenario 4 from the UI-refresh audit: after an explicit WebSocket
 * teardown (simulating network blip / tab-suspend), Supabase's client
 * must auto-reconnect and the app's subscriptions must re-register so
 * the UI still refreshes when external mutations happen.
 *
 * If this test ever starts timing out, the failure surface is one of:
 *   - Realtime client isn't auto-reconnecting after `disconnect()`
 *   - `useRealtimeInvalidation` doesn't re-establish its channel when
 *     the socket reconnects (or the channel ends up in CLOSED and stays)
 * Either is a real product regression.
 */
import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData } from '../helpers/seed';
import { admin } from '../helpers/constants';

test.describe('Realtime resilience — WebSocket reconnect', () => {
  test('disconnect → admin mutation → UI still refreshes within 30s', async ({ page }) => {
    test.setTimeout(90_000);
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'rt-ws-reconnect');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];

      await page.goto('/chef/inventory');
      const stockBadge = page.getByTestId(`stock-badge-${chickenId}`);
      await expect(stockBadge).toBeVisible({ timeout: 30_000 });
      await expect(stockBadge).toHaveText('3.0 ctn', { timeout: 15_000 });

      // Let the app's subscription reach SUBSCRIBED state before tearing down.
      // 2s is generous — the channel usually transitions within a few hundred ms
      // after the component mounts.
      await page.waitForTimeout(2_000);

      // Close the underlying WebSocket AND suppress supabase-js's built-in
      // auto-reconnect, so we end up in the "stuck disconnected" state that
      // prod tabs hit when they wake from a long background period and the
      // library's reconnectTimer has been garbage-collected / stopped.
      // This forces the test to exercise OUR reconnect handler in
      // `useRealtimeInvalidation` rather than the lib's own recovery path —
      // if our handler regresses, the socket stays dead and the UI never
      // catches up.
      await page.evaluate(async () => {
        const mod = await import(/* @vite-ignore */ '/src/shared/supabase.ts');
        const client = mod.supabase;
        const rt: any = client.realtime;
        // Kill the built-in reconnect timer by nulling it out; any
        // library-driven recovery is now impossible until someone calls
        // `connect()` explicitly. The hook's close handler does exactly
        // that after a 300ms debounce.
        if (rt?.reconnectTimer?.reset) rt.reconnectTimer.reset();
        rt.reconnectTimer = null;
        if (rt?.conn && typeof rt.conn.close === 'function') {
          rt.conn.close();
        }
      });

      // Give the disconnect a moment to propagate, then mutate externally.
      // The reconnect happens in the background; we don't wait for it
      // deterministically — we just assert the UI eventually catches up.
      await page.waitForTimeout(3_000);

      const chef = (admin as any).schema('chefbyte');
      const { error: updErr } = await chef
        .from('stock_lots')
        .update({ qty_containers: 77 })
        .eq('product_id', chickenId)
        .eq('user_id', userId);
      expect(updErr).toBeNull();

      // 30s cap: reconnect + re-subscribe + postgres_changes event + refetch.
      // This timeout is intentionally loose — Supabase's backoff can take a
      // few seconds on the first retry. If it exceeds 30s we have a real
      // reconnect regression to fix.
      await expect(stockBadge).toHaveText('77.0 ctn', { timeout: 30_000 });
    } finally {
      await cleanup();
    }
  });
});
