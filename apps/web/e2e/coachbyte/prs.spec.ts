import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedCoachByteData } from '../helpers/seed';

test.describe('CoachByte PR Tracker', () => {
  test('PR page loads with tracked exercises card', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'prs-load');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/prs');
      await expect(page.getByTestId('tracked-exercises-card')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('pr-search-input')).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('shows no PRs when no completed sets', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'prs-empty');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/prs');
      await expect(page.getByTestId('tracked-exercises-card')).toBeVisible({ timeout: 30000 });

      await expect(page.getByTestId('no-prs')).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('shows PR card after completing a set', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'prs-complete');
    try {
      await seedCoachByteData(client, userId);

      // First go to today's page to bootstrap the daily plan and complete a set
      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 30000 });
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 30000 });

      // Now navigate to PRs
      await page.goto('/coach/prs');
      await expect(page.getByTestId('tracked-exercises-card')).toBeVisible({ timeout: 30000 });

      // A PR card should be visible (exercise names are uppercased in the UI)
      const prCards = page.locator('[data-testid^="pr-card-"]');
      await expect(prCards.first()).toBeVisible({ timeout: 30000 });

      // The PR card should contain "SQUAT" text (rendered uppercase)
      const firstCard = prCards.first();
      await expect(firstCard).toContainText(/squat/i, { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('can remove and re-add tracked exercise via search', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'prs-search');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/prs');
      await expect(page.getByTestId('tracked-exercises-card')).toBeVisible({ timeout: 30000 });

      // All exercises are tracked initially — count tracked chips
      const trackedChips = page.getByTestId('tracked-chips');
      await expect(trackedChips).toBeVisible({ timeout: 30000 });
      const chipsBefore = await trackedChips.locator('.tracked-chip').count();
      expect(chipsBefore).toBeGreaterThan(0);

      // Remove the last chip (alphabetically last = "Tricep Extension")
      const lastChip = trackedChips.locator('.tracked-chip').last();
      const lastChipText = await lastChip.locator('span').first().textContent();
      const removedName = lastChipText!.trim();
      await lastChip.click();

      // One fewer chip should be present
      await expect(trackedChips.locator('.tracked-chip')).toHaveCount(chipsBefore - 1, { timeout: 30000 });

      // Now search for the removed exercise — it should appear in search results
      const searchInput = page.getByTestId('pr-search-input');
      await searchInput.click();
      await searchInput.pressSequentially(removedName.slice(0, 4), { delay: 50 });

      // Search results should appear with the removed exercise
      const results = page.getByTestId('pr-search-results');
      await expect(results).toBeVisible({ timeout: 30000 });
      await expect(results).toContainText(removedName, { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('e1rm calculation is displayed after completing a set', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'prs-e1rm');
    try {
      await seedCoachByteData(client, userId);

      // Complete a set first
      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 30000 });
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 30000 });

      // Navigate to PRs
      await page.goto('/coach/prs');
      await expect(page.getByTestId('tracked-exercises-card')).toBeVisible({ timeout: 30000 });

      // Find PR cards and check for e1rm display
      const prCards = page.locator('[data-testid^="pr-card-"]');
      await expect(prCards.first()).toBeVisible({ timeout: 30000 });

      // The e1rm element should contain a numeric value
      const e1rmElements = page.locator('[data-testid^="pr-e1rm-"]');
      await expect(e1rmElements.first()).toBeVisible({ timeout: 30000 });
      const e1rmText = await e1rmElements.first().textContent();
      // e1rm should contain a number
      expect(e1rmText).toMatch(/\d/);
    } finally {
      await cleanup();
    }
  });

  test('PR date range filter works', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'prs-daterange');
    try {
      await seedCoachByteData(client, userId);

      // Complete a set first so there are PRs to display
      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 30000 });
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 30000 });

      // Navigate to PRs
      await page.goto('/coach/prs');
      await expect(page.getByTestId('tracked-exercises-card')).toBeVisible({ timeout: 30000 });

      // PR cards should be visible (default date range is 90 days)
      const prCards = page.locator('[data-testid^="pr-card-"]');
      await expect(prCards.first()).toBeVisible({ timeout: 30000 });

      // Verify the date range info text is displayed
      const dateRangeInfo = page.getByTestId('date-range-info');
      await expect(dateRangeInfo).toBeVisible({ timeout: 30000 });
      await expect(dateRangeInfo).toContainText('90 days', { timeout: 30000 });

      // Click "Load All History" button to change the date range
      const loadAllBtn = page.getByTestId('load-all-history-btn');
      await expect(loadAllBtn).toBeVisible({ timeout: 30000 });
      await loadAllBtn.click();

      // Wait for data to reload
      await expect(page.getByTestId('tracked-exercises-card')).toBeVisible({ timeout: 30000 });

      // After loading all history, the info text should reflect "all history"
      await expect(dateRangeInfo).toContainText('all history', { timeout: 30000 });

      // The "Load All History" button should now be hidden
      await expect(loadAllBtn).toBeHidden();

      // PR cards should still be visible
      await expect(prCards.first()).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('rep records section displays for tracked exercise', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'prs-reprec');
    try {
      await seedCoachByteData(client, userId);

      // Complete multiple sets to generate rep records at different rep counts
      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 30000 });

      // Complete set 1 (Squat, 5 reps @ 225)
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 30000 });

      // Navigate to PRs
      await page.goto('/coach/prs');
      await expect(page.getByTestId('tracked-exercises-card')).toBeVisible({ timeout: 30000 });

      // Find the PR card for the exercise
      const prCards = page.locator('[data-testid^="pr-card-"]');
      await expect(prCards.first()).toBeVisible({ timeout: 30000 });

      // Inside the PR card, there should be rep record chips (e.g. "5 rep: 225 lb")
      // The data-testid format is pr-{exercise_id}-{reps}rep
      const repChips = page.locator('[data-testid^="pr-"][data-testid$="rep"]');
      await expect(repChips.first()).toBeVisible({ timeout: 30000 });

      // Verify the chip contains rep and load information
      const chipText = await repChips.first().textContent();
      expect(chipText).toMatch(/\d+\s*rep.*\d+/);
    } finally {
      await cleanup();
    }
  });
});
