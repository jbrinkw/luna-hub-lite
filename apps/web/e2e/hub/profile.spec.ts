import { test, expect } from '@playwright/test';
import { admin } from '../helpers/constants';

async function seedAndLogin(page: import('@playwright/test').Page, suffix: string) {
  const email = `e2e-prof-${suffix}-${Date.now()}@test.com`;
  const password = 'testpass123';
  const { data } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: `E2E ${suffix}` },
  });
  const userId = data.user!.id;

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/hub/, { timeout: 5000 });

  return { userId, email, password, cleanup: () => admin.auth.admin.deleteUser(userId) };
}

/** Navigate to account page and wait for the profile form to load */
async function gotoAccountPage(page: import('@playwright/test').Page) {
  await page.goto('/hub/account');
  // Wait for form to render (loading spinner replaced by content)
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible({ timeout: 15000 });
}

test.describe('Profile management', () => {
  test('account page shows profile form with current values', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'view');
    try {
      await gotoAccountPage(page);
      const nameInput = page.getByLabel('Display Name');
      await expect(nameInput).toBeVisible();
      await expect(nameInput).toHaveValue('E2E view');
    } finally {
      await cleanup();
    }
  });

  test('edit display_name and save shows success', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'edit-name');
    try {
      await gotoAccountPage(page);
      const nameInput = page.getByLabel('Display Name');
      await nameInput.clear();
      await nameInput.fill('New Display Name');
      await page.getByRole('button', { name: /save profile/i }).click();
      await expect(page.getByText(/profile updated/i)).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('reload after edit shows updated display_name', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'reload');
    try {
      await gotoAccountPage(page);
      const nameInput = page.getByLabel('Display Name');
      await nameInput.clear();
      await nameInput.fill('Persisted Name');
      await page.getByRole('button', { name: /save profile/i }).click();
      await expect(page.getByText(/profile updated/i)).toBeVisible();

      await page.reload();
      // Wait for form to re-render after reload restores auth session + fetches profile
      await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible({ timeout: 15000 });
      await expect(page.getByLabel('Display Name')).toHaveValue('Persisted Name');
    } finally {
      await cleanup();
    }
  });

  test('change password succeeds and new password works', async ({ page }) => {
    const { email, cleanup } = await seedAndLogin(page, 'pw-change');
    try {
      await gotoAccountPage(page);
      await page.getByLabel('New Password').fill('newpassword123');
      await page.getByLabel('Confirm Password').fill('newpassword123');
      await page.getByRole('button', { name: /change password/i }).click();
      await expect(page.getByText(/password updated/i)).toBeVisible();

      // Verify: logout and re-login with new password
      await page.getByRole('button', { name: /logout/i }).click();
      await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill('newpassword123');
      await page.getByRole('button', { name: /sign in/i }).click();
      await expect(page).toHaveURL(/\/hub/, { timeout: 10000 });
    } finally {
      await cleanup();
    }
  });

  test('password mismatch on account page shows error', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'pw-mismatch');
    try {
      await gotoAccountPage(page);
      await page.getByLabel('New Password').fill('password123');
      await page.getByLabel('Confirm Password').fill('different456');
      await page.getByRole('button', { name: /change password/i }).click();
      await expect(page.getByText(/passwords do not match/i)).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('timezone selector changes and persists after reload', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'tz-persist');
    try {
      await gotoAccountPage(page);

      // Change timezone to a known value different from the default (America/New_York)
      // IonSelect opens an ion-alert overlay when clicked
      await page.locator('ion-select[label="Timezone"]').click();
      // Wait for alert overlay to appear, then select the option
      const alert = page.locator('ion-alert');
      await expect(alert).toBeVisible({ timeout: 5000 });
      await alert.getByRole('radio', { name: 'America/Chicago' }).click();
      await alert.locator('.alert-button-group button', { hasText: /^OK$/i }).click();

      // Save profile
      await page.getByRole('button', { name: /save profile/i }).click();
      await expect(page.getByText(/profile updated/i)).toBeVisible();

      // Reload and verify persistence
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible({ timeout: 15000 });
      // The IonSelect should display the selected value in its shadow DOM
      await expect(page.locator('ion-select[label="Timezone"]')).toContainText('America/Chicago');
    } finally {
      await cleanup();
    }
  });

  test('day start hour selector changes and persists after reload', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'dsh-persist');
    try {
      await gotoAccountPage(page);

      // Change day start hour to 9:00 AM (value = 9)
      // IonSelect opens an ion-alert overlay when clicked
      await page.locator('ion-select[label="Day Start Hour"]').click();
      const alert = page.locator('ion-alert');
      await expect(alert).toBeVisible({ timeout: 5000 });
      await alert.locator('button', { hasText: '9:00 AM' }).click();
      await alert.locator('button', { hasText: /ok/i }).click();

      // Save profile
      await page.getByRole('button', { name: /save profile/i }).click();
      await expect(page.getByText(/profile updated/i)).toBeVisible();

      // Reload and verify persistence
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible({ timeout: 15000 });
      await expect(page.locator('ion-select[label="Day Start Hour"]')).toContainText('9:00 AM');
    } finally {
      await cleanup();
    }
  });

  test('profile form retains values during navigation away and back', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'nav-retain');
    try {
      await gotoAccountPage(page);

      // Change display name and save
      const nameInput = page.getByLabel('Display Name');
      await nameInput.clear();
      await nameInput.fill('Navigation Test Name');
      await page.getByRole('button', { name: /save profile/i }).click();
      await expect(page.getByText(/profile updated/i)).toBeVisible();

      // Navigate away to /hub/apps
      await page.goto('/hub/apps');
      await expect(page).toHaveURL(/\/hub\/apps/);

      // Navigate back to account page
      await gotoAccountPage(page);
      // The saved value should be loaded from the database
      await expect(page.getByLabel('Display Name')).toHaveValue('Navigation Test Name');
    } finally {
      await cleanup();
    }
  });
});
