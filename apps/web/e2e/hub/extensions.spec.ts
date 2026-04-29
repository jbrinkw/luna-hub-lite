import { test, expect } from '@playwright/test';
import { admin } from '../helpers/constants';
import { loginToHub } from '../helpers/seed';

async function seedAndLogin(page: import('@playwright/test').Page, suffix: string) {
  const email = `e2e-ext-${suffix}-${Date.now()}@test.com`;
  const password = 'testpass123';
  const { data } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  const userId = data.user!.id;

  await loginToHub(page, email, password);

  return { userId, cleanup: () => admin.auth.admin.deleteUser(userId) };
}

test.describe('Extensions page', () => {
  test('shows all three extension cards', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'cards');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 30000 });
      await expect(page.getByRole('heading', { name: 'Todoist' })).toBeVisible({ timeout: 30000 });
      await expect(page.getByRole('heading', { name: 'Home Assistant' })).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('enable extension toggle shows credential form', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'enable');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 30000 });

      const obsidianCard = page.locator('ion-card', { hasText: 'Obsidian' });
      await obsidianCard.locator('ion-toggle').click();

      await expect(obsidianCard.getByText(/obsidian local rest api url/i)).toBeVisible({ timeout: 30000 });
      await expect(obsidianCard.getByRole('button', { name: /save credentials/i })).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('save credentials shows success message', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'save');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Todoist' })).toBeVisible({ timeout: 30000 });

      const todoistCard = page.locator('ion-card', { hasText: 'Todoist' });
      await todoistCard.locator('ion-toggle').click();

      await todoistCard.getByLabel(/api token/i).fill('test-token-123');
      await todoistCard.getByRole('button', { name: /save credentials/i }).click();

      await expect(todoistCard.getByText(/credentials saved/i)).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('credentials persist after reload', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'persist');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 30000 });

      const obsidianCard = page.locator('ion-card', { hasText: 'Obsidian' });
      await obsidianCard.locator('ion-toggle').click();
      await obsidianCard.getByLabel(/obsidian local rest api url/i).fill('http://localhost:27124');
      await obsidianCard.getByLabel(/api key/i).fill('test-api-key-123');
      await obsidianCard.getByRole('button', { name: /save credentials/i }).click();
      await expect(obsidianCard.getByText(/credentials saved/i)).toBeVisible({ timeout: 30000 });

      await page.reload();
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 30000 });
      await expect(page.locator('ion-card', { hasText: 'Obsidian' }).getByText(/credentials configured/i)).toBeVisible({
        timeout: 30000,
      });
    } finally {
      await cleanup();
    }
  });

  // Disabling an extension clears its stored credentials (2026-04-29).
  // Re-enabling forces re-entry — preferable to silently reusing a stale
  // token after a deliberate disable. Implementation: ExtensionsPage's
  // toggleMutation calls hub.clear_extension_credentials() when enabled
  // becomes false (post-Vault migration; the legacy
  // `credentials_encrypted = null` upsert is gone).
  //
  // NOTE: this suite was originally written against an Ionic build of the
  // page. The current page is a Vite SPA using the ui-kit Toggle (a
  // role="switch" button with aria-label "Enable <DisplayName>"). This
  // test uses the modern selectors so it actually exercises the disable-
  // clear-creds wiring; the other tests in the file targeting `ion-card`
  // are pre-existing stale tests outside this batch's scope.
  test('disable enabled extension clears credentials', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'disable-clear');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 30000 });

      // Click the Obsidian toggle (role=switch, aria-label="Enable Obsidian")
      const obsidianToggle = page.getByRole('switch', { name: /enable obsidian/i });
      await obsidianToggle.click();

      // Fill and save credentials. ExtensionsPage labels:
      //   "GitHub Repo (owner/repo)", "GitHub Personal Access Token"
      await page.getByLabel(/github repo/i).fill('owner/repo');
      await page.getByLabel(/github personal access token/i).fill('test-token-123');
      await page.getByRole('button', { name: /save credentials/i }).click();

      // "Credentials configured" badge should appear after save settles
      await expect(page.getByText(/credentials configured/i)).toBeVisible({ timeout: 30000 });

      // Toggle OFF — should clear the vault secret (vault_secret_id -> NULL,
      // underlying vault.secrets row deleted by hub.clear_extension_credentials).
      await obsidianToggle.click();

      // After the optimistic update + refetch, the badge should flip back
      // to "Not configured" since vault_secret_id is now NULL.
      await expect(page.getByText(/not configured/i)).toBeVisible({ timeout: 30000 });
      await expect(page.getByText(/credentials configured/i)).not.toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('Home Assistant shows both URL and token fields', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'ha-fields');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Home Assistant' })).toBeVisible({ timeout: 30000 });

      const haCard = page.locator('ion-card', { hasText: 'Home Assistant' });

      // Enable Home Assistant
      await haCard.locator('ion-toggle').click();

      // Verify both credential input fields are visible
      await expect(haCard.getByLabel(/home assistant url/i)).toBeVisible({ timeout: 30000 });
      await expect(haCard.getByLabel(/long-lived access token/i)).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('Home Assistant saves both credential fields and persists', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'ha-persist');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Home Assistant' })).toBeVisible({ timeout: 30000 });

      const haCard = page.locator('ion-card', { hasText: 'Home Assistant' });

      // Enable Home Assistant
      await haCard.locator('ion-toggle').click();

      // Fill both credential fields
      await haCard.getByLabel(/home assistant url/i).fill('http://homeassistant.local:8123');
      await haCard.getByLabel(/long-lived access token/i).fill('eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9');

      // Save credentials
      await haCard.getByRole('button', { name: /save credentials/i }).click();
      await expect(haCard.getByText(/credentials saved/i)).toBeVisible({ timeout: 30000 });

      // Reload and verify credentials persisted
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Home Assistant' })).toBeVisible({ timeout: 30000 });
      await expect(
        page.locator('ion-card', { hasText: 'Home Assistant' }).getByText(/credentials configured/i),
      ).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });
});
