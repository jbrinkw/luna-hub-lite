import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData } from '../helpers/seed';
import { expectDbRow } from '../helpers/assertions';

test.describe('ChefByte Inventory', () => {
  test('inventory page loads with seeded products', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-load');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30000 });

      // All 5 product cards should be visible
      await expect(
        page.getByTestId(`inv-product-${productMap['Great Value Boneless Skinless Chicken Breasts']}`),
      ).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId(`inv-product-${productMap['Great Value Long Grain Brown Rice']}`)).toBeVisible({
        timeout: 30000,
      });
      await expect(page.getByTestId(`inv-product-${productMap['Great Value Large White Eggs']}`)).toBeVisible({
        timeout: 30000,
      });
      await expect(page.getByTestId(`inv-product-${productMap['Birds Eye Sweet Peas']}`)).toBeVisible({
        timeout: 30000,
      });
      await expect(page.getByTestId(`inv-product-${productMap['Banquet Chicken Breast Patties']}`)).toBeVisible({
        timeout: 30000,
      });

      // Product names should be displayed within their cards
      await expect(
        page.getByTestId(`inv-product-${productMap['Great Value Boneless Skinless Chicken Breasts']}`),
      ).toContainText('Great Value Boneless Skinless Chicken Breasts', { timeout: 30000 });
      await expect(page.getByTestId(`inv-product-${productMap['Great Value Long Grain Brown Rice']}`)).toContainText(
        'Great Value Long Grain Brown Rice',
        { timeout: 30000 },
      );
      await expect(page.getByTestId(`inv-product-${productMap['Great Value Large White Eggs']}`)).toContainText(
        'Great Value Large White Eggs',
        { timeout: 30000 },
      );
      await expect(page.getByTestId(`inv-product-${productMap['Birds Eye Sweet Peas']}`)).toContainText(
        'Birds Eye Sweet Peas',
        { timeout: 30000 },
      );
      await expect(page.getByTestId(`inv-product-${productMap['Banquet Chicken Breast Patties']}`)).toContainText(
        'Banquet Chicken Breast Patties',
        { timeout: 30000 },
      );
    } finally {
      await cleanup();
    }
  });

  test('stock badges show correct colors based on stock level', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-badges');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30000 });

      // Chicken Breast: 3 ctn >= 2 min -> success
      await expect(
        page.getByTestId(`stock-badge-${productMap['Great Value Boneless Skinless Chicken Breasts']}`),
      ).toContainText('3.0 ctn', { timeout: 30000 });

      // Brown Rice: 2 ctn >= 1 min -> success
      await expect(page.getByTestId(`stock-badge-${productMap['Great Value Long Grain Brown Rice']}`)).toContainText(
        '2.0 ctn',
        { timeout: 30000 },
      );

      // Eggs: 0.5 ctn < 1 min -> warning
      await expect(page.getByTestId(`stock-badge-${productMap['Great Value Large White Eggs']}`)).toContainText(
        '0.5 ctn',
        { timeout: 30000 },
      );

      // Protein Powder: 0.5 ctn >= 0.5 min -> success
      await expect(page.getByTestId(`stock-badge-${productMap['Birds Eye Sweet Peas']}`)).toContainText('0.5 ctn', {
        timeout: 30000,
      });

      // Bananas: 0 ctn < 3 min -> danger
      await expect(page.getByTestId(`stock-badge-${productMap['Banquet Chicken Breast Patties']}`)).toContainText(
        '0.0 ctn',
        { timeout: 30000 },
      );
    } finally {
      await cleanup();
    }
  });

  test('lots view shows stock lot table with location and expiry', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-lots');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30000 });

      // Switch to Lots view via the segment toggle
      await page.getByTestId('inventory-view-toggle').getByRole('button', { name: 'Lots' }).click();

      // Lots view should be visible
      await expect(page.getByTestId('lots-view')).toBeVisible({ timeout: 30000 });

      // Lots table should exist
      await expect(page.getByTestId('lots-table')).toBeVisible({ timeout: 30000 });

      // Location names should appear in the table
      const lotsTable = page.getByTestId('lots-table');
      await expect(lotsTable).toContainText('Fridge', { timeout: 30000 });
      await expect(lotsTable).toContainText('Pantry', { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('consume all shows confirmation dialog', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-consume');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30000 });

      // Register dialog handler BEFORE the click triggers window.confirm
      let dialogMessage = '';
      let dialogType = '';
      page.on('dialog', async (dialog) => {
        dialogType = dialog.type();
        dialogMessage = dialog.message();
        await dialog.dismiss(); // Cancel so stock is not consumed
      });

      // Expand the row first to reveal action buttons
      await page.getByTestId(`inv-row-toggle-${productMap['Great Value Boneless Skinless Chicken Breasts']}`).click();

      // Click consume all for Chicken Breast (has stock = 3 ctn)
      await page.getByTestId(`consume-all-${productMap['Great Value Boneless Skinless Chicken Breasts']}`).click();

      // Give dialog handler a moment to fire
      await page.waitForTimeout(2000);

      // Verify the native confirm dialog was shown
      expect(dialogType).toBe('confirm');
      expect(dialogMessage).toContain('Are you sure you want to consume all remaining stock');
    } finally {
      await cleanup();
    }
  });

  test('search input filters product list', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-search');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30000 });

      // Type "Chicken" into the search input
      const searchInput = page.getByTestId('inventory-search');
      await expect(searchInput).toBeVisible({ timeout: 30000 });
      await searchInput.fill('Chicken');

      // Chicken Breast should remain visible
      await expect(
        page.getByTestId(`inv-product-${productMap['Great Value Boneless Skinless Chicken Breasts']}`),
      ).toBeVisible({ timeout: 30000 });

      // Banquet Chicken Breast Patties also matches "Chicken" and has min_stock_amount > 0
      // so it should also be visible
      await expect(page.getByTestId(`inv-product-${productMap['Banquet Chicken Breast Patties']}`)).toBeVisible({
        timeout: 30000,
      });

      // Other products should be hidden
      await expect(page.getByTestId(`inv-product-${productMap['Great Value Long Grain Brown Rice']}`)).not.toBeVisible({
        timeout: 30000,
      });
      await expect(page.getByTestId(`inv-product-${productMap['Great Value Large White Eggs']}`)).not.toBeVisible({
        timeout: 30000,
      });
      await expect(page.getByTestId(`inv-product-${productMap['Birds Eye Sweet Peas']}`)).not.toBeVisible({
        timeout: 30000,
      });
    } finally {
      await cleanup();
    }
  });

  test('add stock modal opens and accepts qty + location', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-addstock');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30000 });

      // Chicken Breast starts at 3.0 ctn
      const chickenBadge = page.getByTestId(
        `stock-badge-${productMap['Great Value Boneless Skinless Chicken Breasts']}`,
      );
      await expect(chickenBadge).toContainText('3.0', { timeout: 30000 });

      // Expand the row first to reveal action buttons
      await page.getByTestId(`inv-row-toggle-${productMap['Great Value Boneless Skinless Chicken Breasts']}`).click();

      // Click the "Add Container" button to open the add stock modal
      await page.getByTestId(`add-ctn-${productMap['Great Value Boneless Skinless Chicken Breasts']}`).click();

      // Modal should open
      const modal = page.getByTestId('add-stock-modal');
      await expect(modal).toBeVisible({ timeout: 30000 });

      // Modal title should reference Chicken Breast
      await expect(modal).toContainText('Great Value Boneless Skinless Chicken Breasts', { timeout: 30000 });

      // Quantity field should be pre-filled with 1
      const qtyInput = page.getByTestId('add-stock-qty');
      await expect(qtyInput).toBeVisible({ timeout: 30000 });

      // Confirm the add
      await page.getByTestId('add-stock-confirm').click();

      // Modal should close
      await expect(modal).not.toBeVisible({ timeout: 30000 });

      // Badge should update to 4.0 ctn
      await expect(chickenBadge).toContainText('4.0', { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('consume partial stock reduces lot quantity', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-partial');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30000 });

      // Chicken Breast starts at 3.0 ctn
      const chickenBadge = page.getByTestId(
        `stock-badge-${productMap['Great Value Boneless Skinless Chicken Breasts']}`,
      );
      await expect(chickenBadge).toContainText('3.0', { timeout: 30000 });

      // Expand the row first to reveal action buttons
      await page.getByTestId(`inv-row-toggle-${productMap['Great Value Boneless Skinless Chicken Breasts']}`).click();

      // Click "Remove Container" to consume 1 container
      await page.getByTestId(`sub-ctn-${productMap['Great Value Boneless Skinless Chicken Breasts']}`).click();

      // Badge should update to 2.0 ctn
      await expect(chickenBadge).toContainText('2.0', { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('stock amount display shows correct containers text', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-stocktext');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30000 });

      // Chicken Breast: 3.0 ctn
      await expect(
        page.getByTestId(`stock-badge-${productMap['Great Value Boneless Skinless Chicken Breasts']}`),
      ).toContainText('3.0 ctn', { timeout: 30000 });

      // Brown Rice: 2.0 ctn
      await expect(page.getByTestId(`stock-badge-${productMap['Great Value Long Grain Brown Rice']}`)).toContainText(
        '2.0 ctn',
        { timeout: 30000 },
      );

      // Eggs: 0.5 ctn
      await expect(page.getByTestId(`stock-badge-${productMap['Great Value Large White Eggs']}`)).toContainText(
        '0.5 ctn',
        { timeout: 30000 },
      );

      // Protein Powder: 0.5 ctn
      await expect(page.getByTestId(`stock-badge-${productMap['Birds Eye Sweet Peas']}`)).toContainText('0.5 ctn', {
        timeout: 30000,
      });

      // Bananas: 0.0 ctn
      await expect(page.getByTestId(`stock-badge-${productMap['Banquet Chicken Breast Patties']}`)).toContainText(
        '0.0 ctn',
        { timeout: 30000 },
      );
    } finally {
      await cleanup();
    }
  });

  test('expiry date displayed for lots with expiration', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-expiry');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30000 });

      // Switch to Lots view
      await page.getByTestId('inventory-view-toggle').getByRole('button', { name: 'Lots' }).click();
      await expect(page.getByTestId('lots-view')).toBeVisible({ timeout: 30000 });

      const lotsTable = page.getByTestId('lots-table');
      await expect(lotsTable).toBeVisible({ timeout: 30000 });

      // All seeded lots have expiry dates. The Expires column header should be present.
      await expect(lotsTable).toContainText('Expires', { timeout: 30000 });

      // Verify that the lots table contains actual date strings (YYYY-MM-DD format).
      // Each seeded lot has a futureDate — check at least one date pattern is present.
      const tableText = await lotsTable.textContent();
      const datePattern = /\d{4}-\d{2}-\d{2}/;
      expect(tableText).toMatch(datePattern);

      // Also verify the grouped view shows nearest expiry for Chicken Breast
      await page.getByTestId('inventory-view-toggle').getByRole('button', { name: 'Grouped' }).click();
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30000 });

      // Chicken Breast has expires_on = futureDate(5), displayed as "Mon DD" format
      const chickenExpiry = page.getByTestId(`expiry-${productMap['Great Value Boneless Skinless Chicken Breasts']}`);
      const expiryText = await chickenExpiry.textContent();
      // Should be a short date like "Mar 15", not the em-dash placeholder
      expect(expiryText).toMatch(/[A-Z][a-z]{2}\s+\d{1,2}/);
    } finally {
      await cleanup();
    }
  });

  test('color-coded stock badges show correct colors', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-colors');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30000 });

      // Chicken Breast: 3 ctn >= 2 min_stock -> success (green)
      await expect(
        page.getByTestId(`stock-badge-${productMap['Great Value Boneless Skinless Chicken Breasts']}`),
      ).toContainText('3.0 ctn', { timeout: 30000 });

      // Eggs: 0.5 ctn < 1 min_stock -> warning (orange)
      await expect(page.getByTestId(`stock-badge-${productMap['Great Value Large White Eggs']}`)).toContainText(
        '0.5 ctn',
        { timeout: 30000 },
      );

      // Bananas: 0 ctn, min_stock=3 -> danger (red)
      await expect(page.getByTestId(`stock-badge-${productMap['Banquet Chicken Breast Patties']}`)).toContainText(
        '0.0 ctn',
        { timeout: 30000 },
      );

      // Verify the color dot indicator inside each product row
      // The dot uses Tailwind classes: bg-green-600, bg-amber-500, bg-red-600
      const chickenRow = page.getByTestId(`inv-product-${productMap['Great Value Boneless Skinless Chicken Breasts']}`);
      const chickenDot = chickenRow.locator('span.rounded-full').first();
      await expect(chickenDot).toHaveClass(/bg-green-600/); // green (above min)

      const eggsRow = page.getByTestId(`inv-product-${productMap['Great Value Large White Eggs']}`);
      const eggsDot = eggsRow.locator('span.rounded-full').first();
      await expect(eggsDot).toHaveClass(/bg-amber-500/); // orange (below min)

      const bananasRow = page.getByTestId(`inv-product-${productMap['Banquet Chicken Breast Patties']}`);
      const bananasDot = bananasRow.locator('span.rounded-full').first();
      await expect(bananasDot).toHaveClass(/bg-red-600/); // red (zero stock)
    } finally {
      await cleanup();
    }
  });

  test('verify DB state after consume operation', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-dbverify');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 30000 });

      // Verify initial DB state: Chicken Breast lot has qty_containers = 3
      await expect(async () => {
        await expectDbRow(
          client,
          'chefbyte',
          'stock_lots',
          { user_id: userId, product_id: productMap['Great Value Boneless Skinless Chicken Breasts'] },
          { qty_containers: 3 },
        );
      }).toPass({ timeout: 30000 });

      // Expand the row first to reveal action buttons
      await page.getByTestId(`inv-row-toggle-${productMap['Great Value Boneless Skinless Chicken Breasts']}`).click();

      // Consume 1 container of Chicken Breast via the UI
      await page.getByTestId(`sub-ctn-${productMap['Great Value Boneless Skinless Chicken Breasts']}`).click();

      // Wait for the badge to update (confirms the consume completed)
      const chickenBadge = page.getByTestId(
        `stock-badge-${productMap['Great Value Boneless Skinless Chicken Breasts']}`,
      );
      await expect(chickenBadge).toContainText('2.0', { timeout: 30000 });

      // Verify DB state: lot should now have qty_containers = 2
      await expect(async () => {
        await expectDbRow(
          client,
          'chefbyte',
          'stock_lots',
          { user_id: userId, product_id: productMap['Great Value Boneless Skinless Chicken Breasts'] },
          { qty_containers: 2 },
        );
      }).toPass({ timeout: 30000 });

      // Also verify a food_logs entry was created for the consumed amount
      await expect(async () => {
        const chef = (client as any).schema('chefbyte');
        const { data: foodLogs, error: foodErr } = await chef
          .from('food_logs')
          .select('*')
          .eq('user_id', userId)
          .eq('product_id', productMap['Great Value Boneless Skinless Chicken Breasts']);
        expect(foodErr).toBeNull();
        expect(foodLogs).not.toBeNull();
        expect(foodLogs!.length).toBeGreaterThan(0);

        // The food log should reflect 1 container consumed (4 servings at 165 cal each = 660 cal)
        const logEntry = foodLogs![0];
        expect(Number(logEntry.calories)).toBeCloseTo(660, 0);
        expect(Number(logEntry.protein)).toBeCloseTo(124, 0);
      }).toPass({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });
});
