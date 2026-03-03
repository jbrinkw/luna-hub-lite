import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedCoachByteData } from '../helpers/seed';

test.describe('CoachByte History', () => {
  test('history page shows workout history', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-hist-show');
    try {
      await seedCoachByteData(client, userId);

      // Navigate to /coach to bootstrap daily plan via ensure_daily_plan
      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // Complete one set via the UI
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 10000 });

      // Navigate to history page
      await page.goto('/coach/history');

      // Verify history table is visible
      await expect(page.getByTestId('history-table')).toBeVisible({ timeout: 15000 });

      // Verify a history row exists for today's date
      const today = new Date().toISOString().split('T')[0];
      await expect(page.getByTestId(`history-row-${today}`)).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('expanding a history row shows set details', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-hist-expand');
    try {
      await seedCoachByteData(client, userId);

      // Bootstrap plan and complete one set
      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 10000 });

      // Navigate to history
      await page.goto('/coach/history');
      await expect(page.getByTestId('history-table')).toBeVisible({ timeout: 15000 });

      // Click expand button for today's date
      const today = new Date().toISOString().split('T')[0];
      await page.getByTestId(`expand-${today}`).click();

      // Verify detail card is visible
      await expect(page.getByTestId('detail-card')).toBeVisible({ timeout: 10000 });

      // Verify first detail row exists and contains "Squat"
      const detailRow = page.getByTestId('detail-row-1');
      await expect(detailRow).toBeVisible();
      await expect(detailRow).toContainText('Squat');
    } finally {
      await cleanup();
    }
  });

  test('exercise filter is present', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-hist-filter');
    try {
      await seedCoachByteData(client, userId);

      // Bootstrap plan and complete one set so history is non-empty
      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 10000 });

      // Navigate to history
      await page.goto('/coach/history');
      await expect(page.getByTestId('history-table')).toBeVisible({ timeout: 15000 });

      // Verify exercise filter IonSelect is visible
      await expect(page.getByTestId('exercise-filter')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('empty history shows no-history message', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-hist-empty');
    try {
      await seedCoachByteData(client, userId);

      // Navigate directly to history WITHOUT completing any sets.
      // We still need to bootstrap the plan so there is a daily_plans row,
      // but since no sets are completed, the history page will show
      // the plan with 0 completed sets. However, if no plan exists at all
      // (i.e. we skip /coach), there will be no daily_plans rows and
      // history should show the empty state.
      await page.goto('/coach/history');

      // Verify no-history empty state is shown
      const noHistory = page.getByTestId('no-history');
      await expect(noHistory).toBeVisible({ timeout: 15000 });
      await expect(noHistory).toHaveText('No workout history yet.');
    } finally {
      await cleanup();
    }
  });
});
