import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData } from '../helpers/seed';
import { expectDbRow } from '../helpers/assertions';

test.describe('ChefByte Inventory', () => {
  test('inventory page loads with seeded products', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-load');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 15000 });

      // All 5 product cards should be visible
      await expect(page.getByTestId(`inv-product-${productMap['Chicken Breast']}`)).toBeVisible();
      await expect(page.getByTestId(`inv-product-${productMap['Brown Rice']}`)).toBeVisible();
      await expect(page.getByTestId(`inv-product-${productMap['Eggs']}`)).toBeVisible();
      await expect(page.getByTestId(`inv-product-${productMap['Protein Powder']}`)).toBeVisible();
      await expect(page.getByTestId(`inv-product-${productMap['Bananas']}`)).toBeVisible();

      // Product names should be displayed within their cards
      await expect(page.getByTestId(`inv-product-${productMap['Chicken Breast']}`)).toContainText('Chicken Breast');
      await expect(page.getByTestId(`inv-product-${productMap['Brown Rice']}`)).toContainText('Brown Rice');
      await expect(page.getByTestId(`inv-product-${productMap['Eggs']}`)).toContainText('Eggs');
      await expect(page.getByTestId(`inv-product-${productMap['Protein Powder']}`)).toContainText('Protein Powder');
      await expect(page.getByTestId(`inv-product-${productMap['Bananas']}`)).toContainText('Bananas');
    } finally {
      await cleanup();
    }
  });

  test('stock badges show correct colors based on stock level', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-badges');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 15000 });

      // Chicken Breast: 3 ctn >= 2 min -> success
      await expect(page.getByTestId(`stock-badge-${productMap['Chicken Breast']}`)).toHaveAttribute('color', 'success');

      // Brown Rice: 2 ctn >= 1 min -> success
      await expect(page.getByTestId(`stock-badge-${productMap['Brown Rice']}`)).toHaveAttribute('color', 'success');

      // Eggs: 0.5 ctn < 1 min -> warning
      await expect(page.getByTestId(`stock-badge-${productMap['Eggs']}`)).toHaveAttribute('color', 'warning');

      // Protein Powder: 0.5 ctn >= 0.5 min -> success
      await expect(page.getByTestId(`stock-badge-${productMap['Protein Powder']}`)).toHaveAttribute('color', 'success');

      // Bananas: 0 ctn < 3 min -> danger
      await expect(page.getByTestId(`stock-badge-${productMap['Bananas']}`)).toHaveAttribute('color', 'danger');
    } finally {
      await cleanup();
    }
  });

  test('lots view shows stock lot table with location and expiry', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-lots');
    try {
      await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 15000 });

      // Switch to Lots view via the segment toggle
      await page.getByTestId('inventory-view-toggle').locator('ion-segment-button[value="lots"]').click();

      // Lots view should be visible
      await expect(page.getByTestId('lots-view')).toBeVisible();

      // Lots table should exist
      await expect(page.getByTestId('lots-table')).toBeVisible();

      // Location names should appear in the table
      const lotsTable = page.getByTestId('lots-table');
      await expect(lotsTable).toContainText('Fridge');
      await expect(lotsTable).toContainText('Pantry');
    } finally {
      await cleanup();
    }
  });

  test('consume all shows confirmation dialog', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-consume');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 15000 });

      // Click consume all for Chicken Breast (has stock = 3 ctn)
      await page.getByTestId(`consume-all-${productMap['Chicken Breast']}`).click();

      // Verify the confirmation alert dialog appears with the expected message
      await expect(
        page.getByText('Are you sure you want to consume all remaining stock for this product?'),
      ).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('search input filters product list', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-search');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 15000 });

      // Type "Chicken" into the search input
      const searchInput = page.getByTestId('inventory-search');
      await expect(searchInput).toBeVisible();
      await searchInput.locator('input').fill('Chicken');

      // Chicken Breast should remain visible
      await expect(page.getByTestId(`inv-product-${productMap['Chicken Breast']}`)).toBeVisible();

      // Other products should be hidden
      await expect(page.getByTestId(`inv-product-${productMap['Brown Rice']}`)).not.toBeVisible();
      await expect(page.getByTestId(`inv-product-${productMap['Eggs']}`)).not.toBeVisible();
      await expect(page.getByTestId(`inv-product-${productMap['Protein Powder']}`)).not.toBeVisible();
      await expect(page.getByTestId(`inv-product-${productMap['Bananas']}`)).not.toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('add stock modal opens and accepts qty + location', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-addstock');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 15000 });

      // Chicken Breast starts at 3.0 ctn
      const chickenBadge = page.getByTestId(`stock-badge-${productMap['Chicken Breast']}`);
      await expect(chickenBadge).toContainText('3.0');

      // Click the "+1 Ctn" button to open the add stock modal
      await page.getByTestId(`add-ctn-${productMap['Chicken Breast']}`).click();

      // Modal should open
      const modal = page.getByTestId('add-stock-modal');
      await expect(modal).toBeVisible({ timeout: 5000 });

      // Modal title should reference Chicken Breast
      await expect(modal).toContainText('Chicken Breast');

      // Quantity field should be pre-filled with 1
      const qtyInput = page.getByTestId('add-stock-qty');
      await expect(qtyInput).toBeVisible();

      // Confirm the add
      await page.getByTestId('add-stock-confirm').click();

      // Modal should close
      await expect(modal).not.toBeVisible({ timeout: 5000 });

      // Badge should update to 4.0 ctn
      await expect(chickenBadge).toContainText('4.0', { timeout: 10000 });
    } finally {
      await cleanup();
    }
  });

  test('consume partial stock reduces lot quantity', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-partial');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 15000 });

      // Chicken Breast starts at 3.0 ctn
      const chickenBadge = page.getByTestId(`stock-badge-${productMap['Chicken Breast']}`);
      await expect(chickenBadge).toContainText('3.0');

      // Click "-1 Ctn" to consume 1 container
      await page.getByTestId(`sub-ctn-${productMap['Chicken Breast']}`).click();

      // Badge should update to 2.0 ctn
      await expect(chickenBadge).toContainText('2.0', { timeout: 10000 });
    } finally {
      await cleanup();
    }
  });

  test('stock amount display shows correct containers text', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-stocktext');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 15000 });

      // Chicken Breast: 3.0 ctn
      await expect(page.getByTestId(`stock-badge-${productMap['Chicken Breast']}`)).toContainText('3.0 ctn');

      // Brown Rice: 2.0 ctn
      await expect(page.getByTestId(`stock-badge-${productMap['Brown Rice']}`)).toContainText('2.0 ctn');

      // Eggs: 0.5 ctn
      await expect(page.getByTestId(`stock-badge-${productMap['Eggs']}`)).toContainText('0.5 ctn');

      // Protein Powder: 0.5 ctn
      await expect(page.getByTestId(`stock-badge-${productMap['Protein Powder']}`)).toContainText('0.5 ctn');

      // Bananas: 0.0 ctn
      await expect(page.getByTestId(`stock-badge-${productMap['Bananas']}`)).toContainText('0.0 ctn');
    } finally {
      await cleanup();
    }
  });

  test('expiry date displayed for lots with expiration', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-expiry');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 15000 });

      // Switch to Lots view
      await page.getByTestId('inventory-view-toggle').locator('ion-segment-button[value="lots"]').click();
      await expect(page.getByTestId('lots-view')).toBeVisible();

      const lotsTable = page.getByTestId('lots-table');
      await expect(lotsTable).toBeVisible();

      // All seeded lots have expiry dates. The Expires column header should be present.
      await expect(lotsTable).toContainText('Expires');

      // Verify that the lots table contains actual date strings (YYYY-MM-DD format).
      // Each seeded lot has a futureDate — check at least one date pattern is present.
      const tableText = await lotsTable.textContent();
      const datePattern = /\d{4}-\d{2}-\d{2}/;
      expect(tableText).toMatch(datePattern);

      // Also verify the grouped view shows nearest expiry for Chicken Breast
      await page.getByTestId('inventory-view-toggle').locator('ion-segment-button[value="grouped"]').click();
      await expect(page.getByTestId('grouped-view')).toBeVisible();

      // Chicken Breast has expires_on = futureDate(5), displayed in expiry field
      const chickenExpiry = page.getByTestId(`expiry-${productMap['Chicken Breast']}`);
      const expiryText = await chickenExpiry.textContent();
      // Should be a date string, not the em-dash placeholder
      expect(expiryText).toMatch(/\d{4}-\d{2}-\d{2}/);
    } finally {
      await cleanup();
    }
  });

  test('color-coded stock badges show correct colors', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-colors');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 15000 });

      // Chicken Breast: 3 ctn >= 2 min_stock -> success (green)
      await expect(page.getByTestId(`stock-badge-${productMap['Chicken Breast']}`)).toHaveAttribute('color', 'success');

      // Eggs: 0.5 ctn < 1 min_stock -> warning (orange)
      await expect(page.getByTestId(`stock-badge-${productMap['Eggs']}`)).toHaveAttribute('color', 'warning');

      // Bananas: 0 ctn, min_stock=3 -> danger (red)
      await expect(page.getByTestId(`stock-badge-${productMap['Bananas']}`)).toHaveAttribute('color', 'danger');

      // Also verify the card border colors via style attributes
      // Browsers may serialize hex colors to rgb() format, so check for either form
      const chickenCard = page.getByTestId(`inv-product-${productMap['Chicken Breast']}`);
      const chickenStyle = await chickenCard.getAttribute('style');
      expect(chickenStyle).toMatch(/(?:#2dd36f|rgb\(45,\s*211,\s*111\))/); // green border

      const eggsCard = page.getByTestId(`inv-product-${productMap['Eggs']}`);
      const eggsStyle = await eggsCard.getAttribute('style');
      expect(eggsStyle).toMatch(/(?:#ffc409|rgb\(255,\s*196,\s*9\))/); // orange/warning border

      const bananasCard = page.getByTestId(`inv-product-${productMap['Bananas']}`);
      const bananasStyle = await bananasCard.getAttribute('style');
      expect(bananasStyle).toMatch(/(?:#eb445a|rgb\(235,\s*68,\s*90\))/); // red/danger border
    } finally {
      await cleanup();
    }
  });

  test('verify DB state after consume operation', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'inv-dbverify');
    try {
      const { productMap } = await seedChefByteData(client, userId);

      await page.goto('/chef/inventory');
      await expect(page.getByTestId('grouped-view')).toBeVisible({ timeout: 15000 });

      // Verify initial DB state: Chicken Breast lot has qty_containers = 3
      await expectDbRow(
        client,
        'chefbyte',
        'stock_lots',
        { user_id: userId, product_id: productMap['Chicken Breast'] },
        { qty_containers: 3 },
      );

      // Consume 1 container of Chicken Breast via the UI
      await page.getByTestId(`sub-ctn-${productMap['Chicken Breast']}`).click();

      // Wait for the badge to update (confirms the consume completed)
      const chickenBadge = page.getByTestId(`stock-badge-${productMap['Chicken Breast']}`);
      await expect(chickenBadge).toContainText('2.0', { timeout: 10000 });

      // Verify DB state: lot should now have qty_containers = 2
      await expectDbRow(
        client,
        'chefbyte',
        'stock_lots',
        { user_id: userId, product_id: productMap['Chicken Breast'] },
        { qty_containers: 2 },
      );

      // Also verify a food_logs entry was created for the consumed amount
      const chef = (client as any).schema('chefbyte');
      const { data: foodLogs, error: foodErr } = await chef
        .from('food_logs')
        .select('*')
        .eq('user_id', userId)
        .eq('product_id', productMap['Chicken Breast']);
      expect(foodErr).toBeNull();
      expect(foodLogs).not.toBeNull();
      expect(foodLogs!.length).toBeGreaterThan(0);

      // The food log should reflect 1 container consumed (4 servings at 165 cal each = 660 cal)
      const logEntry = foodLogs![0];
      expect(Number(logEntry.calories)).toBeCloseTo(660, 0);
      expect(Number(logEntry.protein)).toBeCloseTo(124, 0);
    } finally {
      await cleanup();
    }
  });
});
