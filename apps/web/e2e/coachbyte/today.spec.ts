import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedCoachByteData } from '../helpers/seed';

test.describe('CoachByte Today Page', () => {
  test('today page loads and bootstraps daily plan', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-today-load');
    try {
      await seedCoachByteData(client, userId);

      await page.goto('/coach');

      // Wait for plan to bootstrap — the next-in-queue card appears after ensure_daily_plan RPC
      const nextCard = page.getByTestId('next-in-queue');
      await expect(nextCard).toBeVisible({ timeout: 15000 });

      // First planned set is Squat (order 1)
      await expect(page.getByTestId('next-exercise')).toContainText('Squat');

      // The queue table shows pending sets (excluding the next set which is displayed in the card).
      // With 3 template sets: order 1 = next card, orders 2 and 3 = queue rows.
      await expect(page.getByTestId('queue-row-2')).toBeVisible();
      await expect(page.getByTestId('queue-row-3')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('completing a set adds it to completed table', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-today-complete');
    try {
      await seedCoachByteData(client, userId);

      await page.goto('/coach');

      // Wait for the plan to bootstrap and the next-in-queue card to appear
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // Complete the first set (Squat) by clicking the Complete Set button
      await page.getByTestId('complete-set-btn').click();

      // Verify a completed row appears with Squat text
      const completedRow = page.getByTestId('completed-row-1');
      await expect(completedRow).toBeVisible({ timeout: 10000 });
      await expect(completedRow).toContainText('Squat');
    } finally {
      await cleanup();
    }
  });

  test('rest timer starts after completing a set', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-today-timer');
    try {
      await seedCoachByteData(client, userId);

      await page.goto('/coach');

      // Wait for the plan to bootstrap
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // The rest-timer card is always visible, but before completing a set
      // the timer display shows 0:00 (idle state)
      await expect(page.getByTestId('rest-timer')).toBeVisible();

      // Complete the first set — this triggers complete_next_set RPC which
      // returns rest_seconds, and the page auto-starts the timer
      await page.getByTestId('complete-set-btn').click();

      // After set completion, the timer should be running — the pause button
      // only appears when timer state is 'running'
      await expect(page.getByTestId('pause-btn')).toBeVisible({ timeout: 10000 });

      // The timer display should be visible and showing a non-zero countdown
      const timerDisplay = page.getByTestId('timer-display');
      await expect(timerDisplay).toBeVisible();
      // Timer should not show 0:00 anymore since it is actively counting down
      await expect(timerDisplay).not.toHaveText('0:00');
    } finally {
      await cleanup();
    }
  });

  test('summary textarea is present and accepts input', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-today-summary');
    try {
      await seedCoachByteData(client, userId);

      await page.goto('/coach');

      // Wait for the plan to bootstrap
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // The summary textarea should be present on the page
      const summaryTextarea = page.getByTestId('summary-textarea');
      await expect(summaryTextarea).toBeVisible();

      // Type into the textarea — IonTextarea renders a native textarea inside
      const innerTextarea = summaryTextarea.locator('textarea');
      await innerTextarea.fill('Good session');

      // Wait briefly for the debounced/immediate save to persist to DB
      await page.waitForTimeout(1000);

      // Reload the page and verify the summary persisted
      await page.reload();

      // Wait for the plan to reload after navigation
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // Verify the textarea still contains the saved text
      const reloadedTextarea = page.getByTestId('summary-textarea').locator('textarea');
      await expect(reloadedTextarea).toHaveValue('Good session', { timeout: 10000 });
    } finally {
      await cleanup();
    }
  });
});
