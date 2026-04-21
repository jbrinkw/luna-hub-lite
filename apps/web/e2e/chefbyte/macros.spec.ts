import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData, todayStr } from '../helpers/seed';

test.describe('ChefByte Macros page', () => {
  test('macros page shows date nav and progress bars', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'macro-nav');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/macros');
      await expect(page.getByTestId('macro-summary')).toBeVisible({ timeout: 30000 });

      // Date navigation is visible
      await expect(page.getByTestId('date-nav')).toBeVisible();
      await expect(page.getByTestId('prev-date-btn')).toBeVisible();
      await expect(page.getByTestId('today-date-btn')).toBeVisible();
      await expect(page.getByTestId('next-date-btn')).toBeVisible();

      // Current date is displayed
      const dateEl = page.getByTestId('current-date');
      await expect(dateEl).toBeVisible();
      // Verify today's date is shown (format: "Mon, Mar 03" etc.)
      const today = new Date();
      const expectedDate = today.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      await expect(dateEl).toHaveText(expectedDate);

      // All 4 progress bars visible
      await expect(page.getByTestId('progress-calories')).toBeVisible();
      await expect(page.getByTestId('progress-protein')).toBeVisible();
      await expect(page.getByTestId('progress-carbs')).toBeVisible();
      await expect(page.getByTestId('progress-fats')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('macro goals display from seeded user_config', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'macro-goals');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/macros');
      await expect(page.getByTestId('macro-summary')).toBeVisible({ timeout: 30000 });

      // Seeded goals: calories=2200, protein=180, carbs=220, fat=73
      await expect(page.getByTestId('progress-calories')).toContainText('2200');
      await expect(page.getByTestId('progress-protein')).toContainText('180');
      await expect(page.getByTestId('progress-carbs')).toContainText('220');
      await expect(page.getByTestId('progress-fats')).toContainText('73');
    } finally {
      await cleanup();
    }
  });

  test('log temp item modal works', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'macro-temp');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/macros');
      await expect(page.getByTestId('macro-summary')).toBeVisible({ timeout: 30000 });

      // Initially no consumed items
      await expect(page.getByTestId('no-consumed')).toBeVisible();

      // Open the temp item modal
      await page.getByTestId('log-temp-btn').click();
      await expect(page.getByTestId('temp-item-modal')).toBeVisible();

      // Fill in the form (plain <input> elements)
      await page.getByTestId('temp-name').fill('Coffee');
      await page.getByTestId('temp-calories').fill('50');
      await page.getByTestId('temp-protein').fill('1');
      await page.getByTestId('temp-carbs').fill('5');
      await page.getByTestId('temp-fat').fill('2');

      // Save the temp item
      await page.getByTestId('temp-save-btn').click();

      // Modal should close
      await expect(page.getByTestId('temp-item-modal')).not.toBeVisible({ timeout: 30000 });

      // Consumed section should now show the item
      await expect(page.getByTestId('no-consumed')).not.toBeVisible();
      await expect(page.getByTestId('consumed-table')).toBeVisible();
      await expect(page.getByTestId('consumed-section')).toContainText('Coffee');
    } finally {
      await cleanup();
    }
  });

  test('date navigation changes displayed date', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'macro-datenav');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/macros');
      await expect(page.getByTestId('macro-summary')).toBeVisible({ timeout: 30000 });

      const dateEl = page.getByTestId('current-date');

      // Capture today's displayed date
      const today = new Date();
      const todayStr = today.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      await expect(dateEl).toHaveText(todayStr);

      // Click prev to go to yesterday
      await page.getByTestId('prev-date-btn').click();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      await expect(dateEl).toHaveText(yesterdayStr);

      // Click next twice to go to tomorrow (yesterday + 1 = today, today + 1 = tomorrow)
      await page.getByTestId('next-date-btn').click();
      await expect(dateEl).toHaveText(todayStr);

      await page.getByTestId('next-date-btn').click();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      await expect(dateEl).toHaveText(tomorrowStr);

      // Click "Today" to return to today
      await page.getByTestId('today-date-btn').click();
      await expect(dateEl).toHaveText(todayStr);
    } finally {
      await cleanup();
    }
  });

  test('consumed items section shows detail after consuming', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'macro-consumed');
    try {
      await seedChefByteData(client, userId);
      const chef = (client as any).schema('chefbyte');

      // Seed a temp item directly in the database for today's date
      const today = todayStr();
      const { data: tempItem, error: tempErr } = await chef
        .from('temp_items')
        .insert({
          user_id: userId,
          name: 'Test Snack Bar',
          calories: 200,
          protein: 10,
          carbs: 25,
          fat: 8,
          logical_date: today,
        })
        .select('temp_id')
        .single();
      if (tempErr) throw new Error(`Failed to seed temp item: ${tempErr.message}`);

      await page.goto('/chef/macros');
      await expect(page.getByTestId('macro-summary')).toBeVisible({ timeout: 30000 });

      // Consumed section should show the table (not the "no consumed" message)
      await expect(page.getByTestId('no-consumed')).not.toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('consumed-table')).toBeVisible();

      // Verify the seeded temp item row is visible
      const consumedRow = page.getByTestId(`consumed-row-${tempItem.temp_id}`);
      await expect(consumedRow).toBeVisible();
      await expect(consumedRow).toContainText('Test Snack Bar');
      await expect(consumedRow).toContainText('200');
      await expect(consumedRow).toContainText('10g');
    } finally {
      await cleanup();
    }
  });

  test('delete consumed/temp item from macros page', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'macro-deltemp');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/macros');
      await expect(page.getByTestId('macro-summary')).toBeVisible({ timeout: 30000 });

      // Initially no consumed items
      await expect(page.getByTestId('no-consumed')).toBeVisible();

      // Log a temp item via the modal
      await page.getByTestId('log-temp-btn').click();
      await expect(page.getByTestId('temp-item-modal')).toBeVisible();

      await page.getByTestId('temp-name').fill('Removable Item');
      await page.getByTestId('temp-calories').fill('100');
      await page.getByTestId('temp-protein').fill('5');
      await page.getByTestId('temp-carbs').fill('10');
      await page.getByTestId('temp-fat').fill('3');
      await page.getByTestId('temp-save-btn').click();

      // Modal should close and item should appear
      await expect(page.getByTestId('temp-item-modal')).not.toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('consumed-table')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('consumed-section')).toContainText('Removable Item');

      // Find the delete button for the temp item row (there should be exactly one consumed row)
      const deleteBtn = page.locator('[data-testid^="delete-consumed-"]').first();
      await expect(deleteBtn).toBeVisible();
      await deleteBtn.click();

      // Item should be removed, consumed section should show empty state
      await expect(page.getByTestId('no-consumed')).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  // ===================================================================
  // Audit recommendation #24 (LOW): DST boundary at macros page render.
  //
  // Fall-back DST transition in America/New_York occurred at 2025-11-02
  // 02:00 local — the wall-clock hour 01:00-01:59 happened twice (once
  // EDT, once EST). The MacroPage builds its initial `currentDate` from
  // `toDateStr(new Date())` which internally uses `toLocaleDateString('sv-SE')`
  // in the browser's effective timezone. If a refactor ever drops the
  // locale-aware formatter for UTC-based slicing, the date label at the
  // DST boundary drifts by a day relative to the user's wall clock.
  //
  // We freeze the wall clock to a known instant in America/New_York,
  // set the test user's timezone + day_start_hour accordingly, render
  // the macros page, then assert the displayed date label matches the
  // expected logical_date. We then advance across the DST boundary and
  // re-render to confirm the label doesn't offset by an extra hour.
  //
  // Playwright 1.58 supports `page.clock.setFixedTime` — see docs:
  // https://playwright.dev/docs/clock
  // ===================================================================
  test.describe('DST fall-back boundary at 2025-11-02 01:30 America/New_York', () => {
    // `timezoneId` on the browser context pins the JS TZ-sensitive
    // APIs (`Intl.DateTimeFormat`, `toLocaleDateString`) to ET so the
    // frozen instants below are interpreted the same in CI and locally.
    test.use({ timezoneId: 'America/New_York' });

    test('macros date label at 01:30 EDT (before fall-back) + after the 02:00 snap to EST', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const { userId, cleanup, client } = await seedFullAndLogin(page, 'macro-dst');
      try {
        await seedChefByteData(client, userId);

        // Set the user's profile timezone + day_start_hour so the
        // server-side logical-date math matches the client wall clock.
        const { error: profErr } = await client
          .schema('hub')
          .from('profiles')
          .update({ timezone: 'America/New_York', day_start_hour: 4 })
          .eq('user_id', userId);
        expect(profErr).toBeNull();

        // Freeze the clock at 2025-11-02 01:30 America/New_York (still
        // EDT — fall-back happens at 02:00 → 01:00). Instant: because
        // America/New_York is UTC-4 at 01:30 EDT, 01:30-04:00 is the
        // correct ISO instant. Use page.clock.install so pre-existing
        // timers don't drift independently.
        await page.clock.install({ time: new Date('2025-11-02T01:30:00-04:00') });

        await page.goto('/chef/macros');
        await expect(page.getByTestId('macro-summary')).toBeVisible({ timeout: 30_000 });

        // MacroPage formats currentDate via `formatDateDisplay`:
        //   new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US',
        //     { weekday:'short', month:'short', day:'numeric' })
        // At 01:30 EDT on 2025-11-02, `toDateStr(new Date())` yields
        // "2025-11-02", so the label should read "Sun, Nov 2".
        const labelBefore = page.getByTestId('current-date');
        await expect(labelBefore).toHaveText('Sun, Nov 2', { timeout: 30_000 });

        // ─── Advance past the DST boundary ───
        // 02:30-05:00 is the SAME wall-clock day (2025-11-02) but now
        // in EST (UTC-5). Logical_date must STILL be 2025-11-02 — the
        // bug we're guarding against would offset the label by a day
        // due to TZ-math regression.
        await page.clock.setFixedTime(new Date('2025-11-02T02:30:00-05:00'));

        // Force a refetch by navigating to a different route and back.
        // The macros query key is ['daily-macros', userId, currentDate]
        // so the same-date refetch would be a cache hit; the round-trip
        // through another route + remount guarantees fresh renders that
        // re-read `new Date()` with the advanced clock.
        await page.goto('/chef/inventory');
        await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30_000 });
        await page.goto('/chef/macros');
        await expect(page.getByTestId('macro-summary')).toBeVisible({ timeout: 30_000 });

        const labelAfter = page.getByTestId('current-date');
        // Still "Sun, Nov 2" — the DST offset change from EDT → EST did
        // NOT shift the displayed logical date by a day.
        await expect(labelAfter).toHaveText('Sun, Nov 2', { timeout: 30_000 });
      } finally {
        await cleanup();
      }
    });
  });

  test('goal editing via modal saves new macro goals', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'macro-editgoals');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/macros');
      await expect(page.getByTestId('macro-summary')).toBeVisible({ timeout: 30000 });

      // Verify initial seeded goals (protein=180, carbs=220, fat=73, calories=2200)
      await expect(page.getByTestId('progress-protein')).toContainText('180');

      // Open the target macros modal
      await page.getByTestId('target-macros-btn').click();
      await expect(page.getByTestId('target-macros-modal')).toBeVisible({ timeout: 30000 });

      // Verify the modal is pre-filled with current goals
      const proteinInput = page.getByTestId('target-protein');
      await expect(proteinInput).toHaveValue('180');

      // Change protein to 200, carbs to 250, fat to 80
      await proteinInput.clear();
      await proteinInput.fill('200');

      const carbsInput = page.getByTestId('target-carbs');
      await carbsInput.clear();
      await carbsInput.fill('250');

      const fatInput = page.getByTestId('target-fats');
      await fatInput.clear();
      await fatInput.fill('80');

      // Auto-calculated calories should update: 200*4 + 250*4 + 80*9 = 800 + 1000 + 720 = 2520
      await expect(page.getByTestId('target-calories')).toContainText('2520');

      // Save the new targets
      await page.getByTestId('target-save-btn').click();

      // Modal should close
      await expect(page.getByTestId('target-macros-modal')).not.toBeVisible({ timeout: 30000 });

      // Progress bars should now reflect updated goals
      await expect(page.getByTestId('progress-protein')).toContainText('200');
      await expect(page.getByTestId('progress-carbs')).toContainText('250');
      await expect(page.getByTestId('progress-fats')).toContainText('80');
      await expect(page.getByTestId('progress-calories')).toContainText('2520');
    } finally {
      await cleanup();
    }
  });
});
