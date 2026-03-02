import { test, expect } from '@playwright/test';

test('dev server loads', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Luna/i);
  // Verify actual app content rendered (auth guard should show login form)
  await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible({ timeout: 5000 });
});
