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

  test('can edit template set target_reps via inline input', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'split-edit-reps');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/split');
      await expect(page.getByTestId('split-loading')).toBeHidden({ timeout: 15000 });

      const weekday = new Date().getDay();
      // Verify seeded set exists
      const repsInput = page.getByTestId(`day-${weekday}-set-0-reps`).locator('input');
      await expect(repsInput).toBeVisible({ timeout: 10000 });

      // Change reps from 5 to 8
      await repsInput.fill('8');

      // Save the day's split
      await page.getByTestId(`day-${weekday}-save`).click();
      await page.waitForTimeout(1000);

      // Reload and verify the change persisted
      await page.goto('/coach/split');
      await expect(page.getByTestId('split-loading')).toBeHidden({ timeout: 15000 });

      const repsAfterReload = page.getByTestId(`day-${weekday}-set-0-reps`).locator('input');
      await expect(repsAfterReload).toHaveValue('8');
    } finally {
      await cleanup();
    }
  });

  test('can edit template set target_load via inline input', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'split-edit-load');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/split');
      await expect(page.getByTestId('split-loading')).toBeHidden({ timeout: 15000 });

      const weekday = new Date().getDay();
      // Verify seeded set exists — target_load field
      const loadInput = page.getByTestId(`day-${weekday}-set-0-load`).locator('input');
      await expect(loadInput).toBeVisible({ timeout: 10000 });

      // Change load from 225 to 275
      await loadInput.fill('275');

      // Save the day's split
      await page.getByTestId(`day-${weekday}-save`).click();
      await page.waitForTimeout(1000);

      // Reload and verify the change persisted
      await page.goto('/coach/split');
      await expect(page.getByTestId('split-loading')).toBeHidden({ timeout: 15000 });

      const loadAfterReload = page.getByTestId(`day-${weekday}-set-0-load`).locator('input');
      await expect(loadAfterReload).toHaveValue('275');
    } finally {
      await cleanup();
    }
  });

  test('can delete a template set from a day', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'split-del-set');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/split');
      await expect(page.getByTestId('split-loading')).toBeHidden({ timeout: 15000 });

      const weekday = new Date().getDay();

      // Seeded split has 3 sets (order 1,2,3). Verify all 3 exist.
      await expect(page.getByTestId(`day-${weekday}-set-0`)).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId(`day-${weekday}-set-1`)).toBeVisible();
      await expect(page.getByTestId(`day-${weekday}-set-2`)).toBeVisible();

      // Delete the last set (index 2)
      await page.getByTestId(`day-${weekday}-set-2-delete`).click();

      // After deletion, set-2 should no longer exist
      await expect(page.getByTestId(`day-${weekday}-set-2`)).toBeHidden();

      // Save and verify
      await page.getByTestId(`day-${weekday}-save`).click();
      await page.waitForTimeout(1000);

      // Reload to confirm persistence
      await page.goto('/coach/split');
      await expect(page.getByTestId('split-loading')).toBeHidden({ timeout: 15000 });

      await expect(page.getByTestId(`day-${weekday}-set-0`)).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId(`day-${weekday}-set-1`)).toBeVisible();
      await expect(page.getByTestId(`day-${weekday}-set-2`)).toBeHidden();
    } finally {
      await cleanup();
    }
  });

  test('notes textarea saves and persists per day', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'split-notes-persist');
    try {
      await seedCoachByteData(client, userId);
      await page.goto('/coach/split');
      await expect(page.getByTestId('split-loading')).toBeHidden({ timeout: 15000 });

      const weekday = new Date().getDay();
      const notesArea = page.getByTestId(`day-${weekday}-notes`).locator('textarea');
      await expect(notesArea).toBeVisible();

      // Type custom notes
      const testNotes = 'Felt strong today, increase weight next week';
      await notesArea.fill(testNotes);

      // Save the split
      await page.getByTestId(`day-${weekday}-save`).click();
      await page.waitForTimeout(1000);

      // Reload and verify the notes persisted
      await page.goto('/coach/split');
      await expect(page.getByTestId('split-loading')).toBeHidden({ timeout: 15000 });

      const notesAfterReload = page.getByTestId(`day-${weekday}-notes`).locator('textarea');
      await expect(notesAfterReload).toHaveValue(testNotes);
    } finally {
      await cleanup();
    }
  });
});
