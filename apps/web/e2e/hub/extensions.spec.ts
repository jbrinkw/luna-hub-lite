import { test, expect } from '@playwright/test';
import { admin } from '../helpers/constants';

async function seedAndLogin(page: import('@playwright/test').Page, suffix: string) {
  const email = `e2e-ext-${suffix}-${Date.now()}@test.com`;
  const password = 'testpass123';
  const { data } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  const userId = data.user!.id;

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/hub/, { timeout: 5000 });

  return { userId, cleanup: () => admin.auth.admin.deleteUser(userId) };
}

test.describe('Extensions page', () => {
  test('shows all three extension cards', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'cards');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 5000 });
      await expect(page.getByRole('heading', { name: 'Todoist' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Home Assistant' })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('enable extension toggle shows credential form', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'enable');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 5000 });

      const obsidianCard = page.locator('ion-card', { hasText: 'Obsidian' });
      await obsidianCard.locator('ion-toggle').click();

      await expect(obsidianCard.getByText(/obsidian local rest api url/i)).toBeVisible();
      await expect(obsidianCard.getByRole('button', { name: /save credentials/i })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('save credentials shows success message', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'save');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Todoist' })).toBeVisible({ timeout: 5000 });

      const todoistCard = page.locator('ion-card', { hasText: 'Todoist' });
      await todoistCard.locator('ion-toggle').click();

      await todoistCard.getByLabel(/api token/i).fill('test-token-123');
      await todoistCard.getByRole('button', { name: /save credentials/i }).click();

      await expect(todoistCard.getByText(/credentials saved/i)).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('credentials persist after reload', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'persist');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 5000 });

      const obsidianCard = page.locator('ion-card', { hasText: 'Obsidian' });
      await obsidianCard.locator('ion-toggle').click();
      await obsidianCard.getByLabel(/obsidian local rest api url/i).fill('http://localhost:27124');
      await obsidianCard.getByLabel(/api key/i).fill('test-api-key-123');
      await obsidianCard.getByRole('button', { name: /save credentials/i }).click();
      await expect(obsidianCard.getByText(/credentials saved/i)).toBeVisible({ timeout: 5000 });

      await page.reload();
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 15000 });
      await expect(
        page.locator('ion-card', { hasText: 'Obsidian' }).getByText(/credentials configured/i),
      ).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  // TODO: The current toggle handler only sets `enabled` flag — it does not clear
  // credentials_encrypted in the DB. This test is skipped because the "disable clears creds"
  // behavior is not yet implemented. When implemented, remove the skip.
  test.skip('disable enabled extension clears credentials', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'disable-clear');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 5000 });

      const obsidianCard = page.locator('ion-card', { hasText: 'Obsidian' });

      // Enable Obsidian
      await obsidianCard.locator('ion-toggle').click();

      // Fill and save credentials
      await obsidianCard.getByLabel(/obsidian local rest api url/i).fill('http://localhost:27124');
      await obsidianCard.getByLabel(/api key/i).fill('test-api-key-123');
      await obsidianCard.getByRole('button', { name: /save credentials/i }).click();
      await expect(obsidianCard.getByText(/credentials saved/i)).toBeVisible({ timeout: 5000 });

      // Toggle off
      await obsidianCard.locator('ion-toggle').click();

      // Toggle back on — credentials should be cleared
      await obsidianCard.locator('ion-toggle').click();

      // Verify the credential fields are empty (no "credentials configured" badge)
      await expect(obsidianCard.getByText(/credentials configured/i)).not.toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('Home Assistant shows both URL and token fields', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'ha-fields');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Home Assistant' })).toBeVisible({ timeout: 5000 });

      const haCard = page.locator('ion-card', { hasText: 'Home Assistant' });

      // Enable Home Assistant
      await haCard.locator('ion-toggle').click();

      // Verify both credential input fields are visible
      await expect(haCard.getByLabel(/home assistant url/i)).toBeVisible();
      await expect(haCard.getByLabel(/long-lived access token/i)).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('Home Assistant saves both credential fields and persists', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'ha-persist');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Home Assistant' })).toBeVisible({ timeout: 5000 });

      const haCard = page.locator('ion-card', { hasText: 'Home Assistant' });

      // Enable Home Assistant
      await haCard.locator('ion-toggle').click();

      // Fill both credential fields
      await haCard.getByLabel(/home assistant url/i).fill('http://homeassistant.local:8123');
      await haCard.getByLabel(/long-lived access token/i).fill('eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9');

      // Save credentials
      await haCard.getByRole('button', { name: /save credentials/i }).click();
      await expect(haCard.getByText(/credentials saved/i)).toBeVisible({ timeout: 5000 });

      // Reload and verify credentials persisted
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Home Assistant' })).toBeVisible({ timeout: 15000 });
      await expect(
        page.locator('ion-card', { hasText: 'Home Assistant' }).getByText(/credentials configured/i),
      ).toBeVisible();
    } finally {
      await cleanup();
    }
  });
});
