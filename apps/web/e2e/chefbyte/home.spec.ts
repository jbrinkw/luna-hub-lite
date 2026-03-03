import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData } from '../helpers/seed';

test.describe('ChefByte Home Page', () => {
  test('home page loads with status cards and macro summary', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-home-load');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/home');

      // Wait for loading to disappear
      await expect(page.getByTestId('home-loading')).toBeHidden({ timeout: 10000 });

      // Status cards section visible with all 4 cards
      const statusCards = page.getByTestId('status-cards');
      await expect(statusCards).toBeVisible();
      await expect(page.getByTestId('card-missing-prices')).toBeVisible();
      await expect(page.getByTestId('card-placeholders')).toBeVisible();
      await expect(page.getByTestId('card-below-min')).toBeVisible();
      await expect(page.getByTestId('card-cart-value')).toBeVisible();

      // Macro summary section visible with all 4 compact progress bars
      const macroSummary = page.getByTestId('macro-summary');
      await expect(macroSummary).toBeVisible();
      await expect(page.getByTestId('compact-calories')).toBeVisible();
      await expect(page.getByTestId('compact-protein')).toBeVisible();
      await expect(page.getByTestId('compact-carbs')).toBeVisible();
      await expect(page.getByTestId('compact-fats')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('quick action buttons are visible', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-home-actions');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/home');

      await expect(page.getByTestId('home-loading')).toBeHidden({ timeout: 10000 });

      // Quick actions section visible with all 4 buttons
      const quickActions = page.getByTestId('quick-actions');
      await expect(quickActions).toBeVisible();
      await expect(page.getByTestId('import-shopping-btn')).toBeVisible();
      await expect(page.getByTestId('target-macros-btn')).toBeVisible();
      await expect(page.getByTestId('taste-profile-btn')).toBeVisible();
      await expect(page.getByTestId('meal-plan-cart-btn')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('target macros modal opens and shows auto-calculated calories', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-home-macros');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/home');

      await expect(page.getByTestId('home-loading')).toBeHidden({ timeout: 10000 });

      // Click target macros quick action button
      await page.getByTestId('target-macros-btn').click();

      // Modal opens
      const modal = page.getByTestId('target-macros-modal');
      await expect(modal).toBeVisible({ timeout: 5000 });

      // Protein, carbs, fats inputs present
      await expect(page.getByTestId('target-protein')).toBeVisible();
      await expect(page.getByTestId('target-carbs')).toBeVisible();
      await expect(page.getByTestId('target-fats')).toBeVisible();

      // Auto-calculated calories display present
      await expect(page.getByTestId('target-calories')).toBeVisible();

      // Cancel and save buttons present
      await expect(page.getByTestId('target-cancel-btn')).toBeVisible();
      await expect(page.getByTestId('target-save-btn')).toBeVisible();

      // Click cancel to close
      await page.getByTestId('target-cancel-btn').click();
      await expect(modal).toBeHidden({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('taste profile modal opens with textarea', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-home-taste');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/home');

      await expect(page.getByTestId('home-loading')).toBeHidden({ timeout: 10000 });

      // Click taste profile quick action button
      await page.getByTestId('taste-profile-btn').click();

      // Taste modal opens
      const modal = page.getByTestId('taste-modal');
      await expect(modal).toBeVisible({ timeout: 5000 });

      // Textarea present
      await expect(page.getByTestId('taste-textarea')).toBeVisible();

      // Cancel and save buttons present
      await expect(page.getByTestId('taste-cancel-btn')).toBeVisible();
      await expect(page.getByTestId('taste-save-btn')).toBeVisible();

      // Click cancel to close
      await page.getByTestId('taste-cancel-btn').click();
      await expect(modal).toBeHidden({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('meal prep section shows empty state when no preps scheduled', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-home-noprep');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/home');

      await expect(page.getByTestId('home-loading')).toBeHidden({ timeout: 10000 });

      // Meal prep section visible
      const mealPrepSection = page.getByTestId('meal-prep-section');
      await expect(mealPrepSection).toBeVisible();

      // No meal prep message visible (empty state)
      await expect(page.getByTestId('no-meal-prep')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('below-min stock count reflects seed data', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'chef-home-belowmin');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/home');

      await expect(page.getByTestId('home-loading')).toBeHidden({ timeout: 10000 });

      // card-below-min should contain "2" (Eggs: 0.5 < 1 min, Bananas: 0 < 3 min)
      const belowMinCard = page.getByTestId('card-below-min');
      await expect(belowMinCard).toBeVisible();
      await expect(belowMinCard).toContainText('2');
    } finally {
      await cleanup();
    }
  });
});
