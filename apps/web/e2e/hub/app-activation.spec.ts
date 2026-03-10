import { test, expect } from '@playwright/test';
import { admin } from '../helpers/constants';
import { loginToHub } from '../helpers/seed';

async function seedAndLogin(page: import('@playwright/test').Page, suffix: string) {
  const email = `e2e-apps-${suffix}-${Date.now()}@test.com`;
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

test.describe('App activation', () => {
  test('apps page shows CoachByte and ChefByte cards', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'cards');
    try {
      await page.goto('/hub/apps');
      await expect(page.locator('ion-card', { hasText: 'CoachByte' })).toBeVisible({ timeout: 30000 });
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
      await expect(cards).toHaveCount(2, { timeout: 30000 });
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
      await expect(coachCard.getByText('Active', { exact: true })).toBeVisible({ timeout: 30000 });
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
      await expect(coachCard.getByText('Active', { exact: true })).toBeVisible({ timeout: 30000 });

      // Click Deactivate on CoachByte
      await coachCard.getByRole('button', { name: /deactivate/i }).click();
      await expect(page.getByText('Are you sure you want to deactivate CoachByte?')).toBeVisible({ timeout: 30000 });
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
      await expect(coachCard.getByText('Active', { exact: true })).toBeVisible({ timeout: 30000 });

      // Deactivate — click confirm in the alert
      await coachCard.getByRole('button', { name: /deactivate/i }).click();
      await expect(page.getByText('Are you sure you want to deactivate CoachByte?')).toBeVisible({ timeout: 30000 });
      await page.getByRole('button', { name: /confirm/i }).click();

      // Should be back to Inactive
      await expect(coachCard.getByText('Inactive', { exact: true })).toBeVisible({ timeout: 30000 });
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
      await expect(coachCard.getByText('Active', { exact: true })).toBeVisible({ timeout: 30000 });

      // Deactivate — click cancel in the alert
      await coachCard.getByRole('button', { name: /deactivate/i }).click();
      await expect(page.getByText('Are you sure you want to deactivate CoachByte?')).toBeVisible({ timeout: 30000 });
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
      await expect(coachCard.getByText('Active', { exact: true })).toBeVisible({ timeout: 30000 });

      // Reload
      await page.reload();
      await expect(page.locator('ion-card', { hasText: 'CoachByte' }).getByText('Active', { exact: true })).toBeVisible(
        { timeout: 30000 },
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
