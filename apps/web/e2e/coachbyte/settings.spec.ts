import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedCoachByteData } from '../helpers/seed';

test.describe('CoachByte Settings', () => {
  test('settings page loads with all cards', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-cards');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/settings');

      await expect(page.getByTestId('defaults-card')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('plate-calc-card')).toBeVisible();
      await expect(page.getByTestId('exercise-library-card')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('default rest input is present', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-rest');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/settings');

      await expect(page.getByTestId('defaults-card')).toBeVisible({ timeout: 15000 });

      const restInput = page.getByTestId('default-rest-input');
      await expect(restInput).toBeVisible();

      // The input should have a numeric value — check the native input within
      const nativeInput = restInput.locator('input');
      const value = await nativeInput.inputValue();
      expect(Number(value)).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  test('plate calculator shows available plates', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-plates');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/settings');

      await expect(page.getByTestId('plate-calc-card')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('bar-weight-input')).toBeVisible();

      // At least some standard plate weights should be visible
      const plateWeights = ['45', '25', '10', '5', '2.5'];
      let visibleCount = 0;
      for (const weight of plateWeights) {
        const plate = page.getByTestId(`plate-${weight}`);
        if ((await plate.count()) > 0) {
          visibleCount++;
        }
      }
      expect(visibleCount).toBeGreaterThanOrEqual(3);
    } finally {
      await cleanup();
    }
  });

  test('exercise library shows seeded exercises', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-exercises');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/settings');

      const exerciseList = page.getByTestId('exercise-list');
      await expect(exerciseList).toBeVisible({ timeout: 15000 });

      // Should contain seeded exercises from CoachByte activation
      await expect(exerciseList).toContainText('Squat');
      await expect(exerciseList).toContainText('Bench Press');
    } finally {
      await cleanup();
    }
  });

  test('exercise search filters the list', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-filter');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/settings');

      const exerciseList = page.getByTestId('exercise-list');
      await expect(exerciseList).toBeVisible({ timeout: 15000 });

      // Count exercise items before filtering (IonItem elements inside the list)
      const items = exerciseList.locator('ion-item');
      const countBefore = await items.count();
      expect(countBefore).toBeGreaterThan(1);

      // Type in the search input (IonInput wraps a native input)
      const searchInput = page.getByTestId('exercise-search').locator('input');
      await searchInput.fill('Squat');

      // Wait for filtering to take effect
      await page.waitForTimeout(500);

      // After filtering, list should contain fewer items
      const countAfter = await items.count();
      expect(countAfter).toBeLessThan(countBefore);

      // List should still contain Squat
      await expect(exerciseList).toContainText('Squat');
    } finally {
      await cleanup();
    }
  });
});
