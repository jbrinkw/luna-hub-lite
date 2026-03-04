import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function seedAndLogin(page: import('@playwright/test').Page, suffix: string) {
  const email = `e2e-keys-${suffix}-${Date.now()}@test.com`;
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

test.describe('API key management', () => {
  test('MCP settings page shows endpoint URL', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'endpoint');
    try {
      await page.goto('/hub/mcp');
      await expect(page.getByText('https://mcp.lunahub.dev/sse')).toBeVisible({ timeout: 15000 });
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
      await expect(keyEl).toBeVisible({ timeout: 5000 });
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
      await expect(page.getByTestId('key-plaintext')).toBeVisible({ timeout: 5000 });

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
      await expect(page.getByTestId('key-plaintext')).toBeVisible({ timeout: 5000 });
      await page.getByRole('button', { name: /dismiss/i }).click();

      // Key should be in the active list
      await expect(page.getByRole('button', { name: /revoke/i })).toBeVisible();

      // Revoke it
      await page.getByRole('button', { name: /revoke/i }).click();
      await expect(page.getByText('No active API keys')).toBeVisible({ timeout: 5000 });
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
      await expect(page.getByTestId('key-plaintext')).toBeVisible({ timeout: 5000 });

      // Dismiss the key display to see the key list
      await page.getByRole('button', { name: /dismiss/i }).click();

      // The key item should display "Created <date>" — verify the "Created" text is present
      // ApiKeyGenerator renders: <p>Created {new Date(key.created_at).toLocaleDateString()}</p>
      await expect(page.getByText(/^Created\s+\d/)).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('cannot generate more than limit API keys', async ({ page }) => {
    const { cleanup, userId } = await seedAndLogin(page, 'limit');
    try {
      await page.goto('/hub/mcp');
      await expect(page.getByRole('button', { name: /generate/i })).toBeVisible({ timeout: 5000 });

      // Pre-seed 10 keys directly in the DB to hit the limit
      // (instead of clicking 10 times through the UI)
      const hubAdmin = (admin as any).schema('hub');
      for (let i = 0; i < 10; i++) {
        const hash = `fakehash_limit_test_${i}_${Date.now()}`;
        await hubAdmin.from('api_keys').insert({ user_id: userId, api_key_hash: hash, label: `Key ${i + 1}` });
      }

      // Reload page so it picks up the 10 keys
      await page.reload();
      await expect(page.getByRole('button', { name: /generate/i })).toBeVisible({ timeout: 5000 });

      // Attempt to generate the 11th key — should show error
      await page.getByRole('button', { name: /generate/i }).click();

      // Verify the max-limit error message is displayed
      await expect(page.getByText(/maximum of 10 active api keys/i)).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });
});
