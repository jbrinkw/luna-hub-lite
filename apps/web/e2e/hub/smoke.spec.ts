import { test, expect } from '@playwright/test';

test('dev server loads', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Luna/i);
});
