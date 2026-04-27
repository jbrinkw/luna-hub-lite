import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData, seedShoppingItems } from '../helpers/seed';

test.describe('ChefByte Shopping', () => {
  test('shopping page loads with add form and empty lists', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-load');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/shopping');

      // Add item form should be visible
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 30000 });

      // To Buy section visible with empty state
      await expect(page.getByTestId('to-buy-section')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('no-to-buy')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('no-to-buy')).toContainText('No items to buy', { timeout: 30000 });

      // Purchased section visible with empty state
      await expect(page.getByTestId('purchased-section')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('no-purchased')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('no-purchased')).toContainText('No purchased items', { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('auto-add button populates items below min stock', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-auto');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 30000 });

      // Initially the to-buy list should be empty
      await expect(page.getByTestId('no-to-buy')).toBeVisible({ timeout: 30000 });

      // Click the auto-add button
      await page.getByTestId('auto-add-btn').click();

      // To-buy list should now appear with items below min stock
      // Eggs: 0.5 stock < 1 min -> needs 1 container (ceil(1 - 0.5) = 1)
      // Bananas: 0 stock < 3 min -> needs 3 containers (ceil(3 - 0) = 3)
      await expect(page.getByTestId('to-buy-list')).toBeVisible({ timeout: 30000 });

      const toBuySection = page.getByTestId('to-buy-section');
      await expect(toBuySection).toContainText('Great Value Large White Eggs', { timeout: 30000 });
      await expect(toBuySection).toContainText('Banquet Chicken Breast Patties', { timeout: 30000 });

      // Empty state should be gone now
      await expect(page.getByTestId('no-to-buy')).not.toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('can add a manual item to shopping list', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-manual');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 30000 });

      // Type a product name into the item name input
      await page.getByTestId('add-item-name').fill('Great Value');

      // Wait for dropdown to appear with matching product
      await expect(page.getByTestId('product-dropdown')).toBeVisible({ timeout: 30000 });

      // Click the first matching dropdown item (Chicken Breast)
      const dropdownItems = page.getByTestId('product-dropdown').locator('[data-testid^="dropdown-item-"]');
      await expect(dropdownItems.first()).toBeVisible({ timeout: 30000 });
      await dropdownItems.first().click();

      // Set quantity to 2
      await page.getByTestId('add-item-qty').fill('2');

      // Click the Add button
      await page.getByTestId('add-item-btn').click();

      // Verify the item appears in the to-buy list
      await expect(page.getByTestId('to-buy-list')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('to-buy-section')).toContainText('Great Value Boneless Skinless Chicken Breasts', {
        timeout: 30000,
      });
    } finally {
      await cleanup();
    }
  });

  test('checking an item moves it to purchased section', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-check');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 30000 });

      // Add items via auto-add so we have items to work with
      await page.getByTestId('auto-add-btn').click();
      await expect(page.getByTestId('to-buy-list')).toBeVisible({ timeout: 30000 });

      // Find the first item in the to-buy list and get its name for later verification
      const firstItem = page.getByTestId('to-buy-list').locator('[data-testid^="item-"]').first();
      await expect(firstItem).toBeVisible({ timeout: 30000 });
      const itemName = await firstItem.locator('span').first().innerText();

      // Click the checkbox on the first item to mark it as purchased
      const firstCheckbox = page.getByTestId('to-buy-list').locator('[data-testid^="check-"]').first();
      await firstCheckbox.click();

      // Wait for the purchased list to appear with the checked item
      await expect(page.getByTestId('purchased-list')).toBeVisible({ timeout: 30000 });

      // The purchased section should contain the item name
      await expect(page.getByTestId('purchased-section')).toContainText(itemName, { timeout: 30000 });

      // The empty purchased state should be gone
      await expect(page.getByTestId('no-purchased')).not.toBeVisible({ timeout: 30000 });
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
        { productId: productMap['Great Value Boneless Skinless Chicken Breasts'], qtyContainers: 2 },
        { productId: productMap['Great Value Long Grain Brown Rice'], qtyContainers: 1 },
      ]);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 30000 });

      // Verify items are in the to-buy list
      await expect(page.getByTestId('to-buy-list')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('to-buy-section')).toContainText('Great Value Boneless Skinless Chicken Breasts', {
        timeout: 30000,
      });

      // Click clear all button (triggers ConfirmModal)
      await page.getByTestId('clear-all-btn').click();
      const modal = page.getByRole('dialog');
      await expect(modal).toBeVisible({ timeout: 5000 });
      await modal.getByRole('button', { name: 'Clear All' }).click();

      // Both sections should now show empty states
      await expect(page.getByTestId('no-to-buy')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('no-purchased')).toBeVisible({ timeout: 30000 });
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
        { productId: productMap['Great Value Large White Eggs'], qtyContainers: 1 },
      ]);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 30000 });

      // Verify the item is visible in to-buy list
      await expect(page.getByTestId('to-buy-list')).toBeVisible({ timeout: 30000 });
      const itemRow = page.getByTestId(`item-${cartItemId}`);
      await expect(itemRow).toBeVisible({ timeout: 30000 });
      await expect(itemRow).toContainText('Great Value Large White Eggs', { timeout: 30000 });

      // Click the remove button for this specific item
      await page.getByTestId(`remove-${cartItemId}`).click();

      // Item should be removed; to-buy list should show empty state
      await expect(itemRow).not.toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('no-to-buy')).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('product dropdown search shows matching products', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-dropdown');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 30000 });

      // Type "Great" in the add-item search field
      const searchInput = page.getByTestId('add-item-name');
      await searchInput.fill('Great');

      // Wait for the product dropdown to appear (300ms debounce + query)
      const dropdown = page.getByTestId('product-dropdown');
      await expect(dropdown).toBeVisible({ timeout: 30000 });

      // Dropdown should contain "Chicken Breast" as a matching product
      await expect(dropdown).toContainText('Great Value Boneless Skinless Chicken Breasts', { timeout: 30000 });

      // Dropdown items should have data-testid prefix
      const dropdownItems = dropdown.locator('[data-testid^="dropdown-item-"]');
      const count = await dropdownItems.count();
      expect(count).toBeGreaterThan(0);

      // Click the Chicken Breast item — search field should be populated and dropdown should close
      await dropdownItems.first().click();
      await expect(dropdown).not.toBeVisible({ timeout: 3000 });
      await expect(searchInput).toHaveValue('Great Value Boneless Skinless Chicken Breasts', { timeout: 30000 });

      // Clear and type something with no matches
      await searchInput.fill('');
      await searchInput.fill('ZZZNOMATCH');

      // Dropdown should not appear for non-matching search
      // Wait a bit for debounce to fire
      await page.waitForTimeout(2000);
      await expect(dropdown).not.toBeVisible({ timeout: 30000 });
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
        { productId: productMap['Birds Eye Sweet Peas'], qtyContainers: 1, purchased: true },
      ]);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 30000 });

      // Verify it starts in the purchased section
      await expect(page.getByTestId('purchased-list')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('purchased-section')).toContainText('Birds Eye Sweet Peas', { timeout: 30000 });

      // To-buy section should be empty
      await expect(page.getByTestId('no-to-buy')).toBeVisible({ timeout: 30000 });

      // Click the checkbox on the purchased item to uncheck it
      await page.getByTestId(`check-${cartItemId}`).click();

      // Item should move back to the to-buy section
      await expect(page.getByTestId('to-buy-list')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('to-buy-section')).toContainText('Birds Eye Sweet Peas', { timeout: 30000 });

      // Purchased section should now be empty
      await expect(page.getByTestId('no-purchased')).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------
  // Feature X: Import to Inventory auto-clears the cart
  // -------------------------------------------------------------------
  test('import to inventory clears purchased section and surfaces via toggle', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-import-clear');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      // Seed two already-purchased items so Import to Inventory is active
      await seedShoppingItems(client, userId, [
        { productId: productMap['Great Value Boneless Skinless Chicken Breasts'], qtyContainers: 2, purchased: true },
        { productId: productMap['Great Value Long Grain Brown Rice'], qtyContainers: 1, purchased: true },
      ]);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 30000 });

      // Both items should be in the Purchased section before import
      await expect(page.getByTestId('purchased-list')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('purchased-section')).toContainText(
        'Great Value Boneless Skinless Chicken Breasts',
        { timeout: 30000 },
      );

      // Click Import to Inventory
      await page.getByTestId('import-inventory-btn').click();

      // Purchased section should now be empty
      await expect(page.getByTestId('no-purchased')).toBeVisible({ timeout: 30000 });

      // DB: shopping_list rows should have imported_at set
      await expect(async () => {
        const chef = (client as any).schema('chefbyte');
        const { data: rows } = await chef.from('shopping_list').select('imported_at, purchased').eq('user_id', userId);
        expect(rows).toBeTruthy();
        expect(rows.length).toBe(2);
        for (const r of rows!) {
          expect(r.imported_at).not.toBeNull();
        }
      }).toPass({ timeout: 30000 });

      // DB: two stock_lots exist matching the imported qty
      await expect(async () => {
        const chef = (client as any).schema('chefbyte');
        const { data: lots } = await chef.from('stock_lots').select('product_id, qty_containers').eq('user_id', userId);
        // Two seeded during seedChefByteData already + 2 imported
        const imported = (lots ?? []).filter(
          (l: any) =>
            (l.product_id === productMap['Great Value Boneless Skinless Chicken Breasts'] &&
              Number(l.qty_containers) === 2) ||
            (l.product_id === productMap['Great Value Long Grain Brown Rice'] && Number(l.qty_containers) === 1),
        );
        expect(imported.length).toBeGreaterThanOrEqual(1);
      }).toPass({ timeout: 30000 });

      // Toggle "Show imported" — the imported section reveals the two items
      await page.getByTestId('show-imported-toggle').check();
      await expect(page.getByTestId('imported-section')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('imported-list')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('imported-section')).toContainText(
        'Great Value Boneless Skinless Chicken Breasts',
        { timeout: 30000 },
      );
      await expect(page.getByTestId('imported-section')).toContainText('Great Value Long Grain Brown Rice', {
        timeout: 30000,
      });
    } finally {
      await cleanup();
    }
  });

  test('second import after all items imported is a no-op (no duplicate lots)', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-import-idempotent');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await seedShoppingItems(client, userId, [
        { productId: productMap['Banquet Chicken Breast Patties'], qtyContainers: 1, purchased: true },
      ]);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 30000 });

      await page.getByTestId('import-inventory-btn').click();
      await expect(page.getByTestId('no-purchased')).toBeVisible({ timeout: 30000 });

      // Count stock_lots after first import
      const chef = (client as any).schema('chefbyte');
      const { data: afterFirst } = await chef
        .from('stock_lots')
        .select('lot_id')
        .eq('user_id', userId)
        .eq('product_id', productMap['Banquet Chicken Breast Patties']);
      const firstCount = (afterFirst ?? []).length;

      // The button is no longer visible because purchased.length === 0.
      // Instead, exercise the RPC directly via client to simulate a duplicate
      // call path — confirms the server side is idempotent.
      const { data: secondResult } = await (chef as any).rpc('import_shopping_to_inventory', { p_location_id: null });
      expect(secondResult.lots_processed).toBe(0);

      const { data: afterSecond } = await chef
        .from('stock_lots')
        .select('lot_id')
        .eq('user_id', userId)
        .eq('product_id', productMap['Banquet Chicken Breast Patties']);
      expect((afterSecond ?? []).length).toBe(firstCount);
    } finally {
      await cleanup();
    }
  });

  test('adding non-existent product name creates placeholder product', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'shop-placeholder');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/shopping');
      await expect(page.getByTestId('add-item-form')).toBeVisible({ timeout: 30000 });

      // Type a completely unique product name that won't match any seeded product
      await page.getByTestId('add-item-name').fill('E2E Nonexistent Widget');

      // Wait for debounce (300ms) — dropdown should not appear for a non-matching name
      await page.waitForTimeout(2000);

      // Set quantity to 1
      await page.getByTestId('add-item-qty').fill('1');

      // Click the Add button to add the item
      await page.getByTestId('add-item-btn').click();

      // Wait for the item to appear in the to-buy list
      await expect(page.getByTestId('to-buy-list')).toBeVisible({ timeout: 30000 });

      // Verify the to-buy section shows the new product name
      await expect(page.getByTestId('to-buy-section')).toContainText('E2E Nonexistent Widget', { timeout: 30000 });

      // Verify in DB that a placeholder product was created
      await expect(async () => {
        const chef = (client as any).schema('chefbyte');
        const { data: placeholderProducts } = await chef
          .from('products')
          .select('product_id, name, is_placeholder')
          .eq('user_id', userId)
          .eq('name', 'E2E Nonexistent Widget');
        expect(placeholderProducts).toBeTruthy();
        expect(placeholderProducts.length).toBe(1);
        expect(placeholderProducts[0].is_placeholder).toBe(true);
      }).toPass({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });
});
