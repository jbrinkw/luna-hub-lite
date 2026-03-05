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

  test('rest timer card is visible and updates after set completion', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-today-timer');
    try {
      await seedCoachByteData(client, userId);

      await page.goto('/coach');

      // Wait for the plan to bootstrap
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // The rest-timer card should be visible
      await expect(page.getByTestId('rest-timer')).toBeVisible();

      // Complete the first set
      await page.getByTestId('complete-set-btn').click();

      // After completing a set, the completed row should appear
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 10000 });

      // The rest timer card should still be visible — it may auto-start
      // via Realtime, or remain in idle state depending on timing
      await expect(page.getByTestId('rest-timer')).toBeVisible();
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

      // Type into the textarea — IonTextarea renders a native textarea inside.
      // Use click + pressSequentially so Ionic's ionInput event fires properly.
      const innerTextarea = summaryTextarea.locator('textarea');
      await innerTextarea.click();
      await innerTextarea.pressSequentially('Good session');

      // Blur the textarea to trigger the immediate save
      await page.getByTestId('next-in-queue').click();

      // Wait for the save to persist to DB
      await page.waitForTimeout(1500);

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

  test('ad-hoc set form is visible and has exercise dropdown', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-today-adhoc-vis');
    try {
      await seedCoachByteData(client, userId);

      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // Click the ad-hoc button to show the form
      await page.getByTestId('adhoc-btn').click();

      // The ad-hoc form card should appear
      const form = page.getByTestId('adhoc-form');
      await expect(form).toBeVisible({ timeout: 5000 });

      // Verify the exercise selector is present
      await expect(page.getByTestId('exercise-select')).toBeVisible();

      // Verify reps and load inputs are present
      await expect(page.getByTestId('adhoc-reps')).toBeVisible();
      await expect(page.getByTestId('adhoc-load')).toBeVisible();

      // Verify submit and cancel buttons
      await expect(page.getByTestId('adhoc-submit')).toBeVisible();
      await expect(page.getByTestId('adhoc-cancel')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('can submit ad-hoc set with exercise, reps, and load — verified in DB', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-today-adhoc-sub');
    try {
      await seedCoachByteData(client, userId);

      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // Click the ad-hoc button to show the form
      await page.getByTestId('adhoc-btn').click();
      await expect(page.getByTestId('adhoc-form')).toBeVisible({ timeout: 5000 });

      // Open the IonSelect (in md mode it opens an alert dialog)
      await page.getByTestId('exercise-select').click();

      // Wait for the alert overlay with exercise options to appear
      const alertOverlay = page.locator('ion-alert');
      await expect(alertOverlay).toBeVisible({ timeout: 5000 });

      // Select "Squat" from the alert radio options (exact match to avoid "Front Squat")
      await alertOverlay.locator('button', { hasText: /^Squat$/ }).click();

      // Click "OK" to confirm the alert selection
      await alertOverlay.locator('button', { hasText: /ok/i }).click();

      // Fill reps and load — IonInput renders a native input inside
      const repsInput = page.getByTestId('adhoc-reps').locator('input');
      await repsInput.fill('8');

      const loadInput = page.getByTestId('adhoc-load').locator('input');
      await loadInput.fill('135');

      // Submit the ad-hoc set
      await page.getByTestId('adhoc-submit').click();

      // The ad-hoc form should close and a completed row should appear with "Squat"
      await expect(page.getByTestId('adhoc-form')).not.toBeVisible({ timeout: 5000 });

      // The ad-hoc set appears in completed sets (it's inserted directly into completed_sets)
      const completedRow = page.getByTestId('completed-row-1');
      await expect(completedRow).toBeVisible({ timeout: 10000 });
      await expect(completedRow).toContainText('Squat');
      await expect(completedRow).toContainText('8');
      await expect(completedRow).toContainText('135');

      // Verify the ad-hoc set was persisted to the DB with correct values
      const coach = (client as any).schema('coachbyte');
      const { data: dbSets, error: dbErr } = await coach
        .from('completed_sets')
        .select('actual_reps, actual_load, exercise_id, exercises(name)')
        .eq('user_id', userId)
        .is('planned_set_id', null); // ad-hoc sets have no planned_set_id

      expect(dbErr).toBeNull();
      expect(dbSets).toBeTruthy();
      expect(dbSets.length).toBe(1);
      expect(dbSets[0].actual_reps).toBe(8);
      expect(Number(dbSets[0].actual_load)).toBe(135);
      expect(dbSets[0].exercises.name).toBe('Squat');
    } finally {
      await cleanup();
    }
  });

  test('custom weight/reps input before completing set', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-today-custom');
    try {
      await seedCoachByteData(client, userId);

      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // Override the reps and load values in the next-in-queue card
      const repsInput = page.getByTestId('override-reps').locator('input');
      await repsInput.fill('');
      await repsInput.fill('10');

      const loadInput = page.getByTestId('override-load').locator('input');
      await loadInput.fill('');
      await loadInput.fill('200');

      // Complete the set with overridden values
      await page.getByTestId('complete-set-btn').click();

      // Verify the completed row shows the custom values
      const completedRow = page.getByTestId('completed-row-1');
      await expect(completedRow).toBeVisible({ timeout: 10000 });
      await expect(completedRow).toContainText('Squat');
      await expect(completedRow).toContainText('10');
      await expect(completedRow).toContainText('200');
    } finally {
      await cleanup();
    }
  });

  test('delete completed set removes it from table', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-today-delcomp');
    try {
      await seedCoachByteData(client, userId);

      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // Complete a set first
      await page.getByTestId('complete-set-btn').click();
      const completedRow = page.getByTestId('completed-row-1');
      await expect(completedRow).toBeVisible({ timeout: 10000 });

      // Click delete — first click shows "Confirm?"
      const deleteBtn = page.getByTestId('delete-completed-1');
      await deleteBtn.click();
      await expect(deleteBtn).toContainText('Confirm?');

      // Second click confirms deletion
      await deleteBtn.click();

      // The completed row should be removed — the "No sets completed yet." text appears
      await expect(page.getByText('No sets completed yet.')).toBeVisible({ timeout: 10000 });
    } finally {
      await cleanup();
    }
  });

  test('reset plan button clears and rebuilds queue', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-today-reset');
    try {
      await seedCoachByteData(client, userId);

      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // Complete a set so we can verify the plan rebuilds after reset
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 10000 });

      // Click reset — first click shows "Confirm Reset?"
      const resetBtn = page.getByTestId('reset-plan-btn');
      await resetBtn.click();
      await expect(resetBtn).toContainText('Confirm Reset?');

      // Second click confirms reset
      await resetBtn.click();

      // After reset, ensure_daily_plan recreates the plan from the split template.
      // The queue should rebuild with all 3 sets again (none completed).
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('next-exercise')).toContainText('Squat');

      // Queue rows 2 and 3 should be back
      await expect(page.getByTestId('queue-row-2')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('queue-row-3')).toBeVisible();

      // Completed sets should be empty again
      await expect(page.getByText('No sets completed yet.')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('workout notes textarea saves on blur and persists reload', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-today-notes');
    try {
      await seedCoachByteData(client, userId);

      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // The notes textarea should be visible
      const notesTextarea = page.getByTestId('notes-textarea');
      await expect(notesTextarea).toBeVisible();

      // Type into the notes textarea — IonTextarea renders a native textarea inside.
      // Use click + pressSequentially so Ionic's ionInput event fires properly.
      const innerTextarea = notesTextarea.locator('textarea');
      await innerTextarea.click();
      await innerTextarea.pressSequentially('Felt strong today, good form on squats');

      // Click away to trigger blur and save
      await page.getByTestId('next-in-queue').click();

      // Wait for the save to persist
      await page.waitForTimeout(1500);

      // Reload the page
      await page.reload();
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // Verify the notes textarea contains the saved text
      const reloadedTextarea = page.getByTestId('notes-textarea').locator('textarea');
      await expect(reloadedTextarea).toHaveValue('Felt strong today, good form on squats', { timeout: 10000 });
    } finally {
      await cleanup();
    }
  });

  test('rest timer auto-starts after completing a set', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-today-autotmr');
    try {
      // Seed a custom split that includes rest_seconds in template_sets
      const coach = (client as any).schema('coachbyte');

      // Fetch global exercises
      const { data: exercises } = await coach.from('exercises').select('exercise_id, name').is('user_id', null);

      const squat = exercises.find((e: any) => e.name === 'Squat');
      const bench = exercises.find((e: any) => e.name === 'Bench Press');
      if (!squat || !bench) throw new Error('Global exercises not found');

      const today = new Date();
      const weekday = today.getDay();

      // Template sets WITH rest_seconds so timer auto-starts
      const templateSets = [
        { exercise_id: squat.exercise_id, target_reps: 5, target_load: 225, rest_seconds: 90, order: 1 },
        { exercise_id: squat.exercise_id, target_reps: 5, target_load: 225, rest_seconds: 90, order: 2 },
        { exercise_id: bench.exercise_id, target_reps: 5, target_load: 185, rest_seconds: 60, order: 3 },
      ];

      await coach.from('splits').insert({
        user_id: userId,
        weekday,
        template_sets: templateSets,
        split_notes: 'E2E timer test split',
      });

      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // The timer display should initially show 0:00 (idle state)
      const timerDisplay = page.getByTestId('timer-display');
      await expect(timerDisplay).toBeVisible();

      // Complete the first set — this triggers auto-start of the rest timer
      // complete_next_set returns rest_seconds of the NEXT planned set (set 2 = 90s)
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 10000 });

      // The timer should now be running — the Pause button appears when state is 'running'
      await expect(page.getByTestId('pause-btn')).toBeVisible({ timeout: 10000 });

      // Timer display should show a non-zero countdown (e.g. 1:29 or 1:30)
      await expect(timerDisplay).not.toHaveText('0:00');
    } finally {
      await cleanup();
    }
  });

  test('completing all sets shows empty queue state', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-today-allcomp');
    try {
      await seedCoachByteData(client, userId);

      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // Complete set 1 (Squat)
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 10000 });

      // Complete set 2 (Squat)
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 10000 });
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-2')).toBeVisible({ timeout: 10000 });

      // Complete set 3 (Bench Press)
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 10000 });
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-3')).toBeVisible({ timeout: 10000 });

      // After all sets are completed, the next-in-queue card should disappear
      await expect(page.getByTestId('next-in-queue')).not.toBeVisible({ timeout: 10000 });

      // The SET QUEUE section should show "All sets completed!" text
      await expect(page.getByText('All sets completed!')).toBeVisible({ timeout: 10000 });
    } finally {
      await cleanup();
    }
  });

  test('PR toast notification appears when new record set', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-today-prtoast');
    try {
      await seedCoachByteData(client, userId);

      // Seed a historical completed set with a lower weight to establish a baseline PR
      const coach = (client as any).schema('coachbyte');

      // Bootstrap the plan first so we have a plan_id
      const d = new Date();
      const todayDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const { data: planResult } = await coach.rpc('ensure_daily_plan', { p_day: todayDate });
      const planId = planResult.plan_id;

      // Fetch the squat exercise_id
      const { data: exercises } = await coach.from('exercises').select('exercise_id, name').is('user_id', null);
      const squat = exercises.find((e: any) => e.name === 'Squat');

      // Insert a previous completed set with lower weight to establish a baseline
      // e1RM(135, 5) = 135 * (1 + 5/30) = 157.5 → rounds to 158
      await coach.from('completed_sets').insert({
        plan_id: planId,
        user_id: userId,
        exercise_id: squat.exercise_id,
        actual_reps: 5,
        actual_load: 135,
        logical_date: todayDate,
      });

      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // The first set in queue should be Squat at 225 lbs (higher than the 135 baseline)
      // e1RM(225, 5) = 225 * (1 + 5/30) = 262.5 → rounds to 263
      // Since 263 > 158, completing this set should trigger a "NEW PR!" toast
      await page.getByTestId('complete-set-btn').click();

      // Wait for the PR toast to appear — IonToast uses is-open attribute
      const toast = page.getByTestId('pr-toast');
      await expect(toast).toHaveAttribute('is-open', 'true', { timeout: 10000 });

      // Verify the toast message contains "NEW PR!" and the exercise name
      const toastMessage = await toast.getAttribute('message');
      expect(toastMessage).toBeTruthy();
      expect(toastMessage).toContain('NEW PR!');
      expect(toastMessage).toContain('Squat');
      // Verify the new e1RM value is displayed (263 for 225 lbs @ 5 reps)
      expect(toastMessage).toContain('263');
    } finally {
      await cleanup();
    }
  });

  test('timer expired state displays message and reset button works', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'coach-today-expired');
    try {
      // Seed a custom split with rest_seconds so timer auto-starts after completing a set
      const coach = (client as any).schema('coachbyte');

      const { data: exercises } = await coach.from('exercises').select('exercise_id, name').is('user_id', null);
      const squat = exercises.find((e: any) => e.name === 'Squat');
      const bench = exercises.find((e: any) => e.name === 'Bench Press');
      if (!squat || !bench) throw new Error('Global exercises not found');

      const today = new Date();
      const weekday = today.getDay();

      const templateSets = [
        { exercise_id: squat.exercise_id, target_reps: 5, target_load: 225, rest_seconds: 90, order: 1 },
        { exercise_id: squat.exercise_id, target_reps: 5, target_load: 225, rest_seconds: 90, order: 2 },
        { exercise_id: bench.exercise_id, target_reps: 5, target_load: 185, rest_seconds: 60, order: 3 },
      ];

      await coach.from('splits').insert({
        user_id: userId,
        weekday,
        template_sets: templateSets,
        split_notes: 'E2E timer expiry test split',
      });

      await page.goto('/coach');
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // Complete the first set — this auto-starts the rest timer
      await page.getByTestId('complete-set-btn').click();
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 10000 });

      // Confirm the timer started running
      await expect(page.getByTestId('pause-btn')).toBeVisible({ timeout: 10000 });

      // Force-expire the timer via DB update, then reload so the page
      // fetches the expired state on mount (avoids Realtime timing issues)
      await coach
        .from('timers')
        .update({
          state: 'expired',
          end_time: new Date(Date.now() - 1000).toISOString(),
        })
        .eq('user_id', userId);

      await page.reload();
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // After reload, loadTimer fetches the expired state
      await expect(page.getByTestId('timer-expired')).toBeVisible({ timeout: 10000 });

      // Verify the expired message text
      await expect(page.getByTestId('timer-expired')).toContainText('Timer expired');

      // Click the reset button to return to idle state
      await page.getByTestId('reset-btn').click();

      // The expired message should disappear after reset
      await expect(page.getByTestId('timer-expired')).not.toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });
});
