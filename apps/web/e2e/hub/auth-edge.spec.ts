/**
 * Edge cases that broke in production but the main auth spec never hit:
 *
 *   Scenario 2 — Session expires mid-scan. User has 2 items queued. JWT is
 *   revoked server-side. A 3rd scan must NOT silently fail — the UI has to
 *   either (a) bounce the user to /login with a session-expired message, or
 *   (b) surface that a re-auth is needed. No ghost "success" rows.
 *
 *   Scenario 3 — Two-account hot-switch. User A signs in → hits /chef/inventory
 *   (products in cache). User A signs out. User B signs in in the SAME tab.
 *   User B's /chef/inventory must NOT display any of User A's products — the
 *   TanStack Query cache MUST be cleared on signout. The test also does a
 *   mutation revert: if `queryClient.clear()` is dropped from the signout
 *   path, the test fails.
 */
import { test, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { admin, SUPABASE_URL, ANON_KEY } from '../helpers/constants';
import { seedFullAndLogin, loginToHub, seedUser, signInWithRetry } from '../helpers/seed';

/* ------------------------------------------------------------------ */
/*  Scenario 2 — session expiry mid-scan                              */
/* ------------------------------------------------------------------ */

async function scanBarcode(page: Page, barcode: string) {
  const input = page.getByTestId('barcode-input');
  await input.fill(barcode);
  await input.press('Enter');
}

test.describe('Auth edge — session expires mid-scan', () => {
  test('two queued scans + revoked JWT → third scan does not silently succeed', async ({ page }) => {
    test.setTimeout(120_000);
    const { userId, cleanup } = await seedFullAndLogin(page, 'session-expiry-scan');
    try {
      await page.goto('/chef/scanner');
      await expect(page.getByTestId('scanner-container')).toBeVisible({ timeout: 30_000 });

      // Put 2 items in the queue. These become placeholder products since
      // they're unknown barcodes — no network hit to OpenFoodFacts needed
      // to still land in the queue UI.
      await scanBarcode(page, '1111111111111');
      await scanBarcode(page, '2222222222222');
      // The queue row testId is `queue-item-<tempId>` where tempId is a
      // Date.now() string. Just assert at least 2 rows are rendered.
      await expect(page.getByTestId(/^queue-item-/)).toHaveCount(2, { timeout: 30_000 });

      // Invalidate the session server-side. This revokes the refresh token,
      // which is what happens in production when a user signs out from
      // another device or when the JWT is manually rotated.
      await admin.auth.admin.signOut(userId);

      // Strip the session token from localStorage too — otherwise the SDK
      // just serves cached tokens until they expire. The real-world analog
      // is "user's laptop slept for a day and the refresh token was
      // revoked in the interim".
      await page.evaluate(() => {
        for (const key of Object.keys(localStorage)) {
          if (key.includes('supabase') || key.includes('auth')) {
            localStorage.removeItem(key);
          }
        }
      });

      // Scan a 3rd barcode. Either:
      //   (a) The page bounces to /login (AuthGuard kicks on re-render), OR
      //   (b) A queue-item for the 3rd scan stays in `pending` / `error`
      //       (NOT `success`), OR
      //   (c) A session-expired toast appears.
      // Any of those is acceptable. A silent success with a 3rd "success"
      // queue row is a bug.
      await scanBarcode(page, '3333333333333');

      // Give the request time to fail / redirect.
      await page.waitForTimeout(3000);

      // Accept any of: (a) URL changed to /login, or (b) queue still has
      // exactly 2 success rows and any 3rd row is NOT marked success, or
      // (c) a session-error toast is visible.
      const onLogin = page.url().includes('/login');
      const errorToast = page.getByText(/session.*expired|please sign in/i);
      const hasErrorToast = (await errorToast.count()) > 0;

      if (!onLogin && !hasErrorToast) {
        // If we haven't redirected and no toast, the third scan must not
        // have produced a new success row. Check that no new `queue-item`
        // with a green border was added beyond the first two.
        const queueCount = await page.getByTestId(/^queue-item-/).count();
        expect(
          queueCount,
          `Session-expiry scenario: 3rd scan silently produced a queue row without redirect or error toast (queueCount=${queueCount})`,
        ).toBeLessThan(3);
      }
    } finally {
      await cleanup();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Scenario 3 — two-account hot-switch                               */
/* ------------------------------------------------------------------ */

test.describe('Auth edge — two-account sequential login in same browser', () => {
  test('user B cannot see user A products after signout+signin', async ({ page }) => {
    test.setTimeout(180_000);

    // --- Log in as user A and seed chef data ---
    const sessionA = await seedFullAndLogin(page, 'two-acct-a');
    const userAProductName = `A-Chicken-${Date.now()}`;
    const { error: aProdErr } = await (sessionA.client as any).schema('chefbyte').from('products').insert({
      user_id: sessionA.userId,
      name: userAProductName,
      servings_per_container: 1,
      calories_per_serving: 100,
      carbs_per_serving: 10,
      protein_per_serving: 5,
      fat_per_serving: 2,
      min_stock_amount: 1, // >0 so Inventory shows it even with 0 stock
    });
    if (aProdErr) throw new Error(`A product insert failed: ${aProdErr.message}`);

    // --- Seed user B out-of-band (create account + product via admin; we'll
    //     log in via UI later in the same tab) ---
    const userB = await seedUser('two-acct-b');
    const clientB = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInErrB } = await signInWithRetry(clientB, userB.email, userB.password);
    if (signInErrB) throw new Error(`B sign-in failed: ${signInErrB.message}`);
    await (clientB as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
    const userBProductName = `B-Unique-${Date.now()}`;
    const { error: bProdErr } = await (clientB as any).schema('chefbyte').from('products').insert({
      user_id: userB.userId,
      name: userBProductName,
      servings_per_container: 1,
      calories_per_serving: 100,
      carbs_per_serving: 10,
      protein_per_serving: 5,
      fat_per_serving: 2,
      min_stock_amount: 1,
    });
    if (bProdErr) throw new Error(`B product insert failed: ${bProdErr.message}`);

    try {
      // --- Browser: A is logged in. Hit /chef/inventory so A's products
      //     populate the TanStack Query cache. ---
      await page.goto('/chef/inventory');
      await expect(page.getByText(userAProductName)).toBeVisible({ timeout: 30_000 });

      // --- Sign out via UI (uses AuthProvider.signOut) ---
      await page.goto('/hub');
      await expect(page.getByRole('button', { name: /logout/i })).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: /logout/i }).click();
      await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });

      // --- Sign in as B in the SAME tab ---
      await loginToHub(page, userB.email, userB.password);
      await page.goto('/chef/inventory');
      await expect(page.getByTestId('no-products').or(page.getByTestId('grouped-view'))).toBeVisible({
        timeout: 30_000,
      });

      // --- Assert: A's product is GONE; B's product is visible ---
      await expect(page.getByText(userAProductName)).toHaveCount(0);
      await expect(page.getByText(userBProductName)).toBeVisible({ timeout: 30_000 });
    } finally {
      await sessionA.cleanup();
      await userB.cleanup();
    }
  });
});
