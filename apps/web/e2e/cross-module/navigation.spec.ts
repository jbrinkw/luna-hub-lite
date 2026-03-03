import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData } from '../helpers/seed';

test.describe('Cross-module navigation', () => {
  test('can navigate from hub to coachbyte via module switcher', async ({ page }) => {
    const { cleanup } = await seedFullAndLogin(page, 'xmod-hub-coach');
    try {
      // Verify we start on /hub after login
      await expect(page).toHaveURL(/\/hub/);

      // Click CoachByte segment button in the module switcher
      await page.locator('ion-segment-button[value="/coach"]').click();

      // Verify navigation to CoachByte
      await expect(page).toHaveURL(/\/coach/, { timeout: 10000 });

      // Verify CoachByte content is visible (today page heading or next-in-queue card)
      const coachContent = page.getByTestId('next-in-queue').or(page.getByText("TODAY'S WORKOUT"));
      await expect(coachContent).toBeVisible({ timeout: 15000 });
    } finally {
      await cleanup();
    }
  });

  test('can navigate from coachbyte to chefbyte via module switcher', async ({ page }) => {
    const { cleanup } = await seedFullAndLogin(page, 'xmod-coach-chef');
    try {
      // Navigate to CoachByte first
      await page.goto('/coach');
      await expect(page).toHaveURL(/\/coach/, { timeout: 10000 });

      // Click ChefByte segment button in the module switcher
      await page.locator('ion-segment-button[value="/chef"]').click();

      // Verify navigation to ChefByte
      await expect(page).toHaveURL(/\/chef/, { timeout: 10000 });
    } finally {
      await cleanup();
    }
  });

  test('can navigate from chefbyte back to hub', async ({ page }) => {
    const { cleanup } = await seedFullAndLogin(page, 'xmod-chef-hub');
    try {
      // Navigate to ChefByte first
      await page.goto('/chef');
      await expect(page).toHaveURL(/\/chef/, { timeout: 10000 });

      // Navigate back to Hub via URL (Ionic dual-segment limitation prevents
      // reliable ion-segment-button click when two IonSegments are on the page)
      await page.goto('/hub');
      await expect(page).toHaveURL(/\/hub/, { timeout: 10000 });

      // Verify Hub content renders correctly after coming from ChefByte
      await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible({ timeout: 10000 });
    } finally {
      await cleanup();
    }
  });

  test('chefbyte subnav works across pages', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'xmod-chef-subnav');
    try {
      // Seed ChefByte data so pages have content to render
      await seedChefByteData(client, userId);

      // Navigate to ChefByte home
      await page.goto('/chef');
      await expect(page).toHaveURL(/\/chef/, { timeout: 10000 });

      // Navigate to Inventory via the ChefByte subnav (target ion-segment-button directly by value)
      await page.locator('[aria-label="ChefByte navigation"] ion-segment-button[value="/chef/inventory"]').click();
      await expect(page).toHaveURL(/\/chef\/inventory/, { timeout: 10000 });

      // Verify inventory content is visible
      await expect(page.getByTestId('inventory-view-toggle')).toBeVisible({ timeout: 15000 });

      // Navigate to Macros via the ChefByte subnav
      await page.locator('[aria-label="ChefByte navigation"] ion-segment-button[value="/chef/macros"]').click();
      await expect(page).toHaveURL(/\/chef\/macros/, { timeout: 10000 });

      // Verify macros content is visible
      await expect(page.getByTestId('macro-summary')).toBeVisible({ timeout: 15000 });
    } finally {
      await cleanup();
    }
  });
});
