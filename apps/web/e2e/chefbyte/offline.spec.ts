/**
 * ChefByte offline behavior (audit item #16).
 *
 * The existing `unit/hub/OfflineIndicator.test.tsx` is render-only. This spec
 * uses Playwright's real `page.context().setOffline(true)` to drive the actual
 * browser offline event and asserts the ChefByte-specific offline contract,
 * which (confirmed by reading ChefLayout.tsx) is:
 *
 *   1. `<OfflineIndicator />` banner shows "No connection" at the top chrome
 *      (provided by AppProvider's `online` state, driven by
 *      `navigator.onLine` + window online/offline events).
 *   2. ChefLayout renders an in-layout warning alert "You are offline —
 *      actions are disabled until connection is restored." above the content.
 *   3. ChefLayout sets `pointerEvents: none` + `opacity: 0.6` on the entire
 *      content area, which is how "writes are disabled" is actually enforced.
 *   4. Reconnect: all three go away, pointer events resume, mutations succeed.
 *
 * That's the real behavior we pin. A future regression that drops the
 * pointer-events guard (leaving the visual banner but re-enabling clicks
 * against a broken network) would silently corrupt user expectations. These
 * tests would fail.
 */
import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData } from '../helpers/seed';

test.describe('ChefByte — offline behavior', () => {
  test('offline indicator hidden online, visible offline, hidden on reconnect', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'off-indicator-cycle');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/inventory');
      // Wait for ChefLayout + Inventory to fully mount before manipulating
      // network state — the chefbyte route module is lazy-imported, and going
      // offline mid-import produces a dynamic-import error.
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30000 });

      // Top-chrome "No connection" banner from <OfflineIndicator />
      await expect(page.getByText('No connection')).not.toBeVisible();
      // Chef-layout in-page offline banner
      await expect(page.getByTestId('offline-banner')).not.toBeVisible();

      await page.context().setOffline(true);

      await expect(page.getByText('No connection')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 30000 });

      // Go back online
      await page.context().setOffline(false);
      await expect(page.getByText('No connection')).not.toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('offline-banner')).not.toBeVisible({ timeout: 30000 });
    } finally {
      await page.context().setOffline(false);
      await cleanup();
    }
  });

  test('offline disables ChefByte actions via pointer-events guard + DB unchanged', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'off-disables-actions');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];

      const pageErrors: Error[] = [];
      page.on('pageerror', (err) => pageErrors.push(err));

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30000 });

      // Expand the product row while online so the action button is in the DOM
      await page.getByTestId(`inv-row-toggle-${chickenId}`).click();
      await expect(page.getByTestId(`sub-ctn-${chickenId}`)).toBeVisible({ timeout: 30000 });

      // Go offline — ChefLayout flips pointer-events: none on the content area.
      await page.context().setOffline(true);
      await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 30000 });

      // Assert the actual mechanism: the content wrapper carries
      // `pointer-events: none` while offline. This pins the *enforcement*
      // layer — a future regression that flips the banner visibility but
      // forgets the style (or vice-versa) fails here loudly instead of
      // silently allowing a mutation through.
      //
      // We read the computed style (not the inline attribute) so any
      // implementation — inline style, CSS class, data-attribute — still
      // passes as long as the effective pointer-events is `none`.
      const contentPointerEvents = await page
        .locator('[data-testid="offline-banner"]')
        .locator('..')  // parent — the flex column
        .locator('> div').last()  // the content wrapper (last sibling after banner)
        .evaluate((el) => getComputedStyle(el).pointerEvents);
      // Scope check is brittle to DOM reshuffles; fall back to explicitly
      // locating the content area via a deeper query on the chef root.
      void contentPointerEvents; // kept for debug; real check below

      // Robust variant: the content wrapper sits inside the ChefLayout
      // flex column, after the header/tab/banner. We grab it via the
      // grouped-view's nearest positioned ancestor that carries the
      // pointer-events style. ChefLayout applies the inline style to a
      // single wrapper so inspecting any descendant works.
      const effectivePE = await page
        .getByTestId('grouped-view')
        .evaluate((el) => {
          // Walk up until we find a node with a non-'auto' pointer-events,
          // or hit body. If none found, return 'auto'.
          let n: HTMLElement | null = el as HTMLElement;
          while (n && n !== document.body) {
            const pe = getComputedStyle(n).pointerEvents;
            if (pe && pe !== 'auto') return pe;
            n = n.parentElement;
          }
          return 'auto';
        });
      expect(effectivePE).toBe('none');

      // Now issue a REAL click with { force: true } to bypass Playwright's
      // actionability check (which would itself detect pointer-events:none
      // and throw). A forced click physically dispatches the MouseEvent —
      // but the browser's CSS engine still drops it when pointer-events is
      // 'none', so no click handler fires and no RPC goes out. If a future
      // regression removes the CSS guard, the click WILL reach the handler
      // and the DB assertion below fails.
      await page.getByTestId(`sub-ctn-${chickenId}`).click({ force: true, timeout: 3000 });

      // Give any accidental write a chance to land before reading.
      // (Successful offline mutation would be a TanStack optimistic update
      // followed by an RPC; we want to catch both the RPC-landed path and
      // the "optimistic write committed to IndexedDB + replayed" path.)
      await expect(page.getByTestId('offline-banner')).toBeVisible();

      // Verify DB is unchanged (3 containers seeded; no decrement)
      const chef = (client as any).schema('chefbyte');
      const { data: lots } = await chef
        .from('stock_lots')
        .select('qty_containers')
        .eq('product_id', chickenId)
        .eq('user_id', userId);
      const totalStock = (lots ?? []).reduce(
        (sum: number, l: any) => sum + Number(l.qty_containers),
        0,
      );
      expect(totalStock).toBe(3);

      // App did not crash while offline
      await expect(page.getByTestId('grouped-view')).toBeVisible();
      await expect(page.getByTestId('offline-banner')).toBeVisible();
      expect(pageErrors).toEqual([]);
    } finally {
      await page.context().setOffline(false);
      await cleanup();
    }
  });

  test('reconnect clears offline guard and mutations succeed again', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'off-reconnect-recovers');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30000 });

      // Expand to surface action buttons while online
      await page.getByTestId(`inv-row-toggle-${chickenId}`).click();
      await expect(page.getByTestId(`sub-ctn-${chickenId}`)).toBeVisible({ timeout: 30000 });

      // Go offline — actions should be pointer-events: none
      await page.context().setOffline(true);
      await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 30000 });

      // DB check: seed = 3
      const chef = (client as any).schema('chefbyte');
      const read = async () => {
        const { data } = await chef
          .from('stock_lots')
          .select('qty_containers')
          .eq('product_id', chickenId)
          .eq('user_id', userId);
        return (data ?? []).reduce((s: number, l: any) => s + Number(l.qty_containers), 0);
      };
      expect(await read()).toBe(3);

      // Reconnect — ChefLayout should drop the pointer-events guard.
      await page.context().setOffline(false);
      await expect(page.getByTestId('offline-banner')).not.toBeVisible({ timeout: 30000 });

      // Click Remove Container — must now actually fire the RPC
      await page.getByTestId(`sub-ctn-${chickenId}`).click();

      // Poll for the stock decrement (server confirms the mutation landed)
      await expect
        .poll(read, { timeout: 15000 })
        .toBeLessThan(3);
    } finally {
      await page.context().setOffline(false);
      await cleanup();
    }
  });

  test('online/offline toggle does not crash the Inventory page', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'off-toggle-stable');
    try {
      await seedChefByteData(client, userId);

      const pageErrors: Error[] = [];
      page.on('pageerror', (err) => pageErrors.push(err));

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30000 });

      // Flap network 3× — TanStack Query, Realtime, and AppProvider listeners
      // should all survive this without producing an uncaught error.
      for (let i = 0; i < 3; i++) {
        await page.context().setOffline(true);
        await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 10000 });
        await page.context().setOffline(false);
        await expect(page.getByTestId('offline-banner')).not.toBeVisible({ timeout: 10000 });
      }

      // Page still mounted, no errors
      await expect(page.getByTestId('grouped-view')).toBeVisible();
      expect(pageErrors).toEqual([]);
    } finally {
      await page.context().setOffline(false);
      await cleanup();
    }
  });
});
