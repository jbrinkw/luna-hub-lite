import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function seedAndLogin(page: import('@playwright/test').Page, suffix: string) {
  const email = `e2e-prof-${suffix}-${Date.now()}@test.com`;
  const password = 'testpass123';
  const { data } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: `E2E ${suffix}` },
  });
  const userId = data.user!.id;

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/hub/, { timeout: 5000 });

  return { userId, email, password, cleanup: () => admin.auth.admin.deleteUser(userId) };
}

test.describe('Profile management', () => {
  test('account page shows profile form with current values', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'view');
    try {
      await page.goto('/hub/account');
      await expect(page.getByLabel('Display Name')).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('edit display_name and save shows success', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'edit-name');
    try {
      await page.goto('/hub/account');
      const nameInput = page.getByLabel('Display Name');
      await nameInput.clear();
      await nameInput.fill('New Display Name');
      await page.getByRole('button', { name: /save profile/i }).click();
      await expect(page.getByText(/profile updated/i)).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('reload after edit shows updated display_name', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'reload');
    try {
      await page.goto('/hub/account');
      const nameInput = page.getByLabel('Display Name');
      await nameInput.clear();
      await nameInput.fill('Persisted Name');
      await page.getByRole('button', { name: /save profile/i }).click();
      await expect(page.getByText(/profile updated/i)).toBeVisible({ timeout: 5000 });

      await page.reload();
      await expect(page.getByLabel('Display Name')).toHaveValue('Persisted Name', { timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('change password succeeds', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'pw-change');
    try {
      await page.goto('/hub/account');
      await page.getByLabel('New Password').fill('newpassword123');
      await page.getByLabel('Confirm Password').fill('newpassword123');
      await page.getByRole('button', { name: /change password/i }).click();
      await expect(page.getByText(/password updated/i)).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });
});
