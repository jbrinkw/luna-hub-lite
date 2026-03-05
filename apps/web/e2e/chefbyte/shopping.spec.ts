import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData, seedShoppingItems } from '../helpers/seed';

test.describe('ChefByte Shopping', () => {
  test('shopping page loads with add form and empty lists', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-load');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/shopping');

      // Add item form should be visible
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 15000 });

      // To Buy section visible with empty state
      await expect(page.getByTestId('to-buy-section')).toBeVisible();
      await expect(page.getByTestId('no-to-buy')).toBeVisible();
      await expect(page.getByTestId('no-to-buy')).toContainText('No items to buy');

      // Purchased section visible with empty state
      await expect(page.getByTestId('purchased-section')).toBeVisible();
      await expect(page.getByTestId('no-purchased')).toBeVisible();
      await expect(page.getByTestId('no-purchased')).toContainText('No purchased items');
    } finally {
      await cleanup();
    }
  });

  test('auto-add button populates items below min stock', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-auto');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 15000 });

      // Initially the to-buy list should be empty
      await expect(page.getByTestId('no-to-buy')).toBeVisible();

      // Click the auto-add button
      await page.getByTestId('auto-add-btn').click();

      // To-buy list should now appear with items below min stock
      // Eggs: 0.5 stock < 1 min -> needs 1 container (ceil(1 - 0.5) = 1)
      // Bananas: 0 stock < 3 min -> needs 3 containers (ceil(3 - 0) = 3)
      await expect(page.getByTestId('to-buy-list')).toBeVisible({ timeout: 10000 });

      const toBuySection = page.getByTestId('to-buy-section');
      await expect(toBuySection).toContainText('Eggs');
      await expect(toBuySection).toContainText('Bananas');

      // Empty state should be gone now
      await expect(page.getByTestId('no-to-buy')).not.toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('can add a manual item to shopping list', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-manual');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 15000 });

      // Type a product name into the item name input (IonInput wraps native input)
      await page.getByTestId('add-item-name').locator('input').fill('Chicken');

      // Wait for dropdown to appear with matching product
      await expect(page.getByTestId('product-dropdown')).toBeVisible({ timeout: 5000 });

      // Click the first matching dropdown item (Chicken Breast)
      const dropdownItems = page.getByTestId('product-dropdown').locator('[data-testid^="dropdown-item-"]');
      await expect(dropdownItems.first()).toBeVisible();
      await dropdownItems.first().click();

      // Set quantity to 2
      await page.getByTestId('add-item-qty').locator('input').fill('2');

      // Click the Add button
      await page.getByTestId('add-item-btn').click();

      // Verify the item appears in the to-buy list
      await expect(page.getByTestId('to-buy-list')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('to-buy-section')).toContainText('Chicken Breast');
    } finally {
      await cleanup();
    }
  });

  test('checking an item moves it to purchased section', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-check');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 15000 });

      // Add items via auto-add so we have items to work with
      await page.getByTestId('auto-add-btn').click();
      await expect(page.getByTestId('to-buy-list')).toBeVisible({ timeout: 10000 });

      // Find the first item in the to-buy list and get its name for later verification
      const firstItem = page.getByTestId('to-buy-list').locator('[data-testid^="item-"]').first();
      await expect(firstItem).toBeVisible();
      const itemName = await firstItem.locator('span').first().innerText();

      // Click the checkbox on the first item to mark it as purchased
      const firstCheckbox = page.getByTestId('to-buy-list').locator('[data-testid^="check-"]').first();
      await firstCheckbox.click();

      // Wait for the purchased list to appear with the checked item
      await expect(page.getByTestId('purchased-list')).toBeVisible({ timeout: 10000 });

      // The purchased section should contain the item name
      await expect(page.getByTestId('purchased-section')).toContainText(itemName);

      // The empty purchased state should be gone
      await expect(page.getByTestId('no-purchased')).not.toBeVisible();
    } finally {
      await cleanup();
    }
  });

  // TODO: No "Clear Purchased" button exists on the shopping page. Only "Import to Inventory" and "Clear All" are available.
  test.skip('clear purchased button removes all purchased items', async () => {
    // ShoppingPage has no dedicated "clear purchased" button.
    // The closest functionality is "Import to Inventory" which moves purchased items to stock and removes them.
  });

  test('clear all button removes all items', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-clearall');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      // Seed shopping items so we have items to clear
      await seedShoppingItems(client, userId, [
        { productId: productMap['Chicken Breast'], qtyContainers: 2 },
        { productId: productMap['Brown Rice'], qtyContainers: 1 },
      ]);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 15000 });

      // Verify items are in the to-buy list
      await expect(page.getByTestId('to-buy-list')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('to-buy-section')).toContainText('Chicken Breast');

      // Click clear all button (this opens an IonAlert confirmation)
      await page.getByTestId('clear-all-btn').click();

      // Confirm the alert dialog — IonAlert renders buttons in the dialog overlay
      const alert = page.locator('ion-alert');
      await expect(alert).toBeVisible({ timeout: 5000 });
      const clearAllConfirmBtn = alert.locator('button', { hasText: 'Clear All' });
      await clearAllConfirmBtn.click();

      // Both sections should now show empty states
      await expect(page.getByTestId('no-to-buy')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('no-purchased')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('delete individual shopping item', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-delitem');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      // Seed a single shopping item
      const [cartItemId] = await seedShoppingItems(client, userId, [
        { productId: productMap['Eggs'], qtyContainers: 1 },
      ]);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 15000 });

      // Verify the item is visible in to-buy list
      await expect(page.getByTestId('to-buy-list')).toBeVisible({ timeout: 10000 });
      const itemRow = page.getByTestId(`item-${cartItemId}`);
      await expect(itemRow).toBeVisible();
      await expect(itemRow).toContainText('Eggs');

      // Click the remove button for this specific item
      await page.getByTestId(`remove-${cartItemId}`).click();

      // Item should be removed; to-buy list should show empty state
      await expect(itemRow).not.toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId('no-to-buy')).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('product dropdown search shows matching products', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-dropdown');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 15000 });

      // Type "Chick" in the add-item search field
      const searchInput = page.getByTestId('add-item-name').locator('input');
      await searchInput.fill('Chick');

      // Wait for the product dropdown to appear (300ms debounce + query)
      const dropdown = page.getByTestId('product-dropdown');
      await expect(dropdown).toBeVisible({ timeout: 5000 });

      // Dropdown should contain "Chicken Breast" as a matching product
      await expect(dropdown).toContainText('Chicken Breast');

      // Dropdown items should have data-testid prefix
      const dropdownItems = dropdown.locator('[data-testid^="dropdown-item-"]');
      const count = await dropdownItems.count();
      expect(count).toBeGreaterThan(0);

      // Click the Chicken Breast item — search field should be populated and dropdown should close
      await dropdownItems.first().click();
      await expect(dropdown).not.toBeVisible({ timeout: 3000 });
      await expect(searchInput).toHaveValue('Chicken Breast');

      // Clear and type something with no matches
      await searchInput.fill('');
      await searchInput.fill('ZZZNOMATCH');

      // Dropdown should not appear for non-matching search
      // Wait a bit for debounce to fire
      await page.waitForTimeout(500);
      await expect(dropdown).not.toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('uncheck purchased item moves back to to-buy section', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-uncheck');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      // Seed one item already marked as purchased
      const [cartItemId] = await seedShoppingItems(client, userId, [
        { productId: productMap['Protein Powder'], qtyContainers: 1, purchased: true },
      ]);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 15000 });

      // Verify it starts in the purchased section
      await expect(page.getByTestId('purchased-list')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('purchased-section')).toContainText('Protein Powder');

      // To-buy section should be empty
      await expect(page.getByTestId('no-to-buy')).toBeVisible();

      // Click the checkbox on the purchased item to uncheck it
      await page.getByTestId(`check-${cartItemId}`).click();

      // Item should move back to the to-buy section
      await expect(page.getByTestId('to-buy-list')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('to-buy-section')).toContainText('Protein Powder');

      // Purchased section should now be empty
      await expect(page.getByTestId('no-purchased')).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('adding non-existent product name creates placeholder product', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-placeholder');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 15000 });

      // Type a completely unique product name that won't match any seeded product
      await page.getByTestId('add-item-name').locator('input').fill('E2E Nonexistent Widget');

      // Wait for debounce (300ms) — dropdown should not appear for a non-matching name
      await page.waitForTimeout(500);

      // Set quantity to 1
      await page.getByTestId('add-item-qty').locator('input').fill('1');

      // Click the Add button to add the item
      await page.getByTestId('add-item-btn').click();

      // Wait for the item to appear in the to-buy list
      await expect(page.getByTestId('to-buy-list')).toBeVisible({ timeout: 10000 });

      // Verify the to-buy section shows the new product name
      await expect(page.getByTestId('to-buy-section')).toContainText('E2E Nonexistent Widget');

      // Verify in DB that a placeholder product was created
      const chef = (client as any).schema('chefbyte');
      const { data: placeholderProducts } = await chef
        .from('products')
        .select('product_id, name, is_placeholder')
        .eq('user_id', userId)
        .eq('name', 'E2E Nonexistent Widget');
      expect(placeholderProducts).toBeTruthy();
      expect(placeholderProducts.length).toBe(1);
      expect(placeholderProducts[0].is_placeholder).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
