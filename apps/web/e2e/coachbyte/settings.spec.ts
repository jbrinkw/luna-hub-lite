import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedCoachByteData } from '../helpers/seed';

test.describe('CoachByte Settings', () => {
  test('settings page loads with all cards', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-cards');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/settings');

      await expect(page.getByTestId('defaults-card')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('plate-calc-card')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('exercise-library-card')).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('default rest input is present', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-rest');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/settings');

      await expect(page.getByTestId('defaults-card')).toBeVisible({ timeout: 30000 });

      const restInput = page.getByTestId('default-rest-input');
      await expect(restInput).toBeVisible({ timeout: 30000 });

      // The input should have a numeric value
      const value = await restInput.inputValue();
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

      await expect(page.getByTestId('plate-calc-card')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('bar-weight-input')).toBeVisible({ timeout: 30000 });

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
      await expect(exerciseList).toBeVisible({ timeout: 30000 });

      // Should contain seeded exercises from CoachByte activation
      await expect(exerciseList).toContainText('Squat', { timeout: 30000 });
      await expect(exerciseList).toContainText('Bench Press', { timeout: 30000 });
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
      await expect(exerciseList).toBeVisible({ timeout: 30000 });

      // Count exercise items before filtering (IonItem elements inside the list)
      const items = exerciseList.locator('.exercise-list-item');
      const countBefore = await items.count();
      expect(countBefore).toBeGreaterThan(1);

      // Type in the search input
      const searchInput = page.getByTestId('exercise-search');
      await searchInput.fill('Squat');

      // Wait for filtering to take effect
      await page.waitForTimeout(2000);

      // After filtering, list should contain fewer items
      const countAfter = await items.count();
      expect(countAfter).toBeLessThan(countBefore);

      // List should still contain Squat
      await expect(exerciseList).toContainText('Squat', { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('edit default rest duration and verify save persists', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-rest-persist');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/settings');

      await expect(page.getByTestId('defaults-card')).toBeVisible({ timeout: 30000 });

      const restInput = page.getByTestId('default-rest-input');
      await expect(restInput).toBeVisible({ timeout: 30000 });

      // Clear and set a new rest duration (120 seconds)
      await restInput.fill('120');

      // Trigger blur to save (the component saves onIonBlur)
      await restInput.blur();
      await page.waitForTimeout(3000);

      // Reload the page to verify persistence
      await page.goto('/coach/settings');
      await expect(page.getByTestId('defaults-card')).toBeVisible({ timeout: 30000 });

      const restInputAfter = page.getByTestId('default-rest-input');
      await expect(restInputAfter).toHaveValue('120', { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('add custom exercise appears in library', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-add-ex');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/settings');

      const exerciseList = page.getByTestId('exercise-list');
      await expect(exerciseList).toBeVisible({ timeout: 30000 });

      // Count exercises before adding
      const itemsBefore = await exerciseList.locator('.exercise-list-item').count();

      // Type a new custom exercise name
      const newExInput = page.getByTestId('new-exercise-input');
      await newExInput.fill('Zercher Squat');

      // Click the add button
      await page.getByTestId('add-exercise-btn').click();

      // Wait for the exercise to appear in the list
      await page.waitForTimeout(3000);

      // The list should now contain the new exercise
      await expect(exerciseList).toContainText('Zercher Squat', { timeout: 30000 });

      // The list should have one more item
      const itemsAfter = await exerciseList.locator('.exercise-list-item').count();
      expect(itemsAfter).toBe(itemsBefore + 1);

      // The new exercise should be marked as "custom"
      await expect(exerciseList).toContainText('custom', { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('plate calculator bar weight config changes', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-barwt');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/settings');

      await expect(page.getByTestId('plate-calc-card')).toBeVisible({ timeout: 30000 });

      const barWeightInput = page.getByTestId('bar-weight-input');
      await expect(barWeightInput).toBeVisible({ timeout: 30000 });

      // Verify default bar weight is 45
      await expect(barWeightInput).toHaveValue('45', { timeout: 30000 });

      // Change bar weight to 35
      await barWeightInput.fill('35');

      // Trigger blur to save
      await barWeightInput.blur();
      await page.waitForTimeout(3000);

      // Reload to verify persistence
      await page.goto('/coach/settings');
      await expect(page.getByTestId('plate-calc-card')).toBeVisible({ timeout: 30000 });

      const barWeightAfter = page.getByTestId('bar-weight-input');
      await expect(barWeightAfter).toHaveValue('35', { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });
});
