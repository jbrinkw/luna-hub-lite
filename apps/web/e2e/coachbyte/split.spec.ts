import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedCoachByteData } from '../helpers/seed';

test.describe('CoachByte Split Planner', () => {
  test('split page loads with 7 day cards', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'split-7days');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/split');
      await expect(page.getByTestId('split-loading')).toBeHidden({ timeout: 15000 });

      for (let d = 0; d <= 6; d++) {
        await expect(page.getByTestId(`day-${d}`)).toBeVisible();
      }
    } finally {
      await cleanup();
    }
  });

  test("today's day shows seeded template sets", async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'split-seeded');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/split');
      await expect(page.getByTestId('split-loading')).toBeHidden({ timeout: 15000 });

      const weekday = new Date().getDay();
      const dayTable = page.getByTestId(`day-${weekday}-table`);
      await expect(dayTable).toBeVisible({ timeout: 10000 });

      const dayCard = page.getByTestId(`day-${weekday}`);
      await expect(dayCard).toContainText('Squat');
      await expect(dayCard).toContainText('Bench Press');
    } finally {
      await cleanup();
    }
  });

  test('empty days show rest day message', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'split-empty');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/split');
      await expect(page.getByTestId('split-loading')).toBeHidden({ timeout: 15000 });

      const weekday = new Date().getDay();
      // Pick a day that is NOT today's weekday
      const emptyDay = weekday === 0 ? 1 : 0;

      const emptyIndicator = page.getByTestId(`day-${emptyDay}-empty`);
      await expect(emptyIndicator).toBeVisible();
      await expect(emptyIndicator).toContainText(/rest/i);
    } finally {
      await cleanup();
    }
  });

  test('can add exercise to empty day', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'split-add');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/split');
      await expect(page.getByTestId('split-loading')).toBeHidden({ timeout: 15000 });

      const weekday = new Date().getDay();
      // Pick an empty day (not today)
      const emptyDay = weekday === 0 ? 1 : 0;

      // Verify it starts empty
      await expect(page.getByTestId(`day-${emptyDay}-empty`)).toBeVisible();

      // Click the add button
      await page.getByTestId(`day-${emptyDay}-add`).click();

      // A new set row should appear — look for the first set's exercise element
      await expect(page.getByTestId(`day-${emptyDay}-set-0-exercise`)).toBeVisible({ timeout: 10000 });
    } finally {
      await cleanup();
    }
  });

  test('notes textarea is present for each day', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'split-notes');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/split');
      await expect(page.getByTestId('split-loading')).toBeHidden({ timeout: 15000 });

      const weekday = new Date().getDay();
      const notesArea = page.getByTestId(`day-${weekday}-notes`);
      await expect(notesArea).toBeVisible();
    } finally {
      await cleanup();
    }
  });
});
