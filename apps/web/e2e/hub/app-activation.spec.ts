import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function seedAndLogin(page: import('@playwright/test').Page, suffix: string) {
  const email = `e2e-apps-${suffix}-${Date.now()}@test.com`;
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

test.describe('App activation', () => {
  test('apps page shows CoachByte and ChefByte cards', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'cards');
    try {
      await page.goto('/hub/apps');
      await expect(page.getByText('CoachByte')).toBeVisible({ timeout: 5000 });
      await expect(page.getByText('ChefByte')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('both initially inactive', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'initial');
    try {
      await page.goto('/hub/apps');
      const inactiveChips = page.getByText('Inactive');
      await expect(inactiveChips.first()).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('activate CoachByte shows Active status', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'activate');
    try {
      await page.goto('/hub/apps');
      // Click first Activate button (CoachByte)
      await page.getByRole('button', { name: /activate/i }).first().click();
      await expect(page.getByText('Active').first()).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('deactivate shows confirmation modal', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'confirm');
    try {
      await page.goto('/hub/apps');
      // Activate first
      await page.getByRole('button', { name: /activate/i }).first().click();
      await expect(page.getByText('Active').first()).toBeVisible({ timeout: 5000 });

      // Click Deactivate
      await page.getByRole('button', { name: /deactivate/i }).first().click();
      await expect(page.getByText(/are you sure/i)).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });
});
