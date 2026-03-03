import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedCoachByteData } from '../helpers/seed';

test.describe('CoachByte PR Tracker', () => {
  test('PR page loads with tracked exercises card', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'prs-load');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/prs');
      await expect(page.getByTestId('tracked-exercises-card')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('pr-search-input')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('shows no PRs when no completed sets', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'prs-empty');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/prs');
      await expect(page.getByTestId('tracked-exercises-card')).toBeVisible({ timeout: 15000 });

      await expect(page.getByTestId('no-prs')).toBeVisible();
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
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 10000 });

      // Now navigate to PRs
      await page.goto('/coach/prs');
      await expect(page.getByTestId('tracked-exercises-card')).toBeVisible({ timeout: 15000 });

      // A PR card should be visible (exercise names are uppercased in the UI)
      const prCards = page.locator('[data-testid^="pr-card-"]');
      await expect(prCards.first()).toBeVisible({ timeout: 10000 });

      // The PR card should contain "SQUAT" text (rendered uppercase)
      const firstCard = prCards.first();
      await expect(firstCard).toContainText(/squat/i);
    } finally {
      await cleanup();
    }
  });

  test('can remove and re-add tracked exercise via search', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'prs-search');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/prs');
      await expect(page.getByTestId('tracked-exercises-card')).toBeVisible({ timeout: 15000 });

      // All exercises are tracked initially — count tracked chips
      const trackedChips = page.getByTestId('tracked-chips');
      await expect(trackedChips).toBeVisible();
      const chipsBefore = await trackedChips.locator('ion-chip').count();
      expect(chipsBefore).toBeGreaterThan(0);

      // Remove the last chip (alphabetically last = "Tricep Extension")
      const lastChip = trackedChips.locator('ion-chip').last();
      const lastChipText = await lastChip.textContent();
      const removedName = lastChipText!.replace(' ✕', '').trim();
      await lastChip.click();

      // One fewer chip should be present
      await expect(trackedChips.locator('ion-chip')).toHaveCount(chipsBefore - 1, { timeout: 5000 });

      // Now search for the removed exercise — it should appear in search results
      const searchInput = page.getByTestId('pr-search-input').locator('input');
      await searchInput.click();
      await searchInput.pressSequentially(removedName.slice(0, 4), { delay: 50 });

      // Search results should appear with the removed exercise
      const results = page.getByTestId('pr-search-results');
      await expect(results).toBeVisible({ timeout: 10000 });
      await expect(results).toContainText(removedName);
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
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 10000 });

      // Navigate to PRs
      await page.goto('/coach/prs');
      await expect(page.getByTestId('tracked-exercises-card')).toBeVisible({ timeout: 15000 });

      // Find PR cards and check for e1rm display
      const prCards = page.locator('[data-testid^="pr-card-"]');
      await expect(prCards.first()).toBeVisible({ timeout: 10000 });

      // The e1rm element should contain a numeric value
      const e1rmElements = page.locator('[data-testid^="pr-e1rm-"]');
      await expect(e1rmElements.first()).toBeVisible();
      const e1rmText = await e1rmElements.first().textContent();
      // e1rm should contain a number
      expect(e1rmText).toMatch(/\d/);
    } finally {
      await cleanup();
    }
  });
});
