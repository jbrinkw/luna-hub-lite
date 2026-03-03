import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function seedAndLogin(page: import('@playwright/test').Page, suffix: string) {
  const email = `e2e-tools-${suffix}-${Date.now()}@test.com`;
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

test.describe('Tools page', () => {
  test('shows all 10 tool toggles', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'list');
    try {
      await page.goto('/hub/tools');
      await expect(page.getByText('COACHBYTE_LOG_SET')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('ion-toggle')).toHaveCount(10);
    } finally {
      await cleanup();
    }
  });

  test('toggle tool off and verify state change', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'toggle');
    try {
      await page.goto('/hub/tools');
      await expect(page.getByText('COACHBYTE_LOG_SET')).toBeVisible({ timeout: 5000 });

      // All tools start enabled — find the first toggle and click it off
      const firstToggle = page.locator('ion-toggle').first();
      await firstToggle.click();

      // Verify the toggle state changed
      await expect(firstToggle).not.toBeChecked();
    } finally {
      await cleanup();
    }
  });

  test('tool toggle persists after reload', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'persist');
    try {
      await page.goto('/hub/tools');
      await expect(page.getByText('COACHBYTE_LOG_SET')).toBeVisible({ timeout: 5000 });

      // Toggle first tool off
      const firstToggle = page.locator('ion-toggle').first();
      await firstToggle.click();
      await expect(firstToggle).not.toBeChecked();

      // Reload and verify state persisted
      await page.reload();
      await expect(page.getByText('COACHBYTE_LOG_SET')).toBeVisible({ timeout: 15000 });
      await expect(page.locator('ion-toggle').first()).not.toBeChecked();
    } finally {
      await cleanup();
    }
  });
});
