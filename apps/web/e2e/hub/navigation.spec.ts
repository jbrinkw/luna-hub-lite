import { test, expect } from '@playwright/test';
import { seedFullAndLogin } from '../helpers/seed';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Lightweight seed for tests that don't need activated modules */
async function seedAndLogin(page: import('@playwright/test').Page, suffix: string) {
  const email = `e2e-nav-${suffix}-${Date.now()}@test.com`;
  const password = 'testpass123';
  const { data } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  const userId = data.user!.id;

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/hub/, { timeout: 5000 });

  return { userId, cleanup: () => admin.auth.admin.deleteUser(userId) };
}

test.describe('Hub navigation', () => {
  test('login redirects to /hub/account', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'default');
    try {
      await expect(page).toHaveURL(/\/hub\/account/);
      await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('click Account in side nav -> /hub/account', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'account');
    try {
      await page.getByLabel('Hub navigation').getByText('Account').click();
      await expect(page).toHaveURL(/\/hub\/account/);
      await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('click Apps in side nav -> /hub/apps', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'apps');
    try {
      await page.getByLabel('Hub navigation').getByText('Apps').click();
      await expect(page).toHaveURL(/\/hub\/apps/);
      await expect(page.locator('ion-card', { hasText: 'CoachByte' })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('click Tools in side nav -> /hub/tools', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'tools');
    try {
      await page.getByLabel('Hub navigation').getByText('Tools').click();
      await expect(page).toHaveURL(/\/hub\/tools/);
      await expect(page.getByText('COACHBYTE_LOG_SET')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('click Extensions in side nav -> /hub/extensions', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'ext');
    try {
      await page.getByLabel('Hub navigation').getByText('Extensions').click();
      await expect(page).toHaveURL(/\/hub\/extensions/);
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('click MCP Settings in side nav -> /hub/mcp', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'mcp');
    try {
      await page.getByLabel('Hub navigation').getByText('MCP Settings').click();
      await expect(page).toHaveURL(/\/hub\/mcp/);
      await expect(page.getByText('https://mcp.lunahub.dev/sse')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('active page highlighted in nav', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'active');
    try {
      // On /hub/account, Account should be highlighted in the side nav
      const nav = page.getByLabel('Hub navigation');
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
      const accountItem = nav.locator('[aria-current="page"]');
      await expect(accountItem).toContainText('Account');

      // Navigate to Apps and verify highlight changes
      await nav.getByText('Apps').click();
      await expect(page).toHaveURL(/\/hub\/apps/);
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
      const appsItem = nav.locator('[aria-current="page"]');
      await expect(appsItem).toContainText('Apps');
    } finally {
      await cleanup();
    }
  });

  test('module switcher: click CoachByte -> /coach', async ({ page }) => {
    // Must use seedFullAndLogin to activate modules (ModuleSwitcher filters by activation)
    const { cleanup } = await seedFullAndLogin(page, 'coach-switch');
    try {
      await page.locator('ion-segment-button[value="/coach"]').click();
      await expect(page).toHaveURL(/\/coach/, { timeout: 10000 });
    } finally {
      await cleanup();
    }
  });

  test('module switcher: click ChefByte -> /chef', async ({ page }) => {
    const { cleanup } = await seedFullAndLogin(page, 'chef-switch');
    try {
      await page.locator('ion-segment-button[value="/chef"]').click();
      await expect(page).toHaveURL(/\/chef/, { timeout: 10000 });
    } finally {
      await cleanup();
    }
  });

  test('404 catch-all: /hub/nonexistent shows "Page not found"', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, '404-hub');
    try {
      await page.goto('/hub/nonexistent');
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
      await expect(page.getByText('The page you requested does not exist.')).toBeVisible();
      await expect(page.getByRole('link', { name: /go to hub/i })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('404 catch-all: /chef/nonexistent shows "Page not found"', async ({ page }) => {
    // ChefByte must be activated to reach its router (ActivationGuard)
    const { cleanup } = await seedFullAndLogin(page, '404-chef');
    try {
      await page.goto('/chef/nonexistent');
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
      await expect(page.getByText('The page you requested does not exist.')).toBeVisible();
      await expect(page.getByRole('link', { name: /go to chefbyte/i })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('404 catch-all: /coach/nonexistent shows "Page not found"', async ({ page }) => {
    // CoachByte must be activated to reach its router (ActivationGuard)
    const { cleanup } = await seedFullAndLogin(page, '404-coach');
    try {
      await page.goto('/coach/nonexistent');
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
      await expect(page.getByText('The page you requested does not exist.')).toBeVisible();
      await expect(page.getByRole('link', { name: /go to coachbyte/i })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('404 catch-all: /nonexistent-path shows "Page not found"', async ({ page }) => {
    // A path not under /hub, /coach, or /chef still gets caught by the top-level catch-all
    const { cleanup } = await seedAndLogin(page, '404-toplevel');
    try {
      await page.goto('/nonexistent-path');
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
      await expect(page.getByText('The page you requested does not exist.')).toBeVisible();
      await expect(page.getByRole('link', { name: /go to hub/i })).toBeVisible();
    } finally {
      await cleanup();
    }
  });
});
