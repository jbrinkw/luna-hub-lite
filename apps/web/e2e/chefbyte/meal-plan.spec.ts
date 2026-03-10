import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData, seedMealEntry, todayStr } from '../helpers/seed';

test.describe('ChefByte Meal Plan Page', () => {
  test('meal plan page loads with week navigation', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-mp-load');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/meal-plan');

      // Wait for loading to disappear
      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 30000 });

      // Week navigation visible with all controls
      const weekNav = page.getByTestId('week-nav');
      await expect(weekNav).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('prev-week-btn')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('today-btn')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('next-week-btn')).toBeVisible({ timeout: 30000 });

      // Week range display visible and contains text
      const weekRange = page.getByTestId('week-range');
      await expect(weekRange).toBeVisible({ timeout: 30000 });
      await expect(weekRange).not.toBeEmpty();
    } finally {
      await cleanup();
    }
  });

  test('week grid shows 7 day columns', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-mp-grid');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/meal-plan');

      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 30000 });

      // Week grid visible
      const weekGrid = page.getByTestId('week-grid');
      await expect(weekGrid).toBeVisible({ timeout: 30000 });

      // Today's date column exists
      const today = todayStr();
      const todayCol = page.getByTestId(`day-col-${today}`);
      await expect(todayCol).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('clicking a day column shows day detail panel', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-mp-daydetail');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/meal-plan');

      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 30000 });

      // Click today's day column
      const today = todayStr();
      await page.getByTestId(`day-col-${today}`).click();

      // Day detail panel visible
      const dayDetail = page.getByTestId('day-detail');
      await expect(dayDetail).toBeVisible({ timeout: 30000 });

      // Day detail title contains today's date or day name
      const dayDetailTitle = page.getByTestId('day-detail-title');
      await expect(dayDetailTitle).toBeVisible({ timeout: 30000 });
      await expect(dayDetailTitle).not.toBeEmpty();
    } finally {
      await cleanup();
    }
  });

  test('add meal button opens modal with search', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-mp-addmodal');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/meal-plan');

      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 30000 });

      // Click today's column to open day detail first
      const today = todayStr();
      await page.getByTestId(`day-col-${today}`).click();
      await expect(page.getByTestId('day-detail')).toBeVisible({ timeout: 30000 });

      // Click add meal button
      await page.getByTestId('add-meal-btn').click();

      // Add meal modal visible
      const modal = page.getByTestId('add-meal-modal');
      await expect(modal).toBeVisible({ timeout: 30000 });

      // Search input present
      const searchInput = page.getByTestId('add-meal-search');
      await expect(searchInput).toBeVisible({ timeout: 30000 });

      // Servings input present
      const servingsInput = page.getByTestId('add-meal-servings');
      await expect(servingsInput).toBeVisible({ timeout: 30000 });

      // Cancel and confirm buttons present
      await expect(page.getByTestId('add-meal-cancel')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('add-meal-confirm')).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('can add a meal from recipe search', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-mp-addmeal');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/meal-plan');

      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 30000 });

      // Click today's column to open day detail
      const today = todayStr();
      await page.getByTestId(`day-col-${today}`).click();
      await expect(page.getByTestId('day-detail')).toBeVisible({ timeout: 30000 });

      // Click add meal button
      await page.getByTestId('add-meal-btn').click();
      await expect(page.getByTestId('add-meal-modal')).toBeVisible({ timeout: 30000 });

      // Type "Chicken" in search
      await page.getByTestId('add-meal-search').fill('Chicken');

      // Wait for dropdown to appear
      const dropdown = page.getByTestId('add-meal-dropdown');
      await expect(dropdown).toBeVisible({ timeout: 30000 });

      // Click first dropdown item (could be recipe or product)
      const firstItem = dropdown.locator('[data-testid^="add-dropdown-"]').first();
      await expect(firstItem).toBeVisible({ timeout: 30000 });
      await firstItem.click();

      // Set servings to 1
      const servingsInput = page.getByTestId('add-meal-servings');
      await servingsInput.clear();
      await servingsInput.fill('1');

      // Click confirm to add the meal
      await page.getByTestId('add-meal-confirm').click();

      // Modal should close
      await expect(page.getByTestId('add-meal-modal')).toBeHidden({ timeout: 30000 });

      // Day detail should now show the meal entry (table or at least no "no meals" message)
      const dayDetail = page.getByTestId('day-detail');
      await expect(dayDetail).toBeVisible({ timeout: 30000 });

      // Either day-detail-table is visible or a detail-row exists
      const table = page.getByTestId('day-detail-table');
      await expect(table).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('week navigation changes displayed week', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-mp-weeknav');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/meal-plan');

      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 30000 });

      // Capture the current week range text
      const weekRange = page.getByTestId('week-range');
      await expect(weekRange).toBeVisible({ timeout: 30000 });
      const initialWeekText = await weekRange.textContent();

      // Click prev-week-btn to go to previous week
      await page.getByTestId('prev-week-btn').click();

      // Week range text should change
      await expect(weekRange).not.toHaveText(initialWeekText!, { timeout: 30000 });
      const prevWeekText = await weekRange.textContent();

      // Confirm the text actually changed
      expect(prevWeekText).not.toEqual(initialWeekText);

      // Click today-btn to return to current week
      await page.getByTestId('today-btn').click();

      // Week range should match the initial week text
      await expect(weekRange).toHaveText(initialWeekText!, { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('delete meal entry from day detail panel', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-mp-delete');
    try {
      const { recipeId } = await seedChefByteData(client, userId);
      const today = todayStr();
      const mealId = await seedMealEntry(client, userId, recipeId, today, { servings: 1, mealType: 'lunch' });

      await page.goto('/chef/meal-plan');
      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 30000 });

      // Click today's column to open day detail
      await page.getByTestId(`day-col-${today}`).click();
      await expect(page.getByTestId('day-detail')).toBeVisible({ timeout: 30000 });

      // Verify the meal entry row is visible
      const detailRow = page.getByTestId(`detail-row-${mealId}`);
      await expect(detailRow).toBeVisible({ timeout: 30000 });

      // Click delete button (first click shows "You sure?" confirmation)
      await page.getByTestId(`delete-meal-${mealId}`).click();
      // Click again to confirm deletion
      await page.getByTestId(`delete-meal-${mealId}`).click();

      // Meal row should disappear (allow extra time for production Realtime latency)
      await expect(detailRow).not.toBeVisible({ timeout: 30000 });

      // Should show "no meals" message since that was the only entry
      await expect(page.getByTestId('no-meals')).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('mark meal as completed changes appearance', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-mp-markdone');
    try {
      const { recipeId } = await seedChefByteData(client, userId);
      const today = todayStr();
      const mealId = await seedMealEntry(client, userId, recipeId, today, {
        servings: 1,
        mealType: 'dinner',
        isMealPrep: false,
      });

      await page.goto('/chef/meal-plan');
      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 30000 });

      // Click today's column to open day detail
      await page.getByTestId(`day-col-${today}`).click();
      await expect(page.getByTestId('day-detail')).toBeVisible({ timeout: 30000 });

      // Verify the Mark Done button exists before completing
      const markDoneBtn = page.getByTestId(`mark-done-${mealId}`);
      await expect(markDoneBtn).toBeVisible({ timeout: 30000 });

      // Click Mark Done
      await markDoneBtn.click();

      // The Mark Done button should disappear (completed entries show a dash instead of action buttons)
      await expect(markDoneBtn).not.toBeVisible({ timeout: 30000 });

      // The grid cell should now show a "done" badge
      const doneBadge = page.getByTestId(`done-badge-${mealId}`);
      await expect(doneBadge).toBeVisible({ timeout: 30000 });
      await expect(doneBadge).toContainText(/done/i, { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('meal_type labels display correctly for each meal entry', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-mp-types');
    try {
      const { recipeId } = await seedChefByteData(client, userId);
      const today = todayStr();

      // Seed entries with different meal types
      const breakfastId = await seedMealEntry(client, userId, recipeId, today, { servings: 1, mealType: 'breakfast' });
      const lunchId = await seedMealEntry(client, userId, recipeId, today, { servings: 1, mealType: 'lunch' });
      const dinnerId = await seedMealEntry(client, userId, recipeId, today, { servings: 1, mealType: 'dinner' });
      const snackId = await seedMealEntry(client, userId, recipeId, today, { servings: 1, mealType: 'snack' });

      await page.goto('/chef/meal-plan');
      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 30000 });

      // Verify meal_type labels appear in the grid cells
      await expect(page.getByTestId(`meal-type-label-${breakfastId}`)).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId(`meal-type-label-${breakfastId}`)).toContainText('breakfast', { timeout: 30000 });

      await expect(page.getByTestId(`meal-type-label-${lunchId}`)).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId(`meal-type-label-${lunchId}`)).toContainText('lunch', { timeout: 30000 });

      await expect(page.getByTestId(`meal-type-label-${dinnerId}`)).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId(`meal-type-label-${dinnerId}`)).toContainText('dinner', { timeout: 30000 });

      await expect(page.getByTestId(`meal-type-label-${snackId}`)).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId(`meal-type-label-${snackId}`)).toContainText('snack', { timeout: 30000 });

      // Also verify labels render in the day detail panel
      await page.getByTestId(`day-col-${today}`).click();
      await expect(page.getByTestId('day-detail')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('day-detail-table')).toBeVisible({ timeout: 30000 });

      // The detail table Type column shows meal_type with capitalize style
      const breakfastRow = page.getByTestId(`detail-row-${breakfastId}`);
      await expect(breakfastRow).toContainText('breakfast', { timeout: 30000 });
      const dinnerRow = page.getByTestId(`detail-row-${dinnerId}`);
      await expect(dinnerRow).toContainText('dinner', { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('each meal entry shows macro breakdown in grid and detail', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-mp-entrymacros');
    try {
      const { recipeId } = await seedChefByteData(client, userId);
      const today = todayStr();

      const mealId = await seedMealEntry(client, userId, recipeId, today, { servings: 2, mealType: 'lunch' });

      await page.goto('/chef/meal-plan');
      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 30000 });

      // Verify macros appear on the grid cell for this meal
      const gridMacros = page.getByTestId(`grid-macros-${mealId}`);
      await expect(gridMacros).toBeVisible({ timeout: 30000 });
      // Should contain calorie value and macro abbreviations (text format: "Xcal | Yg P | Zg C | Wg F")
      await expect(gridMacros).toContainText(/\d+cal/, { timeout: 30000 });
      await expect(gridMacros).toContainText(/\d+g P/, { timeout: 30000 });
      await expect(gridMacros).toContainText(/\d+g C/, { timeout: 30000 });
      await expect(gridMacros).toContainText(/\d+g F/, { timeout: 30000 });

      // Open day detail and verify macros in the detail row
      await page.getByTestId(`day-col-${today}`).click();
      await expect(page.getByTestId('day-detail')).toBeVisible({ timeout: 30000 });

      const detailRow = page.getByTestId(`detail-row-${mealId}`);
      await expect(detailRow).toBeVisible({ timeout: 30000 });
      // Detail row shows "X cal | Yg P | Zg C | Wg F" (may or may not have space before "cal")
      await expect(detailRow).toContainText(/\d+\s*cal/, { timeout: 30000 });
      await expect(detailRow).toContainText(/\d+g P/, { timeout: 30000 });
      await expect(detailRow).toContainText(/\d+g C/, { timeout: 30000 });
      await expect(detailRow).toContainText(/\d+g F/, { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('meal prep: mark done creates [MEAL] product in inventory', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-mp-prepflow');
    try {
      const { recipeId } = await seedChefByteData(client, userId);
      const today = todayStr();

      // Seed a meal prep entry
      const mealId = await seedMealEntry(client, userId, recipeId, today, {
        servings: 2,
        mealType: 'lunch',
        isMealPrep: true,
      });

      await page.goto('/chef/meal-plan');
      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 30000 });

      // Click today's column to open day detail
      await page.getByTestId(`day-col-${today}`).click();
      await expect(page.getByTestId('day-detail')).toBeVisible({ timeout: 30000 });

      // Verify the meal entry is there and shows PREP badge in grid
      await expect(page.getByTestId(`prep-badge-${mealId}`)).toBeVisible({ timeout: 30000 });

      // Click Mark Done on the meal prep entry
      const markDoneBtn = page.getByTestId(`mark-done-${mealId}`);
      await expect(markDoneBtn).toBeVisible({ timeout: 30000 });
      await markDoneBtn.click();

      // Wait for completion — Mark Done button should disappear and done badge should appear
      await expect(markDoneBtn).not.toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId(`done-badge-${mealId}`)).toBeVisible({ timeout: 30000 });

      // Navigate to inventory and verify [MEAL] product was created
      await page.goto('/chef/inventory');
      await expect(page.getByTestId('inventory-loading')).toBeHidden({ timeout: 30000 });

      // Search for [MEAL] in inventory
      const searchInput = page.getByTestId('inventory-search');
      await searchInput.fill('[MEAL]');

      // The grouped view should show a product starting with "[MEAL] Chicken & Rice"
      const groupedView = page.getByTestId('grouped-view');
      await expect(groupedView).toBeVisible({ timeout: 30000 });
      await expect(groupedView).toContainText('[MEAL] Chicken & Rice', { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('day macro summary shows totals', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-mp-macrototal');
    try {
      const { recipeId } = await seedChefByteData(client, userId);
      const today = todayStr();

      // Seed two meal entries for today
      await seedMealEntry(client, userId, recipeId, today, { servings: 1, mealType: 'lunch' });
      await seedMealEntry(client, userId, recipeId, today, { servings: 2, mealType: 'dinner' });

      await page.goto('/chef/meal-plan');
      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 30000 });

      // Click today's column to open day detail
      await page.getByTestId(`day-col-${today}`).click();
      await expect(page.getByTestId('day-detail')).toBeVisible({ timeout: 30000 });

      // Verify day-detail-table is visible (has entries)
      await expect(page.getByTestId('day-detail-table')).toBeVisible({ timeout: 30000 });

      // The total row should be visible in the table footer
      const totalRow = page.getByTestId('day-detail-total-row');
      await expect(totalRow).toBeVisible({ timeout: 30000 });

      // Total row should contain "TOTAL" label and macro values
      await expect(totalRow).toContainText('TOTAL', { timeout: 30000 });
      await expect(totalRow).toContainText('cal', { timeout: 30000 });
      await expect(totalRow).toContainText('P', { timeout: 30000 });
      await expect(totalRow).toContainText('C', { timeout: 30000 });
      await expect(totalRow).toContainText('F', { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });
});
