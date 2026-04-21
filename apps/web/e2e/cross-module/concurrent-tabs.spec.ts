/**
 * Audit recommendation #26 (LOW): concurrent-tab Realtime propagation.
 *
 * Two `browserContext`s for the SAME user — NOT two tabs on one context.
 * Separate contexts = separate cookie jars + separate localStorage +
 * separate auth sessions, which is the closest we can get to "the user
 * opened the app on their phone AND their laptop simultaneously". Both
 * hit real Supabase Realtime; a mutation in context A must propagate
 * to context B via `postgres_changes` → `useRealtimeInvalidation` →
 * TanStack invalidate → refetch.
 *
 * If a future change accidentally scopes a Realtime subscription to a
 * single tab (e.g. a global singleton that short-circuits on
 * re-registration) or invalidates only within the originating tab's
 * query client, this test fails — context B never sees the consumption.
 *
 * Fidelity:
 *   - Two real Chromium browser contexts, each with its own page + WS.
 *   - Same user signed into both via the session-injection pattern
 *     (avoids login rate-limits from double sign-in).
 *   - Real consume path via the inventory "Remove Container" button.
 *   - Real Realtime socket for the cross-context delivery.
 *   - No page.reload() — we want to prove the passive refresh path.
 */
import { test, expect, type Browser } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { seedUser, seedChefByteData, signInWithRetry } from '../helpers/seed';
import { SUPABASE_URL, ANON_KEY } from '../helpers/constants';

/**
 * Sign the given browser context into the app as `email`/`password` via
 * the Supabase-session localStorage key. This matches the pattern used
 * by `loginToHub` in session-injection mode and avoids running two
 * UI logins against Supabase's rate-limited `/auth/v1/token` endpoint
 * back-to-back (which sporadically 429s in local dev).
 */
async function loginContext(
  browser: Browser,
  email: string,
  password: string,
): Promise<{ page: import('@playwright/test').Page; context: import('@playwright/test').BrowserContext }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Fetch a fresh session via the admin-anon client; reuse for this
  // context only.
  const authClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await signInWithRetry(authClient, email, password);
  if (error || !data.session) {
    throw new Error(`Sign-in failed for ${email}: ${error?.message ?? 'no session'}`);
  }

  const hostname = new URL(SUPABASE_URL).hostname;
  const ref = hostname.split('.')[0];
  const storageKey = `sb-${ref}-auth-token`;

  // Navigate once so localStorage is scoped to the app origin.
  await page.goto('/login');
  await page.evaluate(
    ({ key, session }) => {
      localStorage.setItem(key, JSON.stringify(session));
    },
    { key: storageKey, session: data.session },
  );
  await page.goto('/hub');
  await expect(page).toHaveURL(/\/hub/, { timeout: 15_000 });

  return { page, context: ctx };
}

test.describe('Concurrent tabs — Realtime cross-context invalidation', () => {
  test('same user, two browser contexts, consume in A propagates to B via Realtime', async ({ browser }) => {
    test.setTimeout(180_000);
    const { userId, email, password, cleanup } = await seedUser('concurrent-tabs');

    // Activate apps + seed data before opening browser contexts so both
    // log into a fully populated account.
    const seedingClient = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signInRes = await signInWithRetry(seedingClient, email, password);
    expect(signInRes.error).toBeNull();
    for (const app of ['coachbyte', 'chefbyte']) {
      const { error } = await (seedingClient as any).schema('hub').rpc('activate_app', { p_app_name: app });
      expect(error).toBeNull();
    }
    const { productMap } = await seedChefByteData(seedingClient, userId);
    const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];

    // ── Spin up contexts A and B ──
    const { page: pageA, context: ctxA } = await loginContext(browser, email, password);
    const { page: pageB, context: ctxB } = await loginContext(browser, email, password);

    try {
      // Both navigate to inventory.
      await pageA.goto('/chef/inventory');
      await pageB.goto('/chef/inventory');
      const badgeA = pageA.getByTestId(`stock-badge-${chickenId}`);
      const badgeB = pageB.getByTestId(`stock-badge-${chickenId}`);
      await expect(badgeA).toBeVisible({ timeout: 30_000 });
      await expect(badgeB).toBeVisible({ timeout: 30_000 });
      await expect(badgeA).toContainText('3.0', { timeout: 15_000 });
      await expect(badgeB).toContainText('3.0', { timeout: 15_000 });

      // Give both pages a beat to finish subscribing to Realtime.
      // 2s is generous — the channel transitions to SUBSCRIBED within
      // a few hundred ms after mount.
      await pageA.waitForTimeout(2_000);

      // ── 1. Consume a container in context A ──
      // Expand the row so action buttons are visible, then click the
      // "Remove Container" button. qty 3.0 → 2.0.
      await pageA.getByTestId(`inv-row-toggle-${chickenId}`).click();
      await pageA.getByTestId(`sub-ctn-${chickenId}`).click();
      await expect(badgeA).toContainText('2.0', { timeout: 15_000 });

      // ── 2. Context B must reflect 2.0 via Realtime within 10s ──
      // No reload(). If the Realtime subscription isn't firing, or the
      // invalidation doesn't reach pageB's TanStack client, this stays
      // at "3.0" and fails. The 10s window covers socket latency +
      // React re-render; in practice delivery is <1s on local Supabase.
      await expect(badgeB).toContainText('2.0', { timeout: 10_000 });

      // ── 3. Add a product to the shopping list in context A ──
      // We exercise a different table (shopping_list) to prove the
      // subscription isn't accidentally scoped to one table.
      await pageA.goto('/chef/shopping');
      await expect(pageA.getByTestId('add-item-form')).toBeVisible({ timeout: 30_000 });

      const uniqueName = `CT-Probe-${Date.now()}`;
      await pageA.getByTestId('add-item-name').fill(uniqueName);
      // No dropdown selection — this creates a placeholder product.
      await pageA.getByTestId('add-item-btn').click();
      // Confirm it rendered in the to-buy list on A.
      await expect(pageA.getByTestId('to-buy-section')).toContainText(uniqueName, { timeout: 15_000 });

      // ── 4. Context B navigates to shopping, assert row appears ──
      // Because we navigate fresh to /chef/shopping in B, a normal
      // TanStack mount-refetch WOULD populate this row even without
      // Realtime. To keep the test focused on passive delivery, we
      // FIRST navigate B to shopping BEFORE adding on A, then re-add
      // in A while B is already on the page. We do this below as a
      // second sub-scenario.
      await pageB.goto('/chef/shopping');
      await expect(pageB.getByTestId('add-item-form')).toBeVisible({ timeout: 30_000 });
      await expect(pageB.getByTestId('to-buy-section')).toContainText(uniqueName, { timeout: 15_000 });

      // ── 5. Passive delivery: add a SECOND shopping row in A, with B
      //       already mounted on /chef/shopping. The row must appear in
      //       B without any navigation. Proves live cross-tab updates.
      const passiveName = `CT-Passive-${Date.now()}`;
      await pageA.getByTestId('add-item-name').fill(passiveName);
      await pageA.getByTestId('add-item-btn').click();
      await expect(pageA.getByTestId('to-buy-section')).toContainText(passiveName, { timeout: 15_000 });
      // B is already on /chef/shopping — must pick up the row live.
      await expect(pageB.getByTestId('to-buy-section')).toContainText(passiveName, { timeout: 15_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
      await cleanup();
    }
  });
});
