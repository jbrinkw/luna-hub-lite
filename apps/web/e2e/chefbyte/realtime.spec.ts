/**
 * Realtime invalidation coverage for ChefByte inventory.
 *
 * Two layers of assertions live in this file:
 *
 *  1. **Probe layer** (installProbe) — installs a dedicated
 *     `postgres_changes` channel in the browser on the same auth'd
 *     WebSocket and asserts the raw event arrives. Proves Realtime
 *     infra (publication, RLS filter, WS auth) is intact.
 *
 *  2. **UI-refresh layer** — relies on the app's own
 *     `useRealtimeInvalidation` hook firing, invalidating the correct
 *     TanStack Query key, and the component re-rendering with the new
 *     server data — all WITHOUT a manual `page.reload()`. These tests
 *     are load-bearing for the `refetchType: 'all'` fix in
 *     `src/shared/useRealtimeInvalidation.ts`; if that ever regresses
 *     to the default `'active'`, they fail because the page-mount race
 *     silently skips the refetch.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData } from '../helpers/seed';
import { admin } from '../helpers/constants';

/** Install a browser-side probe that records postgres_changes events. */
async function installProbe(page: Page, userId: string, table: 'stock_lots' | 'products') {
  await page.evaluate(
    async ([uid, tbl]) => {
      const win = window as any;
      win.__rtEvents = win.__rtEvents ?? {};
      win.__rtEvents[tbl] = [];
      // Import the app's Supabase client so the probe rides on the same
      // authenticated WebSocket the real subscriptions use.
      // Vite serves the app's supabase client at this URL in dev/preview.
      // Routing the path through a variable defeats TS's static module
      // resolution so the LSP stops warning about an unresolvable absolute
      // specifier, while the runtime import still resolves.
      const supabaseUrl = '/src/shared/supabase.ts';
      const mod: any = await import(/* @vite-ignore */ supabaseUrl);
      const client = mod.supabase;
      const channel = client
        .channel(`e2e-probe-${tbl}-${Date.now()}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'chefbyte', table: tbl, filter: `user_id=eq.${uid}` },
          (payload: any) => {
            win.__rtEvents[tbl].push({
              type: payload.eventType,
              new: payload.new,
              old: payload.old,
            });
          },
        );
      win.__rtReady = win.__rtReady ?? {};
      win.__rtReady[tbl] = false;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`subscribe timeout: ${tbl}`)), 15_000);
        channel.subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            clearTimeout(timeout);
            win.__rtReady[tbl] = true;
            resolve();
          }
        });
      });
    },
    [userId, table],
  );
}

test.describe('ChefByte Realtime — external mutations re-render UI', () => {
  test('external stock_lots mutation is delivered via postgres_changes to the browser', async ({ page }) => {
    test.setTimeout(60_000);
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'rt-stock-qty');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];

      await page.goto('/chef/inventory');
      await expect(page.getByTestId(`inv-product-${chickenId}`)).toBeVisible({ timeout: 30_000 });

      await installProbe(page, userId, 'stock_lots');

      // Externally mutate stock_lots via the service-role admin client.
      const chef = (admin as any).schema('chefbyte');
      const { error: updErr } = await chef
        .from('stock_lots')
        .update({ qty_containers: 42 })
        .eq('product_id', chickenId)
        .eq('user_id', userId);
      expect(updErr).toBeNull();

      // The browser-side probe must receive the UPDATE event within 15s.
      // This fails if the chefbyte.stock_lots table isn't in the realtime
      // publication, or if the subscription filter is wrong, or if the
      // channel never reached SUBSCRIBED.
      await page.waitForFunction(() => ((window as any).__rtEvents?.stock_lots?.length ?? 0) > 0, { timeout: 15_000 });

      const events: Array<{ type: string; new: any }> = await page.evaluate(
        () => (window as any).__rtEvents.stock_lots,
      );
      expect(events.length).toBeGreaterThan(0);
      const update = events.find((e) => e.type === 'UPDATE');
      expect(update).toBeTruthy();
      expect(Number(update!.new.qty_containers)).toBe(42);
    } finally {
      await cleanup();
    }
  });

  test('external products mutation is delivered via postgres_changes to the browser', async ({ page }) => {
    test.setTimeout(60_000);
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'rt-product-rename');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const riceId = productMap['Great Value Long Grain Brown Rice'];

      await page.goto('/chef/inventory');
      await expect(page.getByTestId(`inv-product-${riceId}`)).toBeVisible({ timeout: 30_000 });

      await installProbe(page, userId, 'products');

      // External rename via service-role admin.
      const NEW_NAME = 'Jasmine Rice (Renamed)';
      const chef = (admin as any).schema('chefbyte');
      const { error: updErr } = await chef
        .from('products')
        .update({ name: NEW_NAME })
        .eq('product_id', riceId)
        .eq('user_id', userId);
      expect(updErr).toBeNull();

      // Probe must receive the event — confirms the products subscription
      // is healthy (not silently broken by a schema-name typo, a missing
      // table in the publication, or a filter mismatch).
      await page.waitForFunction(() => ((window as any).__rtEvents?.products?.length ?? 0) > 0, { timeout: 15_000 });

      const events: Array<{ type: string; new: any }> = await page.evaluate(() => (window as any).__rtEvents.products);
      expect(events.length).toBeGreaterThan(0);
      const update = events.find((e) => e.type === 'UPDATE');
      expect(update).toBeTruthy();
      expect(update!.new.name).toBe(NEW_NAME);
    } finally {
      await cleanup();
    }
  });
});

/**
 * ================================================================
 * UI-REFRESH LAYER
 * ================================================================
 * These tests assert the DOM actually updates after an external
 * mutation, without calling `page.reload()`. The probe-layer tests
 * above only verify the event was delivered; these verify the
 * `useRealtimeInvalidation` hook converts that event into a real
 * component re-render with the new server data.
 *
 * They intentionally use tight timeouts (< 15s) so they cannot be
 * satisfied by `refetchInterval`-based polling that some queries
 * configure as a safety net. A passing result here proves the
 * refresh is driven by Realtime, not by the fallback poll.
 */
test.describe('ChefByte Realtime — UI refreshes without page.reload', () => {
  test('external stock_lots qty mutation → inventory row re-renders within 10s', async ({ page }) => {
    test.setTimeout(60_000);
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'rt-ui-stock-qty');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];

      await page.goto('/chef/inventory');
      // Seed puts chicken at qty_containers = 3, which renders as "3.0 ctn".
      const stockBadge = page.getByTestId(`stock-badge-${chickenId}`);
      await expect(stockBadge).toBeVisible({ timeout: 30_000 });
      await expect(stockBadge).toHaveText('3.0 ctn', { timeout: 15_000 });

      // External mutation via service-role admin client.
      const chef = (admin as any).schema('chefbyte');
      const { error: updErr } = await chef
        .from('stock_lots')
        .update({ qty_containers: 42 })
        .eq('product_id', chickenId)
        .eq('user_id', userId);
      expect(updErr).toBeNull();

      // The stock_lots query has NO refetchInterval, so this can only
      // succeed via realtime invalidation. 10s is well below any plausible
      // TanStack Query stale/gc race window.
      await expect(stockBadge).toHaveText('42.0 ctn', { timeout: 10_000 });
    } finally {
      await cleanup();
    }
  });

  test('external product rename → inventory row re-renders with new name within 10s', async ({ page }) => {
    test.setTimeout(60_000);
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'rt-ui-product-rename');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const riceId = productMap['Great Value Long Grain Brown Rice'];

      await page.goto('/chef/inventory');
      // The inventory row card contains the product name — assert the
      // original name is rendered first so we have a stable baseline.
      const row = page.getByTestId(`inv-product-${riceId}`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toContainText('Great Value Long Grain Brown Rice', { timeout: 15_000 });

      // External rename.
      const NEW_NAME = 'Jasmine Rice (Renamed via Realtime)';
      const chef = (admin as any).schema('chefbyte');
      const { error: updErr } = await chef
        .from('products')
        .update({ name: NEW_NAME })
        .eq('product_id', riceId)
        .eq('user_id', userId);
      expect(updErr).toBeNull();

      // products query has no refetchInterval — realtime-driven only.
      await expect(row).toContainText(NEW_NAME, { timeout: 10_000 });
    } finally {
      await cleanup();
    }
  });

  /**
   * SCOPE NOTE — `chefbyte.live_shelf_devices` is not currently in the
   * `supabase_realtime` publication on production (confirmed via server-
   * side `status: error` reply with the precise message
   * "Unable to subscribe to changes with given parameters ... table:
   * live_shelf_devices"). Adding it requires a migration in `supabase/`,
   * which is out of scope for this spec. So this test is expected to
   * fail against prod until the publication is updated — when that
   * happens, remove the `test.fail` marker and it becomes a regression
   * guard for the Scales tab heartbeat refresh.
   *
   * Finding also motivated the `channel-per-table` fix in
   * `useRealtimeInvalidation.ts`: previously ONE unpublished table
   * silenced ALL subscriptions on the shared `inventory-changes`
   * channel (including stock_lots and products). That's fixed now, so
   * scenarios 1 and 2 pass even while this one continues to fail.
   */
  test.fail('external live_shelf_devices heartbeat → Scales tab timestamp freshens within 10s', async ({ page }) => {
    test.setTimeout(60_000);
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'rt-ui-heartbeat');
    try {
      // Seed a shelf device with a heartbeat far enough in the past that the
      // rendered `relativeTime` will be something clearly non-"now" (minutes,
      // not seconds). This makes the "it changed to ~0s ago" assertion robust
      // against the natural second-level drift of the relative clock.
      const staleTs = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
      const chefAdmin = (admin as any).schema('chefbyte');
      const importKeyHash = 'a'.repeat(64); // 32-byte hex placeholder, satisfies NOT NULL
      const { data: insertRes, error: insErr } = await chefAdmin
        .from('live_shelf_devices')
        .insert({
          user_id: userId,
          device_name: 'RT UI Test Pi',
          import_key_hash: importKeyHash,
          last_heartbeat_ts: staleTs,
          pending_review_count: 0,
          is_active: true,
        })
        .select('device_id')
        .single();
      if (insErr) throw new Error(`Failed to seed shelf device: ${insErr.message}`);
      const deviceId: string = insertRes.device_id;

      await page.goto('/chef/settings?tab=scales');
      const heartbeat = page.getByTestId(`shelf-heartbeat-${deviceId}`);
      await expect(heartbeat).toBeVisible({ timeout: 30_000 });
      // Stale baseline: should read ~"10m ago" (allow fuzz for minutes bucket).
      await expect(heartbeat).toContainText(/\b\d+m ago\b/, { timeout: 15_000 });

      // External heartbeat bump — set last_heartbeat_ts to now().
      const { error: updErr } = await chefAdmin
        .from('live_shelf_devices')
        .update({ last_heartbeat_ts: new Date().toISOString() })
        .eq('device_id', deviceId)
        .eq('user_id', userId);
      expect(updErr).toBeNull();

      // Freshened render: seconds-granularity. The live_shelf_devices query
      // has a 15s refetchInterval safety net, so a 10s deadline guarantees
      // this can only be satisfied by realtime invalidation.
      await expect(heartbeat).toContainText(/\b\d+s ago\b/, { timeout: 10_000 });
    } finally {
      await cleanup();
    }
  });
});
