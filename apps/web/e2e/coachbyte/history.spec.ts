import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedCoachByteData, todayStr } from '../helpers/seed';

test.describe('CoachByte History', () => {
  test('history page shows workout history', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-hist-show');
    try {
      await seedCoachByteData(client, userId);

      // Navigate to /coach to bootstrap daily plan via ensure_daily_plan
      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 30000 });

      // Complete one set via the UI
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 30000 });

      // Navigate to history page
      await page.goto('/coach/history');

      // Verify history table is visible
      await expect(page.getByTestId('history-table')).toBeVisible({ timeout: 30000 });

      // Verify a history row exists for today's date
      const today = todayStr();
      await expect(page.getByTestId(`history-row-${today}`)).toBeVisible({ timeout: 30000 });
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
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 30000 });
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 30000 });

      // Navigate to history
      await page.goto('/coach/history');
      await expect(page.getByTestId('history-table')).toBeVisible({ timeout: 30000 });

      // Click expand button for today's date
      const today = todayStr();
      await page.getByTestId(`expand-${today}`).click();

      // Verify detail card is visible
      await expect(page.getByTestId('detail-card')).toBeVisible({ timeout: 30000 });

      // Verify first detail row exists and contains "Squat"
      const detailRow = page.getByTestId('detail-row-1');
      await expect(detailRow).toBeVisible({ timeout: 30000 });
      await expect(detailRow).toContainText('Squat', { timeout: 30000 });
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
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 30000 });
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 30000 });

      // Navigate to history
      await page.goto('/coach/history');
      await expect(page.getByTestId('history-table')).toBeVisible({ timeout: 30000 });

      // Verify exercise filter IonSelect is visible
      await expect(page.getByTestId('exercise-filter')).toBeVisible({ timeout: 30000 });
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
      await expect(noHistory).toBeVisible({ timeout: 30000 });
      await expect(noHistory).toContainText('No workout history yet', { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('exercise filter hides days without matching exercise', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-hist-filt-narrow');
    try {
      const coach = (client as any).schema('coachbyte');

      // Fetch global exercises
      const { data: exercises } = await coach.from('exercises').select('exercise_id, name').is('user_id', null);
      const squat = exercises.find((e: any) => e.name === 'Squat');
      const bench = exercises.find((e: any) => e.name === 'Bench Press');
      const deadlift = exercises.find((e: any) => e.name === 'Deadlift');
      if (!squat || !bench || !deadlift) throw new Error('Global exercises not found');

      const today = new Date();
      const todayDate = todayStr();

      // Create yesterday's date
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayDate = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

      // Seed a split for today so ensure_daily_plan works
      const weekday = today.getDay();
      await coach.from('splits').insert({
        user_id: userId,
        weekday,
        template_sets: [
          { exercise_id: squat.exercise_id, target_reps: 5, target_load: 225, order: 1 },
          { exercise_id: bench.exercise_id, target_reps: 5, target_load: 185, order: 2 },
        ],
        split_notes: '',
      });

      // Day 1 (yesterday): only Deadlift completed
      const { data: plan1 } = await coach.rpc('ensure_daily_plan', { p_day: yesterdayDate });
      await coach.from('completed_sets').insert({
        plan_id: plan1.plan_id,
        user_id: userId,
        exercise_id: deadlift.exercise_id,
        actual_reps: 5,
        actual_load: 315,
        logical_date: yesterdayDate,
      });

      // Day 2 (today): only Bench Press completed
      const { data: plan2 } = await coach.rpc('ensure_daily_plan', { p_day: todayDate });
      await coach.from('completed_sets').insert({
        plan_id: plan2.plan_id,
        user_id: userId,
        exercise_id: bench.exercise_id,
        actual_reps: 5,
        actual_load: 185,
        logical_date: todayDate,
      });

      // Navigate to history
      await page.goto('/coach/history');
      await expect(page.getByTestId('history-table')).toBeVisible({ timeout: 30000 });

      // Without filter, both days should be visible
      await expect(page.getByTestId(`history-row-${todayDate}`)).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId(`history-row-${yesterdayDate}`)).toBeVisible({ timeout: 30000 });

      // Apply the exercise filter: select "Bench Press" from the native <select>
      await page.getByTestId('exercise-filter').selectOption({ label: 'Bench Press' });

      // Wait for filtering to take effect
      await page.waitForTimeout(3000);

      // Today's row should still be visible (has Bench Press)
      await expect(page.getByTestId(`history-row-${todayDate}`)).toBeVisible({ timeout: 30000 });

      // Yesterday's row should be HIDDEN (only had Deadlift, no Bench Press)
      await expect(page.getByTestId(`history-row-${yesterdayDate}`)).toBeHidden();
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
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 30000 });
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 30000 });

      // Navigate to history
      await page.goto('/coach/history');
      await expect(page.getByTestId('history-table')).toBeVisible({ timeout: 30000 });

      const today = todayStr();
      const historyRow = page.getByTestId(`history-row-${today}`);
      await expect(historyRow).toBeVisible({ timeout: 30000 });

      // The row should contain a summary cell (shows "No summary" if null, or actual summary text)
      // The seeded split_notes don't auto-populate summary, so it should show "No summary"
      await expect(historyRow).toContainText('No summary', { timeout: 30000 });

      // The row should also show completed/planned count (e.g. "1/3")
      await expect(historyRow).toContainText('1/3', { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('pagination Load More button works with 25+ days of history', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-hist-paging');
    try {
      const coach = (client as any).schema('coachbyte');

      // Fetch a global exercise for seeding completed sets
      const { data: exercises } = await coach.from('exercises').select('exercise_id, name').is('user_id', null);
      const squat = exercises.find((e: any) => e.name === 'Squat');
      if (!squat) throw new Error('Squat exercise not found');

      // Seed 25 days of history (PAGE_SIZE=20, so we need >20 to trigger Load More)
      const today = new Date();
      for (let i = 0; i < 25; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

        // Ensure daily plan for this date
        const { data: plan, error: planErr } = await coach.rpc('ensure_daily_plan', { p_day: dateStr });
        if (planErr) throw new Error(`ensure_daily_plan failed for ${dateStr}: ${planErr.message}`);

        // Insert a completed set for this day
        await coach.from('completed_sets').insert({
          plan_id: plan.plan_id,
          user_id: userId,
          exercise_id: squat.exercise_id,
          actual_reps: 5,
          actual_load: 225,
          logical_date: dateStr,
        });
      }

      // Navigate to history
      await page.goto('/coach/history');
      await expect(page.getByTestId('history-table')).toBeVisible({ timeout: 30000 });

      // Count initial rows — should be PAGE_SIZE (20)
      const rowsBefore = await page.locator('[data-testid^="history-row-"]').count();
      expect(rowsBefore).toBe(20);

      // Load More button should be visible since we have 25 > 20 days
      const loadMoreBtn = page.getByTestId('load-more-btn');
      await expect(loadMoreBtn).toBeVisible({ timeout: 30000 });

      // Click Load More
      await loadMoreBtn.click();

      // Wait for additional rows to load
      await page.waitForTimeout(3000);

      // After loading more, we should have all 25 rows
      const rowsAfter = await page.locator('[data-testid^="history-row-"]').count();
      expect(rowsAfter).toBe(25);

      // Load More button should now be hidden (no more pages)
      await expect(loadMoreBtn).toBeHidden();
    } finally {
      await cleanup();
    }
  });
});
