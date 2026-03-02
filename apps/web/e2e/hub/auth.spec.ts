import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Create a test user and return credentials */
async function seedUser(suffix: string) {
  const email = `e2e-${suffix}-${Date.now()}@test.com`;
  const password = 'testpass123';
  const { data } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: `E2E ${suffix}` },
  });
  return { email, password, userId: data.user!.id };
}

async function cleanupUser(userId: string) {
  await admin.auth.admin.deleteUser(userId);
}

test.describe('Auth flow', () => {
  test('visit / redirects to /login (auth guard)', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });

  test('login with valid credentials redirects to /hub', async ({ page }) => {
    const { email, password, userId } = await seedUser('login-valid');
    try {
      await page.goto('/login');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: /sign in/i }).click();
      await expect(page).toHaveURL(/\/hub/, { timeout: 5000 });
      // Verify the hub page actually rendered (not just URL)
      await expect(page.getByRole('button', { name: /logout/i })).toBeVisible();
    } finally {
      await cleanupUser(userId);
    }
  });

  test('login with invalid password shows error', async ({ page }) => {
    const { email, userId } = await seedUser('login-invalid');
    try {
      await page.goto('/login');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill('wrongpassword');
      await page.getByRole('button', { name: /sign in/i }).click();
      await expect(page.getByText(/invalid/i)).toBeVisible({ timeout: 5000 });
      await expect(page).toHaveURL(/\/login/);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('signup with valid inputs redirects to /hub', async ({ page }) => {
    const email = `e2e-signup-${Date.now()}@test.com`;
    let userId: string | undefined;
    try {
      await page.goto('/signup');
      await page.getByLabel('Display Name').fill('E2E Signup User');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill('testpass123');
      await page.getByRole('button', { name: /sign up/i }).click();
      await expect(page).toHaveURL(/\/hub/, { timeout: 5000 });

      // Get userId for cleanup
      const { data } = await admin.auth.admin.listUsers();
      const user = data.users.find((u) => u.email === email);
      userId = user?.id;
    } finally {
      if (userId) await cleanupUser(userId);
    }
  });

  test('signup with duplicate email does not create second account', async ({ page }) => {
    const { email, userId } = await seedUser('dup-signup');
    try {
      await page.goto('/signup');
      await page.getByLabel('Display Name').fill('Duplicate');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill('testpass123');
      await page.getByRole('button', { name: /sign up/i }).click();
      // Supabase local dev with email confirmation disabled may silently succeed
      // but should NOT create a second user. Verify only 1 user with this email exists.
      await page.waitForTimeout(2000);
      const { data } = await admin.auth.admin.listUsers();
      const matches = data.users.filter((u) => u.email === email);
      expect(matches.length).toBe(1);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('logout redirects to /login', async ({ page }) => {
    const { email, password, userId } = await seedUser('logout');
    try {
      // Login first
      await page.goto('/login');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: /sign in/i }).click();
      await expect(page).toHaveURL(/\/hub/, { timeout: 5000 });

      // Click logout
      await page.getByRole('button', { name: /logout/i }).click();
      await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
    } finally {
      await cleanupUser(userId);
    }
  });

  test('after logout, visit /hub redirects to /login', async ({ page }) => {
    const { email, password, userId } = await seedUser('post-logout');
    try {
      // Login
      await page.goto('/login');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: /sign in/i }).click();
      await expect(page).toHaveURL(/\/hub/, { timeout: 5000 });

      // Logout
      await page.getByRole('button', { name: /logout/i }).click();
      await expect(page).toHaveURL(/\/login/, { timeout: 5000 });

      // Try to visit /hub again
      await page.goto('/hub');
      await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
    } finally {
      await cleanupUser(userId);
    }
  });

  test('visit /coach without login redirects to /login', async ({ page }) => {
    await page.goto('/coach');
    await expect(page).toHaveURL(/\/login/);
  });

  test('visit /chef without login redirects to /login', async ({ page }) => {
    await page.goto('/chef');
    await expect(page).toHaveURL(/\/login/);
  });
});
