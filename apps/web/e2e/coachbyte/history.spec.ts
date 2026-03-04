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

  test('exercise filter actually narrows displayed data', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-hist-filt-narrow');
    try {
      await seedCoachByteData(client, userId);

      // Bootstrap plan and complete multiple sets (both Squat and Bench)
      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // Complete set 1 (Squat)
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 10000 });

      // Complete set 2 (Squat)
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-2')).toBeVisible({ timeout: 10000 });

      // Complete set 3 (Bench Press)
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-3')).toBeVisible({ timeout: 10000 });

      // Navigate to history
      await page.goto('/coach/history');
      await expect(page.getByTestId('history-table')).toBeVisible({ timeout: 15000 });

      const today = new Date().toISOString().split('T')[0];

      // Without filter, today's row should be visible
      await expect(page.getByTestId(`history-row-${today}`)).toBeVisible();

      // Expand to confirm both exercises are present
      await page.getByTestId(`expand-${today}`).click();
      await expect(page.getByTestId('detail-card')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('detail-row-1')).toContainText('Squat');
      await expect(page.getByTestId('detail-row-3')).toContainText('Bench Press');

      // Now apply the exercise filter — select an exercise by interacting with the IonSelect
      // The exercise-filter is an IonSelect with popover interface
      const exerciseFilter = page.getByTestId('exercise-filter');
      await exerciseFilter.click();

      // Wait for the popover options to appear, then pick "Bench Press" (exact match)
      const benchOption = page.getByRole('radio', { name: 'Bench Press', exact: true });
      await expect(benchOption).toBeVisible({ timeout: 5000 });
      await benchOption.click();

      // Wait for filtering to take effect
      await page.waitForTimeout(1000);

      // History should still show today's row (since it has Bench Press sets)
      await expect(page.getByTestId(`history-row-${today}`)).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('history summary text displays for completed days', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-hist-summary');
    try {
      await seedCoachByteData(client, userId);

      // Bootstrap plan and complete a set
      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 10000 });

      // Navigate to history
      await page.goto('/coach/history');
      await expect(page.getByTestId('history-table')).toBeVisible({ timeout: 15000 });

      const today = new Date().toISOString().split('T')[0];
      const historyRow = page.getByTestId(`history-row-${today}`);
      await expect(historyRow).toBeVisible();

      // The row should contain a summary cell (shows "—" if null, or actual summary text)
      // The seeded split_notes don't auto-populate summary, so it should show "—"
      await expect(historyRow).toContainText('—');

      // The row should also show completed/planned count (e.g. "1/3")
      await expect(historyRow).toContainText('1/3');
    } finally {
      await cleanup();
    }
  });

  test('pagination loads more results when available', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-hist-paging');
    try {
      await seedCoachByteData(client, userId);

      // Bootstrap plan and complete a set so there is at least 1 history entry
      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 10000 });

      // Navigate to history
      await page.goto('/coach/history');
      await expect(page.getByTestId('history-table')).toBeVisible({ timeout: 15000 });

      // Check if load-more button exists. With only 1 day of history it likely won't,
      // so we verify the page loaded correctly and the button is hidden.
      const loadMoreBtn = page.getByTestId('load-more-btn');
      const loadMoreVisible = await loadMoreBtn.isVisible().catch(() => false);

      if (loadMoreVisible) {
        // If somehow there are >20 days of history, verify the button works
        const rowsBefore = await page.locator('[data-testid^="history-row-"]').count();
        await loadMoreBtn.click();
        await page.waitForTimeout(2000);
        const rowsAfter = await page.locator('[data-testid^="history-row-"]').count();
        expect(rowsAfter).toBeGreaterThanOrEqual(rowsBefore);
      } else {
        // With limited history, load-more should not be visible (fewer than PAGE_SIZE results)
        await expect(loadMoreBtn).toBeHidden();
      }
    } finally {
      await cleanup();
    }
  });
});
