import { test, expect } from '@playwright/test';
import { admin } from '../helpers/constants';

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
  test('shows all 41 tool toggles', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'list');
    try {
      await page.goto('/hub/tools');
      await expect(page.getByText('COACHBYTE_complete_next_set')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('ion-toggle')).toHaveCount(41);
    } finally {
      await cleanup();
    }
  });

  test('toggle tool off and verify state change', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'toggle');
    try {
      await page.goto('/hub/tools');
      await expect(page.getByText('COACHBYTE_complete_next_set')).toBeVisible({ timeout: 5000 });

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
      await expect(page.getByText('COACHBYTE_complete_next_set')).toBeVisible({ timeout: 5000 });

      // Toggle first tool off
      const firstToggle = page.locator('ion-toggle').first();
      await firstToggle.click();
      await expect(firstToggle).not.toBeChecked();

      // Reload and verify state persisted
      await page.reload();
      await expect(page.getByText('COACHBYTE_complete_next_set')).toBeVisible({ timeout: 15000 });
      await expect(page.locator('ion-toggle').first()).not.toBeChecked();
    } finally {
      await cleanup();
    }
  });

  test('tool groups are organized by module', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'groups');
    try {
      await page.goto('/hub/tools');
      await expect(page.getByText('COACHBYTE_complete_next_set')).toBeVisible({ timeout: 5000 });

      // Verify all group section headers/dividers are present
      // ToolsPage renders IonItemDivider with IonLabel for each group
      await expect(page.locator('ion-item-divider', { hasText: 'CoachByte' })).toBeVisible();
      await expect(page.locator('ion-item-divider', { hasText: 'ChefByte' })).toBeVisible();
      await expect(page.locator('ion-item-divider', { hasText: 'Obsidian' })).toBeVisible();
      await expect(page.locator('ion-item-divider', { hasText: 'Todoist' })).toBeVisible();
      await expect(page.locator('ion-item-divider', { hasText: 'Home Assistant' })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('tool descriptions are visible', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'desc');
    try {
      await page.goto('/hub/tools');
      await expect(page.getByText('COACHBYTE_complete_next_set')).toBeVisible({ timeout: 5000 });

      // Each tool renders a <p> with description text inside IonLabel.
      // Verify at least a few known tool descriptions are visible.
      await expect(page.getByText('Complete next planned set')).toBeVisible();
      await expect(page.getByText("Get today's workout plan")).toBeVisible();
      await expect(page.getByText('Consume stock from inventory')).toBeVisible();
    } finally {
      await cleanup();
    }
  });
});
