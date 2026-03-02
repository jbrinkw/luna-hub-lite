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
      await expect(page.getByText('https://mcp.lunahub.dev/sse')).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('generate API key displays key', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'gen');
    try {
      await page.goto('/hub/mcp');
      await page.getByRole('button', { name: /generate/i }).click();
      await expect(page.getByTestId('key-plaintext')).toBeVisible({ timeout: 5000 });
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
});
