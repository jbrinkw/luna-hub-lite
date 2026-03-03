import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function seedAndLogin(page: import('@playwright/test').Page, suffix: string) {
  const email = `e2e-ext-${suffix}-${Date.now()}@test.com`;
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

test.describe('Extensions page', () => {
  test('shows all three extension cards', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'cards');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 5000 });
      await expect(page.getByRole('heading', { name: 'Todoist' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Home Assistant' })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('enable extension toggle shows credential form', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'enable');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 5000 });

      const obsidianCard = page.locator('ion-card', { hasText: 'Obsidian' });
      await obsidianCard.locator('ion-toggle').click();

      await expect(obsidianCard.getByText(/vault path/i)).toBeVisible();
      await expect(obsidianCard.getByRole('button', { name: /save credentials/i })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('save credentials shows success message', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'save');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Todoist' })).toBeVisible({ timeout: 5000 });

      const todoistCard = page.locator('ion-card', { hasText: 'Todoist' });
      await todoistCard.locator('ion-toggle').click();

      await todoistCard.getByLabel(/api token/i).fill('test-token-123');
      await todoistCard.getByRole('button', { name: /save credentials/i }).click();

      await expect(todoistCard.getByText(/credentials saved/i)).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('credentials persist after reload', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'persist');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 5000 });

      const obsidianCard = page.locator('ion-card', { hasText: 'Obsidian' });
      await obsidianCard.locator('ion-toggle').click();
      await obsidianCard.getByLabel(/vault path/i).fill('/my/vault');
      await obsidianCard.getByRole('button', { name: /save credentials/i }).click();
      await expect(obsidianCard.getByText(/credentials saved/i)).toBeVisible({ timeout: 5000 });

      await page.reload();
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 15000 });
      await expect(page.locator('ion-card', { hasText: 'Obsidian' }).getByText(/credentials configured/i)).toBeVisible();
    } finally {
      await cleanup();
    }
  });
});
