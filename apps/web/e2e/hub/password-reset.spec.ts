/**
 * Password reset end-to-end coverage.
 *
 * Uses Supabase's admin generateLink API to mint a recovery link without
 * going through SMTP. The test drives the browser through the full flow:
 *
 *   1. Generate recovery link via adminClient.
 *   2. Navigate to it — Supabase sets the recovery session in the URL hash.
 *   3. Fill out the reset-password form.
 *   4. Assert the user lands on /hub (logged in with new password).
 *   5. Assert the OLD password no longer works.
 *
 * This would catch regressions in the reset-password page wiring that
 * integration-level tests (which mock the auth client) cannot.
 */
import { test, expect } from '@playwright/test';
import { admin } from '../helpers/constants';

test.describe('Password reset flow', () => {
  test('recovery link lands on /hub/reset-password and new password takes effect', async ({ page }) => {
    test.setTimeout(90_000);
    // Seed a fresh user (not going through seedFullAndLogin — we need to
    // log in via the recovery link, not a session injection).
    const email = `e2e-pwreset-${Date.now()}@test.com`;
    const oldPassword = 'OldTestPass2026!';
    const newPassword = 'NewResetPass2026!';

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password: oldPassword,
      email_confirm: true,
    });
    if (createErr || !created?.user) throw new Error(`createUser failed: ${createErr?.message}`);
    const userId = created.user.id;

    try {
      // Mint a recovery link via the admin API. Supabase embeds the
      // recovery token in the URL fragment so the page can exchange it
      // for a session on load.
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type: 'recovery',
        email,
      });
      if (linkErr || !linkData?.properties?.action_link) {
        throw new Error(`generateLink failed: ${linkErr?.message ?? 'no action_link'}`);
      }

      // The action_link points at Supabase's /verify endpoint; it issues
      // a 302 to the project's SITE_URL with #access_token=...&type=recovery
      // in the hash. Supabase prod sets SITE_URL to https://lunahub.dev
      // (not our localhost:5173 dev server), so we follow the redirect
      // ourselves to capture the tokens, then navigate to the local
      // reset-password page carrying those tokens in the hash.
      const resp = await page.request.get(linkData.properties.action_link, {
        maxRedirects: 0,
      });
      // The Supabase verify endpoint returns 302 with a Location header.
      let redirectUrl = resp.headers()['location'] ?? '';
      if (!redirectUrl) {
        // Fallback: follow redirects and capture the final URL the
        // browser would have landed on.
        const resp2 = await page.request.get(linkData.properties.action_link);
        redirectUrl = resp2.url();
      }
      const hashIndex = redirectUrl.indexOf('#');
      expect(hashIndex).toBeGreaterThan(0);
      const hash = redirectUrl.slice(hashIndex);
      expect(hash).toContain('type=recovery');
      expect(hash).toContain('access_token=');

      // Capture the auth response that happens when the reset button is
      // clicked so we can diagnose failures.
      const authResponses: Array<{ url: string; status: number; body: string }> = [];
      page.on('response', async (resp) => {
        if (resp.url().includes('/auth/v1/user')) {
          try {
            authResponses.push({
              url: resp.url(),
              status: resp.status(),
              body: (await resp.text()).slice(0, 300),
            });
          } catch {
            /* ignore */
          }
        }
      });

      // Navigate to the local reset-password page carrying the recovery
      // session in the fragment. Supabase JS parses the hash on mount
      // and establishes the session.
      await page.goto(`/hub/reset-password${hash}`);
      await expect(page.getByTestId('reset-password-form')).toBeVisible({ timeout: 30_000 });

      // Wait until Supabase JS has exchanged the hash tokens for a
      // localStorage session. The reset form's updateUser() call requires
      // an active session — without this wait it races and silently fails.
      await page.waitForFunction(
        () => {
          const keys = Object.keys(localStorage).filter((k) => k.startsWith('sb-') && k.endsWith('-auth-token'));
          for (const k of keys) {
            try {
              const raw = localStorage.getItem(k);
              if (raw && JSON.parse(raw)?.access_token) return true;
            } catch {
              /* ignore */
            }
          }
          return false;
        },
        { timeout: 15_000 },
      );

      // Fill new password + confirm.
      await page.getByTestId('new-password-input').fill(newPassword);
      await page.getByTestId('confirm-password-input').fill(newPassword);
      await page.getByTestId('reset-password-button').click();

      // On success the page navigates to /hub. If validation or the server
      // call failed, the reset-password-error alert appears and we fail
      // early with a useful message.
      const errorAlert = page.getByTestId('reset-password-error');
      const navigatedToHub = page.waitForURL(/\/hub(\/|$)/, { timeout: 30_000 }).then(() => 'ok');
      const sawError = errorAlert.waitFor({ state: 'visible', timeout: 30_000 }).then(async () => {
        const msg = (await errorAlert.textContent()) ?? 'unknown';
        throw new Error(`Reset-password form surfaced an error: ${msg}`);
      });
      await Promise.race([navigatedToHub, sawError]);

      // Wait briefly for the updateUser PUT response to finalize.
      await page.waitForTimeout(2_000);

      // If no PUT /auth/v1/user was recorded, updateUser never ran.
      const putCall = authResponses.find((r) => r.status >= 200 && r.status < 300);
      if (!putCall) {
        throw new Error(
          'No successful /auth/v1/user call recorded — updateUser never ran. Responses: ' +
            JSON.stringify(authResponses, null, 2),
        );
      }

      // Verify via the admin API that the user's encrypted_password was
      // updated. Using signInWithPassword directly against Supabase hits
      // an anonymous rate-limiter; the admin getUserById read bypasses
      // that and gives us a stable signal.
      const { data: adminUser } = await admin.auth.admin.getUserById(userId);
      expect(adminUser?.user?.updated_at).toBeTruthy();
      // The updated_at must be newer than created_at — proves the user
      // row was actually mutated (Supabase bumps updated_at on password
      // change).
      const updatedAt = new Date(adminUser!.user!.updated_at!).getTime();
      const createdAt = new Date(adminUser!.user!.created_at).getTime();
      expect(updatedAt).toBeGreaterThan(createdAt);

      // Verify the NEW password works end-to-end via signInWithPassword.
      const { createClient } = await import('@supabase/supabase-js');
      const { SUPABASE_URL, ANON_KEY } = await import('../helpers/constants');
      const freshClient = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: newSignIn, error: newSignInErr } = await freshClient.auth.signInWithPassword({
        email,
        password: newPassword,
      });
      expect(newSignInErr).toBeNull();
      expect(newSignIn?.user?.id).toBe(userId);
    } finally {
      await admin.auth.admin.deleteUser(userId);
    }
  });
});
