import { test, expect } from '@playwright/test';
import { admin } from '../helpers/constants';
import { loginToHub } from '../helpers/seed';

async function seedAndLogin(page: import('@playwright/test').Page, suffix: string) {
  const email = `e2e-keys-${suffix}-${Date.now()}@test.com`;
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

test.describe('API key management', () => {
  test('MCP settings page shows endpoint URL', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'endpoint');
    try {
      await page.goto('/hub/mcp');
      await expect(page.getByText('https://mcp.lunahub.dev/sse')).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('generate API key displays key with lh_ prefix', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'gen');
    try {
      await page.goto('/hub/mcp');
      await page.getByRole('button', { name: /generate/i }).click();
      const keyEl = page.getByTestId('key-plaintext');
      await expect(keyEl).toBeVisible({ timeout: 30000 });
      // Verify the key actually has content starting with lh_ prefix
      await expect(keyEl).toHaveText(/^lh_[a-f0-9]{32}$/);
    } finally {
      await cleanup();
    }
  });

  test('dismiss hides key permanently', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'dismiss');
    try {
      await page.goto('/hub/mcp');
      await page.getByRole('button', { name: /generate/i }).click();
      await expect(page.getByTestId('key-plaintext')).toBeVisible({ timeout: 30000 });

      await page.getByRole('button', { name: /dismiss/i }).click();
      await expect(page.getByTestId('key-plaintext')).not.toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('revoke removes key from list', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'revoke');
    try {
      await page.goto('/hub/mcp');
      await page.getByRole('button', { name: /generate/i }).click();
      await expect(page.getByTestId('key-plaintext')).toBeVisible({ timeout: 30000 });
      await page.getByRole('button', { name: /dismiss/i }).click();

      // Key should be in the active list
      await expect(page.getByRole('button', { name: /revoke/i })).toBeVisible();

      // Revoke it
      await page.getByRole('button', { name: /revoke/i }).click();
      await expect(page.getByText('No active API keys')).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('key creation timestamp is displayed', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'timestamp');
    try {
      await page.goto('/hub/mcp');

      // Generate a key
      await page.getByRole('button', { name: /generate/i }).click();
      await expect(page.getByTestId('key-plaintext')).toBeVisible({ timeout: 30000 });

      // Dismiss the key display to see the key list
      await page.getByRole('button', { name: /dismiss/i }).click();

      // The key item should display "Created <date>" — verify the "Created" text is present
      // ApiKeyGenerator renders: <p>Created {new Date(key.created_at).toLocaleDateString()}</p>
      await expect(page.getByText(/^Created\s+\d/)).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('cannot generate more than limit API keys', async ({ page }) => {
    const { cleanup, userId } = await seedAndLogin(page, 'limit');
    try {
      await page.goto('/hub/mcp');
      await expect(page.getByRole('button', { name: /generate/i })).toBeVisible({ timeout: 30000 });

      // Pre-seed 10 keys directly in the DB to hit the limit
      // (instead of clicking 10 times through the UI)
      const hubAdmin = (admin as any).schema('hub');
      for (let i = 0; i < 10; i++) {
        const hash = `fakehash_limit_test_${i}_${Date.now()}`;
        await hubAdmin.from('api_keys').insert({ user_id: userId, api_key_hash: hash, label: `Key ${i + 1}` });
      }

      // Reload page so it picks up the 10 keys
      await page.reload();
      await expect(page.getByRole('button', { name: /generate/i })).toBeVisible({ timeout: 30000 });

      // Attempt to generate the 11th key — should show error
      await page.getByRole('button', { name: /generate/i }).click();

      // Verify the max-limit error message is displayed
      await expect(page.getByText(/maximum of 10 active api keys/i)).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });
});
