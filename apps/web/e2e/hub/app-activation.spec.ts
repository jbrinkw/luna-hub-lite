import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJFUzI1NiIsImtpZCI6ImI4MTI2OWYxLTIxZDgtNGYyZS1iNzE5LWMyMjQwYTg0MGQ5MCIsInR5cCI6IkpXVCJ9.eyJleHAiOjQ5MjY3MTcyNjEsImlhdCI6MTc3MzExNzI2MSwicm9sZSI6InNlcnZpY2Vfcm9sZSJ9.fDBVbcn1yiwrN85kw3c70Yhm__37cMWWZPhf8cqMY5QJ46pzGo5MfHQ-jPzgXLKecXWTRrW261e0ALQQqx-rUw';

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
      await expect(page.locator('ion-card', { hasText: 'CoachByte' })).toBeVisible({ timeout: 5000 });
      await expect(page.locator('ion-card', { hasText: 'ChefByte' })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('both initially inactive', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'initial');
    try {
      await page.goto('/hub/apps');
      // Verify BOTH apps show Inactive chip (not just one)
      const cards = page.locator('ion-card');
      await expect(cards).toHaveCount(2, { timeout: 5000 });
      await expect(cards.nth(0).getByText('Inactive', { exact: true })).toBeVisible();
      await expect(cards.nth(1).getByText('Inactive', { exact: true })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('activate CoachByte shows Active status', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'activate');
    try {
      await page.goto('/hub/apps');
      // Find the CoachByte card specifically, then click its Activate button
      const coachCard = page.locator('ion-card', { hasText: 'CoachByte' });
      await coachCard.getByRole('button', { name: /activate/i }).click();
      // Verify CoachByte card now shows Active chip
      await expect(coachCard.getByText('Active', { exact: true })).toBeVisible({ timeout: 5000 });
      // ChefByte should still be Inactive
      const chefCard = page.locator('ion-card', { hasText: 'ChefByte' });
      await expect(chefCard.getByText('Inactive', { exact: true })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('deactivate shows confirmation modal', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'confirm');
    try {
      await page.goto('/hub/apps');
      // Activate CoachByte specifically
      const coachCard = page.locator('ion-card', { hasText: 'CoachByte' });
      await coachCard.getByRole('button', { name: /activate/i }).click();
      await expect(coachCard.getByText('Active', { exact: true })).toBeVisible({ timeout: 5000 });

      // Click Deactivate on CoachByte
      await coachCard.getByRole('button', { name: /deactivate/i }).click();
      await expect(page.getByText('Are you sure you want to deactivate CoachByte?')).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('confirm deactivation returns to Inactive', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'deact-confirm');
    try {
      await page.goto('/hub/apps');
      const coachCard = page.locator('ion-card', { hasText: 'CoachByte' });

      // Activate
      await coachCard.getByRole('button', { name: /activate/i }).click();
      await expect(coachCard.getByText('Active', { exact: true })).toBeVisible({ timeout: 5000 });

      // Deactivate — click confirm in the alert
      await coachCard.getByRole('button', { name: /deactivate/i }).click();
      await expect(page.getByText('Are you sure you want to deactivate CoachByte?')).toBeVisible({ timeout: 5000 });
      await page.getByRole('button', { name: /confirm/i }).click();

      // Should be back to Inactive
      await expect(coachCard.getByText('Inactive', { exact: true })).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('cancel deactivation keeps app Active', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'deact-cancel');
    try {
      await page.goto('/hub/apps');
      const coachCard = page.locator('ion-card', { hasText: 'CoachByte' });

      // Activate
      await coachCard.getByRole('button', { name: /activate/i }).click();
      await expect(coachCard.getByText('Active', { exact: true })).toBeVisible({ timeout: 5000 });

      // Deactivate — click cancel in the alert
      await coachCard.getByRole('button', { name: /deactivate/i }).click();
      await expect(page.getByText('Are you sure you want to deactivate CoachByte?')).toBeVisible({ timeout: 5000 });
      await page.getByRole('button', { name: /cancel/i }).click();

      // Should still be Active
      await expect(coachCard.getByText('Active', { exact: true })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('activation persists after page reload', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'persist');
    try {
      await page.goto('/hub/apps');
      const coachCard = page.locator('ion-card', { hasText: 'CoachByte' });

      // Activate CoachByte
      await coachCard.getByRole('button', { name: /activate/i }).click();
      await expect(coachCard.getByText('Active', { exact: true })).toBeVisible({ timeout: 5000 });

      // Reload
      await page.reload();
      await expect(page.locator('ion-card', { hasText: 'CoachByte' }).getByText('Active', { exact: true })).toBeVisible(
        { timeout: 15000 },
      );

      // ChefByte should still be Inactive
      await expect(
        page.locator('ion-card', { hasText: 'ChefByte' }).getByText('Inactive', { exact: true }),
      ).toBeVisible();
    } finally {
      await cleanup();
    }
  });
});
