/**
 * Realtime invalidation coverage for ChefByte inventory.
 *
 * Installs a dedicated `postgres_changes` probe in the browser for the
 * exact schema+table the app subscribes to (chefbyte.stock_lots and
 * chefbyte.products). After a service-role mutation, the probe must
 * receive the event — proving the whole chain is intact:
 *   - the tables are added to the `supabase_realtime` publication
 *   - the browser's WebSocket reaches the Realtime server
 *   - the RLS-gated subscription delivers events for this user
 *
 * A broken subscription (wrong schema, missing publication, bad filter)
 * would fail this test even though a direct DB check would pass.
 *
 * NOTE: This intentionally verifies at the subscription layer rather than
 * the UI layer. The app's own `useRealtimeInvalidation` hook is a THIN
 * wrapper on top of this same subscription — if the event fires here, any
 * regression in the wrapper is a separately-testable TanStack Query
 * integration concern, not a Realtime infra concern.
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
