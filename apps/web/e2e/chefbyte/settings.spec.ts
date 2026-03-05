import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData } from '../helpers/seed';

test.describe('ChefByte Settings', () => {
  test('settings page loads with products tab active', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-load');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      const productsTab = page.getByTestId('products-tab');
      await expect(productsTab).toBeVisible();

      const productList = page.getByTestId('product-list');
      await expect(productList).toBeVisible();

      // Should have seeded products
      const products = productList.locator('[data-testid^="product-"]');
      const count = await products.count();
      expect(count).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  test('product search filters product list', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-search');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      await page.getByTestId('product-list').waitFor({ state: 'visible' });

      // Type in search
      const searchInput = page.getByTestId('product-search').locator('input');
      await searchInput.fill('Chicken');

      // Wait for filtering to take effect
      await page.waitForTimeout(300);

      // Only Chicken-related products should be visible
      const productList = page.getByTestId('product-list');
      const visibleProducts = productList.locator('[data-testid^="product-"]:visible');
      const count = await visibleProducts.count();
      expect(count).toBeGreaterThanOrEqual(1);

      // Check that the visible product contains "Chicken"
      const firstProduct = visibleProducts.first();
      const text = await firstProduct.textContent();
      expect(text?.toLowerCase()).toContain('chicken');
    } finally {
      await cleanup();
    }
  });

  test('can toggle add product form', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-toggle-add');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      await page.getByTestId('product-list').waitFor({ state: 'visible' });

      // Initially the add product form should be hidden
      const addForm = page.getByTestId('add-product-form');
      await expect(addForm).toBeHidden();

      // Click toggle to open
      const toggleBtn = page.getByTestId('toggle-add-product');
      await toggleBtn.click();

      await expect(addForm).toBeVisible();

      // Click toggle again to close
      await toggleBtn.click();

      await expect(addForm).toBeHidden();
    } finally {
      await cleanup();
    }
  });

  test('can switch to liquidtrack tab', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-lt-tab');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      await page.getByTestId('products-tab').waitFor({ state: 'visible' });

      // Click LiquidTrack segment button to switch tabs
      await page.getByTestId('settings-tabs').locator('ion-segment-button[value="liquidtrack"]').click();

      // LiquidTrack tab content should be visible
      await expect(page.getByTestId('liquidtrack-tab')).toBeVisible({ timeout: 5000 });

      // Add device section should be visible
      const addDeviceSection = page.getByTestId('add-device-section');
      await expect(addDeviceSection).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('can edit a product', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-edit-prod');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      await page.getByTestId('product-list').waitFor({ state: 'visible' });

      // Click edit on the first product
      const editBtn = page.locator('[data-testid^="edit-product-"]').first();
      await editBtn.click();

      // Edit form should appear
      const saveEditBtn = page.getByTestId('save-edit-product');
      await expect(saveEditBtn).toBeVisible();

      const cancelBtn = page.getByTestId('cancel-edit-product');
      await expect(cancelBtn).toBeVisible();

      // Click cancel
      await cancelBtn.click();

      // Edit form should close
      await expect(saveEditBtn).toBeHidden();
    } finally {
      await cleanup();
    }
  });

  test('add product via settings form', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-add-prod');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      await page.getByTestId('product-list').waitFor({ state: 'visible' });

      // Count initial products
      const initialProducts = page.getByTestId('product-list').locator('[data-testid^="product-"]');
      const initialCount = await initialProducts.count();

      // Open the add product form
      await page.getByTestId('toggle-add-product').click();
      await expect(page.getByTestId('add-product-form')).toBeVisible();

      // Fill in name and nutrition fields
      const nameInput = page.getByTestId('add-name').locator('input');
      await nameInput.fill('E2E Test Oatmeal');

      const caloriesInput = page.getByTestId('add-calories').locator('input');
      await caloriesInput.fill('150');

      const proteinInput = page.getByTestId('add-protein').locator('input');
      await proteinInput.fill('5');

      const carbsInput = page.getByTestId('add-carbs').locator('input');
      await carbsInput.fill('27');

      const fatInput = page.getByTestId('add-fat').locator('input');
      await fatInput.fill('3');

      // Save the new product
      await page.getByTestId('save-new-product').click();

      // Form should close
      await expect(page.getByTestId('add-product-form')).toBeHidden();

      // Product list should now have one more product
      await page.waitForTimeout(500);
      const updatedProducts = page.getByTestId('product-list').locator('[data-testid^="product-"]');
      const updatedCount = await updatedProducts.count();
      expect(updatedCount).toBe(initialCount + 1);

      // Verify the new product appears in the list by searching for it
      const searchInput = page.getByTestId('product-search').locator('input');
      await searchInput.fill('E2E Test Oatmeal');
      await page.waitForTimeout(300);

      const filtered = page.getByTestId('product-list').locator('[data-testid^="product-"]:visible');
      const filteredCount = await filtered.count();
      expect(filteredCount).toBeGreaterThanOrEqual(1);

      const firstFiltered = filtered.first();
      const text = await firstFiltered.textContent();
      expect(text).toContain('E2E Test Oatmeal');
    } finally {
      await cleanup();
    }
  });

  test('delete product removes from list', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-del-prod');
    try {
      await seedChefByteData(client, userId);
      const chef = (client as any).schema('chefbyte');

      // Insert a standalone product with no stock/recipe deps so it can be deleted
      const { data: newProduct } = await chef
        .from('products')
        .insert({
          user_id: userId,
          name: 'E2E Delete Target',
          servings_per_container: 1,
          calories_per_serving: 100,
          protein_per_serving: 10,
          carbs_per_serving: 10,
          fat_per_serving: 5,
          min_stock_amount: 0,
        })
        .select('product_id')
        .single();
      const deleteProductId = newProduct.product_id;

      await page.goto('/chef/settings');
      await page.getByTestId('product-list').waitFor({ state: 'visible' });

      // Verify the product is in the list
      const productCard = page.getByTestId(`product-${deleteProductId}`);
      await expect(productCard).toBeVisible();

      // Click delete
      await page.getByTestId(`delete-product-${deleteProductId}`).click();

      // IonAlert confirmation dialog should appear — click Delete inside the alert overlay
      const alert = page.locator('ion-alert');
      await expect(alert).toBeVisible({ timeout: 5000 });
      const deleteBtnInAlert = alert.locator('button', { hasText: 'Delete' });
      await deleteBtnInAlert.click();

      // Product should be removed from the list
      await expect(productCard).toBeHidden({ timeout: 5000 });

      // Verify DB no longer has the product
      const { data: check } = await chef.from('products').select('product_id').eq('product_id', deleteProductId);
      expect(check?.length ?? 0).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test('locations tab shows default locations', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-loc-default');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      await page.getByTestId('products-tab').waitFor({ state: 'visible' });

      // Switch to the locations tab
      await page.getByTestId('settings-tabs').locator('ion-segment-button[value="locations"]').click();
      await expect(page.getByTestId('locations-tab')).toBeVisible({ timeout: 5000 });

      // Verify default locations (Fridge, Pantry, Freezer) are listed
      const locationList = page.getByTestId('location-list');
      await expect(locationList).toBeVisible();

      const locationText = await locationList.textContent();
      expect(locationText).toContain('Fridge');
      expect(locationText).toContain('Pantry');
      expect(locationText).toContain('Freezer');
    } finally {
      await cleanup();
    }
  });

  test('add new location', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'settings-add-loc');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      await page.getByTestId('products-tab').waitFor({ state: 'visible' });

      // Switch to the locations tab
      await page.getByTestId('settings-tabs').locator('ion-segment-button[value="locations"]').click();
      await expect(page.getByTestId('locations-tab')).toBeVisible({ timeout: 5000 });

      // Count initial locations
      const locationList = page.getByTestId('location-list');
      await expect(locationList).toBeVisible();
      const initialItems = locationList.locator('[data-testid^="location-"]');
      const initialCount = await initialItems.count();

      // Type a new location name
      const nameInput = page.getByTestId('location-name-input').locator('input');
      await nameInput.fill('Garage Shelf');

      // Click add
      await page.getByTestId('add-location-btn').click();

      // Wait for the list to update
      await page.waitForTimeout(500);

      // Verify new location is in the list
      const updatedItems = locationList.locator('[data-testid^="location-"]');
      const updatedCount = await updatedItems.count();
      expect(updatedCount).toBe(initialCount + 1);

      const listText = await locationList.textContent();
      expect(listText).toContain('Garage Shelf');
    } finally {
      await cleanup();
    }
  });

  // ── LiquidTrack E2E Tests ──────────────────────────────────────────────

  test('LiquidTrack tab loads with add-device section visible', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'lt-load');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      await page.getByTestId('products-tab').waitFor({ state: 'visible' });

      // Switch to LiquidTrack tab
      await page.getByTestId('settings-tabs').locator('ion-segment-button[value="liquidtrack"]').click();
      await expect(page.getByTestId('liquidtrack-tab')).toBeVisible({ timeout: 5000 });

      // Add device section and toggle button should be visible
      await expect(page.getByTestId('add-device-section')).toBeVisible();
      await expect(page.getByTestId('toggle-add-device')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('can create a new LiquidTrack device', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'lt-create');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      await page.getByTestId('products-tab').waitFor({ state: 'visible' });

      // Switch to LiquidTrack tab
      await page.getByTestId('settings-tabs').locator('ion-segment-button[value="liquidtrack"]').click();
      await expect(page.getByTestId('liquidtrack-tab')).toBeVisible({ timeout: 5000 });

      // Open the add device form
      await page.getByTestId('toggle-add-device').click();
      await expect(page.getByTestId('add-device-form')).toBeVisible();

      // Fill in device name
      const nameInput = page.getByTestId('device-name-input').locator('input');
      await nameInput.fill('E2E Scale');

      // Select a product via IonSelect → ion-alert (use .select-alert to avoid
      // matching the hidden Revoke Device confirmation alert)
      await page.getByTestId('device-product-select').click();
      const selectAlert = page.locator('ion-alert.select-alert');
      await expect(selectAlert).toBeVisible({ timeout: 5000 });
      // Select the first product option and confirm
      const firstOption = selectAlert.locator('button.alert-radio-button').first();
      await firstOption.click();
      const okBtn = selectAlert.locator('button', { hasText: 'OK' });
      await okBtn.click();

      // Generate the device
      await page.getByTestId('generate-device-btn').click();

      // Generated device info should appear
      await expect(page.getByTestId('generated-device-info')).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('generated device info card shows device_id and import key', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'lt-info');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      await page.getByTestId('products-tab').waitFor({ state: 'visible' });

      // Switch to LiquidTrack tab and create a device
      await page.getByTestId('settings-tabs').locator('ion-segment-button[value="liquidtrack"]').click();
      await expect(page.getByTestId('liquidtrack-tab')).toBeVisible({ timeout: 5000 });

      await page.getByTestId('toggle-add-device').click();
      await expect(page.getByTestId('add-device-form')).toBeVisible();

      const nameInput = page.getByTestId('device-name-input').locator('input');
      await nameInput.fill('E2E Scale');

      await page.getByTestId('device-product-select').click();
      const selectAlert = page.locator('ion-alert.select-alert');
      await expect(selectAlert).toBeVisible({ timeout: 5000 });
      await selectAlert.locator('button.alert-radio-button').first().click();
      await selectAlert.locator('button', { hasText: 'OK' }).click();

      await page.getByTestId('generate-device-btn').click();
      await expect(page.getByTestId('generated-device-info')).toBeVisible({ timeout: 5000 });

      // Verify the info card contains a UUID-like device_id and import key text
      const infoText = await page.getByTestId('generated-device-info').textContent();
      // Device ID should be a UUID-like string (8-4-4-4-12 hex pattern)
      expect(infoText).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      // Import key should also be present (non-empty text beyond the device_id)
      expect(infoText!.length).toBeGreaterThan(36);
    } finally {
      await cleanup();
    }
  });

  test('device appears in device list with Active status', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'lt-list');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      await page.getByTestId('products-tab').waitFor({ state: 'visible' });

      // Switch to LiquidTrack tab and create a device
      await page.getByTestId('settings-tabs').locator('ion-segment-button[value="liquidtrack"]').click();
      await expect(page.getByTestId('liquidtrack-tab')).toBeVisible({ timeout: 5000 });

      await page.getByTestId('toggle-add-device').click();
      await expect(page.getByTestId('add-device-form')).toBeVisible();

      const nameInput = page.getByTestId('device-name-input').locator('input');
      await nameInput.fill('E2E Scale');

      await page.getByTestId('device-product-select').click();
      const selectAlert = page.locator('ion-alert.select-alert');
      await expect(selectAlert).toBeVisible({ timeout: 5000 });
      await selectAlert.locator('button.alert-radio-button').first().click();
      await selectAlert.locator('button', { hasText: 'OK' }).click();

      await page.getByTestId('generate-device-btn').click();
      await expect(page.getByTestId('generated-device-info')).toBeVisible({ timeout: 5000 });

      // Device list should be visible with at least one device
      const deviceList = page.getByTestId('device-list');
      await expect(deviceList).toBeVisible({ timeout: 5000 });

      const devices = deviceList.locator('[data-testid^="device-"]');
      const count = await devices.count();
      expect(count).toBeGreaterThan(0);

      // Device should show Active status
      const listText = await deviceList.textContent();
      expect(listText).toContain('Active');
    } finally {
      await cleanup();
    }
  });

  test('revoke device button changes status', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'lt-revoke');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      await page.getByTestId('products-tab').waitFor({ state: 'visible' });

      // Switch to LiquidTrack tab and create a device
      await page.getByTestId('settings-tabs').locator('ion-segment-button[value="liquidtrack"]').click();
      await expect(page.getByTestId('liquidtrack-tab')).toBeVisible({ timeout: 5000 });

      await page.getByTestId('toggle-add-device').click();
      await expect(page.getByTestId('add-device-form')).toBeVisible();

      const nameInput = page.getByTestId('device-name-input').locator('input');
      await nameInput.fill('E2E Scale');

      await page.getByTestId('device-product-select').click();
      const selectAlert = page.locator('ion-alert.select-alert');
      await expect(selectAlert).toBeVisible({ timeout: 5000 });
      await selectAlert.locator('button.alert-radio-button').first().click();
      await selectAlert.locator('button', { hasText: 'OK' }).click();

      await page.getByTestId('generate-device-btn').click();
      await expect(page.getByTestId('generated-device-info')).toBeVisible({ timeout: 5000 });

      // Wait for the device to appear in the list
      const deviceList = page.getByTestId('device-list');
      await expect(deviceList).toBeVisible({ timeout: 5000 });

      // Click the revoke button for the first device
      const revokeBtn = deviceList.locator('[data-testid^="revoke-device-"]').first();
      await expect(revokeBtn).toBeVisible({ timeout: 5000 });
      await revokeBtn.click();

      // Confirm the revoke in the IonAlert confirmation dialog
      const revokeAlert = page.locator('ion-alert[header="Revoke Device"]');
      await expect(revokeAlert).toBeVisible({ timeout: 5000 });
      await revokeAlert.locator('button', { hasText: 'Revoke' }).click();

      // Device should now show Revoked status
      await expect(deviceList).toContainText('Revoked', { timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('show/hide events toggle works', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'lt-events');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings');

      await page.getByTestId('products-tab').waitFor({ state: 'visible' });

      // Switch to LiquidTrack tab and create a device
      await page.getByTestId('settings-tabs').locator('ion-segment-button[value="liquidtrack"]').click();
      await expect(page.getByTestId('liquidtrack-tab')).toBeVisible({ timeout: 5000 });

      await page.getByTestId('toggle-add-device').click();
      await expect(page.getByTestId('add-device-form')).toBeVisible();

      const nameInput = page.getByTestId('device-name-input').locator('input');
      await nameInput.fill('E2E Scale');

      await page.getByTestId('device-product-select').click();
      const selectAlert = page.locator('ion-alert.select-alert');
      await expect(selectAlert).toBeVisible({ timeout: 5000 });
      await selectAlert.locator('button.alert-radio-button').first().click();
      await selectAlert.locator('button', { hasText: 'OK' }).click();

      await page.getByTestId('generate-device-btn').click();
      await expect(page.getByTestId('generated-device-info')).toBeVisible({ timeout: 5000 });

      // Wait for the device to appear in the list
      const deviceList = page.getByTestId('device-list');
      await expect(deviceList).toBeVisible({ timeout: 5000 });

      // Click the events toggle for the first device
      const eventsToggle = deviceList.locator('[data-testid^="toggle-events-"]').first();
      await expect(eventsToggle).toBeVisible({ timeout: 5000 });
      await eventsToggle.click();

      // Events container should become visible
      const eventsContainer = deviceList.locator('[data-testid^="events-"]').first();
      await expect(eventsContainer).toBeVisible({ timeout: 5000 });

      // Click toggle again to hide
      await eventsToggle.click();

      // Events container should be hidden
      await expect(eventsContainer).toBeHidden({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });
});
