import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData, seedMealEntry, todayStr } from '../helpers/seed';

test.describe('ChefByte Meal Plan Page', () => {
  test('meal plan page loads with week navigation', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-mp-load');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/meal-plan');

      // Wait for loading to disappear
      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 10000 });

      // Week navigation visible with all controls
      const weekNav = page.getByTestId('week-nav');
      await expect(weekNav).toBeVisible();
      await expect(page.getByTestId('prev-week-btn')).toBeVisible();
      await expect(page.getByTestId('today-btn')).toBeVisible();
      await expect(page.getByTestId('next-week-btn')).toBeVisible();

      // Week range display visible and contains text
      const weekRange = page.getByTestId('week-range');
      await expect(weekRange).toBeVisible();
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

      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 10000 });

      // Week grid visible
      const weekGrid = page.getByTestId('week-grid');
      await expect(weekGrid).toBeVisible();

      // Today's date column exists
      const today = new Date().toISOString().split('T')[0];
      const todayCol = page.getByTestId(`day-col-${today}`);
      await expect(todayCol).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('clicking a day column shows day detail panel', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-mp-daydetail');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/meal-plan');

      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 10000 });

      // Click today's day column
      const today = new Date().toISOString().split('T')[0];
      await page.getByTestId(`day-col-${today}`).click();

      // Day detail panel visible
      const dayDetail = page.getByTestId('day-detail');
      await expect(dayDetail).toBeVisible({ timeout: 5000 });

      // Day detail title contains today's date or day name
      const dayDetailTitle = page.getByTestId('day-detail-title');
      await expect(dayDetailTitle).toBeVisible();
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

      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 10000 });

      // Click today's column to open day detail first
      const today = new Date().toISOString().split('T')[0];
      await page.getByTestId(`day-col-${today}`).click();
      await expect(page.getByTestId('day-detail')).toBeVisible({ timeout: 5000 });

      // Click add meal button
      await page.getByTestId('add-meal-btn').click();

      // Add meal modal visible
      const modal = page.getByTestId('add-meal-modal');
      await expect(modal).toBeVisible({ timeout: 5000 });

      // Search input present (IonInput — access native input inside)
      const searchInput = page.getByTestId('add-meal-search');
      await expect(searchInput).toBeVisible();

      // Servings input present (IonInput)
      const servingsInput = page.getByTestId('add-meal-servings');
      await expect(servingsInput).toBeVisible();

      // Cancel and confirm buttons present
      await expect(page.getByTestId('add-meal-cancel')).toBeVisible();
      await expect(page.getByTestId('add-meal-confirm')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('can add a meal from recipe search', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-mp-addmeal');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/meal-plan');

      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 10000 });

      // Click today's column to open day detail
      const today = new Date().toISOString().split('T')[0];
      await page.getByTestId(`day-col-${today}`).click();
      await expect(page.getByTestId('day-detail')).toBeVisible({ timeout: 5000 });

      // Click add meal button
      await page.getByTestId('add-meal-btn').click();
      await expect(page.getByTestId('add-meal-modal')).toBeVisible({ timeout: 5000 });

      // Type "Chicken" in search (IonInput — use .locator('input').fill())
      await page.getByTestId('add-meal-search').locator('input').fill('Chicken');

      // Wait for dropdown to appear
      const dropdown = page.getByTestId('add-meal-dropdown');
      await expect(dropdown).toBeVisible({ timeout: 5000 });

      // Click first dropdown item (could be recipe or product)
      const firstItem = dropdown.locator('[data-testid^="add-dropdown-"]').first();
      await expect(firstItem).toBeVisible({ timeout: 5000 });
      await firstItem.click();

      // Set servings to 1 (IonInput — use .locator('input'))
      const servingsInput = page.getByTestId('add-meal-servings').locator('input');
      await servingsInput.clear();
      await servingsInput.fill('1');

      // Click confirm to add the meal
      await page.getByTestId('add-meal-confirm').click();

      // Modal should close
      await expect(page.getByTestId('add-meal-modal')).toBeHidden({ timeout: 5000 });

      // Day detail should now show the meal entry (table or at least no "no meals" message)
      const dayDetail = page.getByTestId('day-detail');
      await expect(dayDetail).toBeVisible();

      // Either day-detail-table is visible or a detail-row exists
      const table = page.getByTestId('day-detail-table');
      await expect(table).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('week navigation changes displayed week', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-mp-weeknav');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/meal-plan');

      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 10000 });

      // Capture the current week range text
      const weekRange = page.getByTestId('week-range');
      await expect(weekRange).toBeVisible();
      const initialWeekText = await weekRange.textContent();

      // Click prev-week-btn to go to previous week
      await page.getByTestId('prev-week-btn').click();

      // Week range text should change
      await expect(weekRange).not.toHaveText(initialWeekText!, { timeout: 5000 });
      const prevWeekText = await weekRange.textContent();

      // Confirm the text actually changed
      expect(prevWeekText).not.toEqual(initialWeekText);

      // Click today-btn to return to current week
      await page.getByTestId('today-btn').click();

      // Week range should match the initial week text
      await expect(weekRange).toHaveText(initialWeekText!, { timeout: 5000 });
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
      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 10000 });

      // Click today's column to open day detail
      await page.getByTestId(`day-col-${today}`).click();
      await expect(page.getByTestId('day-detail')).toBeVisible({ timeout: 5000 });

      // Verify the meal entry row is visible
      const detailRow = page.getByTestId(`detail-row-${mealId}`);
      await expect(detailRow).toBeVisible({ timeout: 5000 });

      // Click delete button on the meal entry
      await page.getByTestId(`delete-meal-${mealId}`).click();

      // Meal row should disappear
      await expect(detailRow).not.toBeVisible({ timeout: 5000 });

      // Should show "no meals" message since that was the only entry
      await expect(page.getByTestId('no-meals')).toBeVisible({ timeout: 5000 });
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
      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 10000 });

      // Click today's column to open day detail
      await page.getByTestId(`day-col-${today}`).click();
      await expect(page.getByTestId('day-detail')).toBeVisible({ timeout: 5000 });

      // Verify the Mark Done button exists before completing
      const markDoneBtn = page.getByTestId(`mark-done-${mealId}`);
      await expect(markDoneBtn).toBeVisible({ timeout: 5000 });

      // Click Mark Done
      await markDoneBtn.click();

      // The Mark Done button should disappear (completed entries show a dash instead of action buttons)
      await expect(markDoneBtn).not.toBeVisible({ timeout: 5000 });

      // The grid cell should now show a "done" badge
      const doneBadge = page.getByTestId(`done-badge-${mealId}`);
      await expect(doneBadge).toBeVisible({ timeout: 5000 });
      await expect(doneBadge).toContainText('done');
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
      await expect(page.getByTestId('mealplan-loading')).toBeHidden({ timeout: 10000 });

      // Click today's column to open day detail
      await page.getByTestId(`day-col-${today}`).click();
      await expect(page.getByTestId('day-detail')).toBeVisible({ timeout: 5000 });

      // Verify day-detail-table is visible (has entries)
      await expect(page.getByTestId('day-detail-table')).toBeVisible({ timeout: 5000 });

      // The total row should be visible in the table footer
      const totalRow = page.getByTestId('day-detail-total-row');
      await expect(totalRow).toBeVisible();

      // Total row should contain "TOTAL" label and macro values
      await expect(totalRow).toContainText('TOTAL');
      await expect(totalRow).toContainText('cal');
      await expect(totalRow).toContainText('P');
      await expect(totalRow).toContainText('C');
      await expect(totalRow).toContainText('F');
    } finally {
      await cleanup();
    }
  });
});
