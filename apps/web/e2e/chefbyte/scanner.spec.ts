import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData } from '../helpers/seed';
import { expectDbRow, countDbRows } from '../helpers/assertions';

test.describe('ChefByte Scanner', () => {
  test('scanner page loads with correct layout', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-layout');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/scanner');
      await expect(page.getByTestId('scanner-container')).toBeVisible({ timeout: 15000 });

      await expect(page.getByTestId('queue-panel')).toBeVisible();
      await expect(page.getByTestId('keypad-panel')).toBeVisible();
      await expect(page.getByTestId('barcode-input')).toBeVisible();
      await expect(page.getByTestId('mode-selector')).toBeVisible();
      await expect(page.getByTestId('keypad-grid')).toBeVisible();
      await expect(page.getByTestId('queue-empty')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('mode selector defaults to purchase and can switch modes', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-modes');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/scanner');
      await expect(page.getByTestId('mode-selector')).toBeVisible({ timeout: 15000 });

      // Purchase mode is default — nutrition editor should be visible
      await expect(page.getByTestId('mode-purchase')).toBeVisible();
      await expect(page.getByTestId('nutrition-editor')).toBeVisible();

      // Switch to consume_macros
      await page.getByTestId('mode-consume_macros').click();
      await expect(page.getByTestId('nutrition-editor')).not.toBeVisible();

      // Switch back to purchase
      await page.getByTestId('mode-purchase').click();
      await expect(page.getByTestId('nutrition-editor')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('keypad updates screen value', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-keypad');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/scanner');
      await expect(page.getByTestId('keypad-grid')).toBeVisible({ timeout: 15000 });

      // Initial screen value is "1"
      await expect(page.getByTestId('screen-value')).toHaveText('1');

      // Click key-3 → overwrites to "3" (overwriteNext is true initially)
      await page.getByTestId('key-3').click();
      await expect(page.getByTestId('screen-value')).toHaveText('3');

      // Click key-5 → appends to "35"
      await page.getByTestId('key-5').click();
      await expect(page.getByTestId('screen-value')).toHaveText('35');

      // Click key-backspace → "3"
      await page.getByTestId('key-backspace').click();
      await expect(page.getByTestId('screen-value')).toHaveText('3');

      // Click key-. → "3."
      await page.getByTestId('key-.').click();
      await expect(page.getByTestId('screen-value')).toHaveText('3.');

      // Click key-7 → "3.7"
      await page.getByTestId('key-7').click();
      await expect(page.getByTestId('screen-value')).toHaveText('3.7');
    } finally {
      await cleanup();
    }
  });

  test('unit toggle visible in consume modes, hidden in purchase', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-unit');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/scanner');
      await expect(page.getByTestId('mode-selector')).toBeVisible({ timeout: 15000 });

      // Purchase mode: unit-toggle NOT visible
      await expect(page.getByTestId('unit-toggle')).not.toBeVisible();

      // Switch to consume_macros → unit-toggle visible showing "Serving"
      await page.getByTestId('mode-consume_macros').click();
      await expect(page.getByTestId('unit-toggle')).toBeVisible();
      await expect(page.getByTestId('unit-toggle')).toContainText('Serving');

      // Click it → shows "Container"
      await page.getByTestId('unit-toggle').click();
      await expect(page.getByTestId('unit-toggle')).toContainText('Container');
    } finally {
      await cleanup();
    }
  });

  test('nutrition editor visible only in purchase mode', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-nutedit');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/scanner');
      await expect(page.getByTestId('mode-selector')).toBeVisible({ timeout: 15000 });

      // Purchase mode: visible
      await expect(page.getByTestId('nutrition-editor')).toBeVisible();

      // consume_macros: hidden
      await page.getByTestId('mode-consume_macros').click();
      await expect(page.getByTestId('nutrition-editor')).not.toBeVisible();

      // shopping: hidden
      await page.getByTestId('mode-shopping').click();
      await expect(page.getByTestId('nutrition-editor')).not.toBeVisible();

      // Back to purchase: visible again
      await page.getByTestId('mode-purchase').click();
      await expect(page.getByTestId('nutrition-editor')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('scanning known barcode in purchase mode adds to queue', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-known');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chickenId = productMap['Chicken Breast'];

      // Add barcode to Chicken Breast product
      const chef = (client as any).schema('chefbyte');
      await chef.from('products').update({ barcode: '049000042566' }).eq('product_id', chickenId);

      await page.goto('/chef/scanner');
      await expect(page.getByTestId('barcode-input')).toBeVisible({ timeout: 15000 });

      // Scan the barcode
      await page.getByTestId('barcode-input').fill('049000042566');
      await page.getByTestId('barcode-input').press('Enter');

      // Wait for queue item to appear with product name (processing complete)
      const queueList = page.getByTestId('queue-list');
      await expect(queueList).toContainText('Chicken Breast', { timeout: 15000 });

      // Active item display should show "Chicken Breast"
      await expect(page.getByTestId('active-item-display')).toContainText('Chicken Breast');
    } finally {
      await cleanup();
    }
  });

  test('scanning unknown barcode creates placeholder with NEW badge', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-unknown');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/scanner');
      await expect(page.getByTestId('barcode-input')).toBeVisible({ timeout: 15000 });

      // Scan a random unknown barcode
      await page.getByTestId('barcode-input').fill('9999999999999');
      await page.getByTestId('barcode-input').press('Enter');

      // Wait for queue item to process — the edge function will fail in test env,
      // so it falls back to creating a placeholder product named "Unknown (barcode)"
      const queueList = page.getByTestId('queue-list');
      await expect(queueList).toContainText('Unknown (9999999999999)', { timeout: 15000 });

      // The [!NEW] badge should be visible
      await expect(queueList).toContainText('[!NEW]');
    } finally {
      await cleanup();
    }
  });

  test('scanning barcode in consume_macros mode processes successfully', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-consume');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chickenId = productMap['Chicken Breast'];

      // Add barcode to Chicken Breast product
      const chef = (client as any).schema('chefbyte');
      await chef.from('products').update({ barcode: '049000042566' }).eq('product_id', chickenId);

      await page.goto('/chef/scanner');
      await expect(page.getByTestId('mode-selector')).toBeVisible({ timeout: 15000 });

      // Switch to consume_macros mode
      await page.getByTestId('mode-consume_macros').click();

      // Unit toggle should now be visible
      await expect(page.getByTestId('unit-toggle')).toBeVisible();

      // Scan known barcode (default screen value is "1", unit is "servings")
      await page.getByTestId('barcode-input').fill('049000042566');
      await page.getByTestId('barcode-input').press('Enter');

      // Wait for queue item to finish processing (shows product name)
      const queueList = page.getByTestId('queue-list');
      await expect(queueList).toContainText('Chicken Breast', { timeout: 15000 });

      // Active item display should show the product
      await expect(page.getByTestId('active-item-display')).toContainText('Chicken Breast');

      // Screen value should reset to "1" after scan
      await expect(page.getByTestId('screen-value')).toHaveText('1');
    } finally {
      await cleanup();
    }
  });

  test('scanning barcode in shopping mode adds to shopping list', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-shop');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chickenId = productMap['Chicken Breast'];

      // Add barcode to Chicken Breast product
      const chef = (client as any).schema('chefbyte');
      await chef.from('products').update({ barcode: '049000042566' }).eq('product_id', chickenId);

      await page.goto('/chef/scanner');
      await expect(page.getByTestId('mode-selector')).toBeVisible({ timeout: 15000 });

      // Switch to shopping mode
      await page.getByTestId('mode-shopping').click();

      // Scan known barcode
      await page.getByTestId('barcode-input').fill('049000042566');
      await page.getByTestId('barcode-input').press('Enter');

      // Wait for queue item to finish processing
      const queueList = page.getByTestId('queue-list');
      await expect(queueList).toContainText('Chicken Breast', { timeout: 15000 });

      // Verify shopping list has entry
      const { data: shoppingItems } = await chef.from('shopping_list').select('*').eq('product_id', chickenId);

      expect(shoppingItems).not.toBeNull();
      expect(shoppingItems!.length).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup();
    }
  });

  test('delete button removes item from queue', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-delete');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chickenId = productMap['Chicken Breast'];

      // Add barcode to Chicken Breast product
      const chef = (client as any).schema('chefbyte');
      await chef.from('products').update({ barcode: '049000042566' }).eq('product_id', chickenId);

      await page.goto('/chef/scanner');
      await expect(page.getByTestId('barcode-input')).toBeVisible({ timeout: 15000 });

      // Scan barcode to add item to queue
      await page.getByTestId('barcode-input').fill('049000042566');
      await page.getByTestId('barcode-input').press('Enter');

      // Wait for queue item to finish processing
      const queueList = page.getByTestId('queue-list');
      await expect(queueList).toContainText('Chicken Breast', { timeout: 15000 });

      // Find and click the delete button
      const deleteBtn = page.locator('[data-testid^="delete-item-"]').first();
      await expect(deleteBtn).toBeVisible();
      await deleteBtn.click();

      // Queue should show empty message again
      await expect(page.getByTestId('queue-empty')).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  /* ================================================================== */
  /*  New tests — Batch 5 additions                                      */
  /* ================================================================== */

  test('nutrition editor fields accept input in purchase mode', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-nutinput');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/scanner');
      await expect(page.getByTestId('nutrition-editor')).toBeVisible({ timeout: 15000 });

      // Clear and type values into each nutrition field
      const caloriesInput = page.getByTestId('nut-calories');
      const proteinInput = page.getByTestId('nut-protein');
      const carbsInput = page.getByTestId('nut-carbs');
      const fatInput = page.getByTestId('nut-fat');

      await caloriesInput.fill('250');
      await expect(caloriesInput).toHaveValue('250');

      await proteinInput.fill('30');
      await expect(proteinInput).toHaveValue('30');

      await carbsInput.fill('20');
      await expect(carbsInput).toHaveValue('20');

      await fatInput.fill('10');
      await expect(fatInput).toHaveValue('10');
    } finally {
      await cleanup();
    }
  });

  test('auto-scaling adjusts nutrition when servings_per_container changes', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-autoscale');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chickenId = productMap['Chicken Breast'];

      // Add barcode and scan to populate nutrition fields from the product
      const chef = (client as any).schema('chefbyte');
      await chef.from('products').update({ barcode: '000000111111' }).eq('product_id', chickenId);

      await page.goto('/chef/scanner');
      await expect(page.getByTestId('nutrition-editor')).toBeVisible({ timeout: 15000 });

      // Scan the barcode so nutrition fields populate from the product
      await page.getByTestId('barcode-input').fill('000000111111');
      await page.getByTestId('barcode-input').press('Enter');
      await expect(page.getByTestId('queue-list')).toContainText('Chicken Breast', { timeout: 15000 });

      // Nutrition editor should now have Chicken Breast values:
      // calories=165, protein=31, carbs=0, fat=3.6
      const caloriesInput = page.getByTestId('nut-calories');
      const proteinInput = page.getByTestId('nut-protein');
      await expect(caloriesInput).toHaveValue('165');
      await expect(proteinInput).toHaveValue('31');

      // Now change calories — auto-scaling should adjust macros proportionally
      await caloriesInput.fill('330');

      // Protein should scale: 31 * (330/165) = 62
      await expect(proteinInput).toHaveValue('62');
    } finally {
      await cleanup();
    }
  });

  test('undo button removes last scanned item from queue', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-undo');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const riceId = productMap['Brown Rice'];

      const chef = (client as any).schema('chefbyte');
      await chef.from('products').update({ barcode: '000000222222' }).eq('product_id', riceId);

      await page.goto('/chef/scanner');
      await expect(page.getByTestId('barcode-input')).toBeVisible({ timeout: 15000 });

      // Scan barcode to add Brown Rice to queue
      await page.getByTestId('barcode-input').fill('000000222222');
      await page.getByTestId('barcode-input').press('Enter');

      const queueList = page.getByTestId('queue-list');
      await expect(queueList).toContainText('Brown Rice', { timeout: 15000 });

      // Click the undo/delete button for that item
      const undoBtn = page.locator('[data-testid^="delete-item-"]').first();
      await expect(undoBtn).toBeVisible();
      await undoBtn.click();

      // Queue should be empty now
      await expect(page.getByTestId('queue-empty')).toBeVisible({ timeout: 5000 });

      // Verify the stock lot that was created during purchase mode was also removed
      // (the undo handler deletes the lot from the DB)
      const lotCount = await countDbRows(client, 'chefbyte', 'stock_lots', {
        product_id: riceId,
        user_id: userId,
      });
      // Original seed has 1 lot for Brown Rice (qty 2). The scan added another, undo removed it.
      // So we should be back to the original count of 1.
      expect(lotCount).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test('process queue batch-commits all items to DB', async ({ page }) => {
    // NOTE: The scanner auto-processes each scan immediately (no batch commit button).
    // This test verifies that scanning multiple barcodes in purchase mode results in
    // all corresponding DB rows being created.
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-batch');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chickenId = productMap['Chicken Breast'];
      const riceId = productMap['Brown Rice'];
      const eggsId = productMap['Eggs'];

      // Assign unique barcodes to 3 products
      const chef = (client as any).schema('chefbyte');
      await chef.from('products').update({ barcode: '000000333301' }).eq('product_id', chickenId);
      await chef.from('products').update({ barcode: '000000333302' }).eq('product_id', riceId);
      await chef.from('products').update({ barcode: '000000333303' }).eq('product_id', eggsId);

      // Count existing stock lots before scanning
      const chickenLotsBefore = await countDbRows(client, 'chefbyte', 'stock_lots', {
        product_id: chickenId,
        user_id: userId,
      });
      const riceLotsBefore = await countDbRows(client, 'chefbyte', 'stock_lots', {
        product_id: riceId,
        user_id: userId,
      });
      const eggsLotsBefore = await countDbRows(client, 'chefbyte', 'stock_lots', {
        product_id: eggsId,
        user_id: userId,
      });

      await page.goto('/chef/scanner');
      await expect(page.getByTestId('barcode-input')).toBeVisible({ timeout: 15000 });

      // Scan 3 barcodes in purchase mode
      await page.getByTestId('barcode-input').fill('000000333301');
      await page.getByTestId('barcode-input').press('Enter');
      await expect(page.getByTestId('queue-list')).toContainText('Chicken Breast', { timeout: 15000 });

      await page.getByTestId('barcode-input').fill('000000333302');
      await page.getByTestId('barcode-input').press('Enter');
      await expect(page.getByTestId('queue-list')).toContainText('Brown Rice', { timeout: 15000 });

      await page.getByTestId('barcode-input').fill('000000333303');
      await page.getByTestId('barcode-input').press('Enter');
      await expect(page.getByTestId('queue-list')).toContainText('Eggs', { timeout: 15000 });

      // Verify each product got a new stock lot in the DB
      const chickenLotsAfter = await countDbRows(client, 'chefbyte', 'stock_lots', {
        product_id: chickenId,
        user_id: userId,
      });
      const riceLotsAfter = await countDbRows(client, 'chefbyte', 'stock_lots', {
        product_id: riceId,
        user_id: userId,
      });
      const eggsLotsAfter = await countDbRows(client, 'chefbyte', 'stock_lots', {
        product_id: eggsId,
        user_id: userId,
      });

      expect(chickenLotsAfter).toBe(chickenLotsBefore + 1);
      expect(riceLotsAfter).toBe(riceLotsBefore + 1);
      expect(eggsLotsAfter).toBe(eggsLotsBefore + 1);
    } finally {
      await cleanup();
    }
  });

  test('consume_no_macros mode processes without logging macros', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-nomacro');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chickenId = productMap['Chicken Breast'];

      const chef = (client as any).schema('chefbyte');
      await chef.from('products').update({ barcode: '000000444444' }).eq('product_id', chickenId);

      // Count food_logs before
      const logsBefore = await countDbRows(client, 'chefbyte', 'food_logs', {
        product_id: chickenId,
        user_id: userId,
      });

      await page.goto('/chef/scanner');
      await expect(page.getByTestId('mode-selector')).toBeVisible({ timeout: 15000 });

      // Switch to consume_no_macros mode
      await page.getByTestId('mode-consume_no_macros').click();

      // Scan barcode
      await page.getByTestId('barcode-input').fill('000000444444');
      await page.getByTestId('barcode-input').press('Enter');

      // Wait for queue item to finish processing
      await expect(page.getByTestId('queue-list')).toContainText('Chicken Breast', { timeout: 15000 });

      // Verify no new food_log entry was created (consume_no_macros sets p_log_macros=false)
      const logsAfter = await countDbRows(client, 'chefbyte', 'food_logs', {
        product_id: chickenId,
        user_id: userId,
      });
      expect(logsAfter).toBe(logsBefore);
    } finally {
      await cleanup();
    }
  });

  test('multiple rapid scans all queue correctly', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-rapid');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chickenId = productMap['Chicken Breast'];
      const riceId = productMap['Brown Rice'];
      const eggsId = productMap['Eggs'];

      // Assign unique barcodes
      const chef = (client as any).schema('chefbyte');
      await chef.from('products').update({ barcode: '000000555501' }).eq('product_id', chickenId);
      await chef.from('products').update({ barcode: '000000555502' }).eq('product_id', riceId);
      await chef.from('products').update({ barcode: '000000555503' }).eq('product_id', eggsId);

      await page.goto('/chef/scanner');
      await expect(page.getByTestId('barcode-input')).toBeVisible({ timeout: 15000 });

      // Rapid-fire 3 scans without waiting for processing between them
      await page.getByTestId('barcode-input').fill('000000555501');
      await page.getByTestId('barcode-input').press('Enter');

      await page.getByTestId('barcode-input').fill('000000555502');
      await page.getByTestId('barcode-input').press('Enter');

      await page.getByTestId('barcode-input').fill('000000555503');
      await page.getByTestId('barcode-input').press('Enter');

      // Wait for all 3 items to finish processing in the queue
      const queueList = page.getByTestId('queue-list');
      await expect(queueList).toContainText('Chicken Breast', { timeout: 15000 });
      await expect(queueList).toContainText('Brown Rice', { timeout: 15000 });
      await expect(queueList).toContainText('Eggs', { timeout: 15000 });

      // Verify exactly 3 queue items rendered
      const queueItems = page.locator('[data-testid^="queue-item-"]');
      await expect(queueItems).toHaveCount(3);
    } finally {
      await cleanup();
    }
  });

  test('verify DB state after scan in purchase mode', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-dbverify');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const proteinPowderId = productMap['Protein Powder'];

      const chef = (client as any).schema('chefbyte');
      await chef.from('products').update({ barcode: '000000666666' }).eq('product_id', proteinPowderId);

      // Count stock lots before scan
      const lotsBefore = await countDbRows(client, 'chefbyte', 'stock_lots', {
        product_id: proteinPowderId,
        user_id: userId,
      });

      await page.goto('/chef/scanner');
      await expect(page.getByTestId('barcode-input')).toBeVisible({ timeout: 15000 });

      // Ensure we're in purchase mode (default)
      await expect(page.getByTestId('nutrition-editor')).toBeVisible();

      // Set keypad to quantity 2 before scanning
      await page.getByTestId('key-2').click();
      await expect(page.getByTestId('screen-value')).toHaveText('2');

      // Scan barcode
      await page.getByTestId('barcode-input').fill('000000666666');
      await page.getByTestId('barcode-input').press('Enter');

      // Wait for queue item to finish
      await expect(page.getByTestId('queue-list')).toContainText('Protein Powder', { timeout: 15000 });

      // Verify DB: new stock_lot row was created
      const lotsAfter = await countDbRows(client, 'chefbyte', 'stock_lots', {
        product_id: proteinPowderId,
        user_id: userId,
      });
      expect(lotsAfter).toBe(lotsBefore + 1);

      // Verify the new lot has qty_containers = 2
      // Get all lots sorted by created_at desc, the newest should be our scan
      const { data: lots } = await chef
        .from('stock_lots')
        .select('lot_id, qty_containers')
        .eq('product_id', proteinPowderId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1);

      expect(lots).not.toBeNull();
      expect(lots!.length).toBe(1);
      expect(Number(lots![0].qty_containers)).toBe(2);

      // Verify the product still exists and has correct barcode
      await expectDbRow(client, 'chefbyte', 'products', { product_id: proteinPowderId }, { barcode: '000000666666' });
    } finally {
      await cleanup();
    }
  });

  /* ================================================================== */
  /*  New tests — consume quantity, undo, filter, nutrition editor       */
  /* ================================================================== */

  test('consume_macros with keypad quantity 3 consumes 3 servings', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-consumeqty');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chickenId = productMap['Chicken Breast'];

      const chef = (client as any).schema('chefbyte');
      await chef.from('products').update({ barcode: '000000777701' }).eq('product_id', chickenId);

      // Add extra stock (10 containers) so consume doesn't fail
      const { data: locs } = await chef
        .from('locations')
        .select('location_id')
        .eq('user_id', userId)
        .order('created_at')
        .limit(1);
      const locId = locs[0].location_id;
      await chef.from('stock_lots').insert({
        user_id: userId,
        product_id: chickenId,
        location_id: locId,
        qty_containers: 10,
      });

      await page.goto('/chef/scanner');
      await expect(page.getByTestId('mode-selector')).toBeVisible({ timeout: 15000 });

      // Switch to consume_macros mode
      await page.getByTestId('mode-consume_macros').click();

      // Set keypad to 3: click key-3
      await page.getByTestId('key-3').click();
      await expect(page.getByTestId('screen-value')).toHaveText('3');

      // Scan barcode
      await page.getByTestId('barcode-input').fill('000000777701');
      await page.getByTestId('barcode-input').press('Enter');

      // Wait for queue to show Chicken Breast
      await expect(page.getByTestId('queue-list')).toContainText('Chicken Breast', { timeout: 15000 });

      // Verify food_log was created:
      // 3 servings * 165 cal = 495 cal, 3 * 31 = 93 protein
      const todayDate = new Date().toISOString().slice(0, 10);
      await expectDbRow(
        client,
        'chefbyte',
        'food_logs',
        { product_id: chickenId, user_id: userId, logical_date: todayDate },
        { calories: 495, protein: 93 },
      );
    } finally {
      await cleanup();
    }
  });

  test('consume with container unit toggle consumes 1 container worth', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-containerunit');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const riceId = productMap['Brown Rice'];

      const chef = (client as any).schema('chefbyte');
      await chef.from('products').update({ barcode: '000000777702' }).eq('product_id', riceId);

      // Add extra stock (5 containers) so consume doesn't fail
      const { data: locs } = await chef
        .from('locations')
        .select('location_id')
        .eq('user_id', userId)
        .order('created_at')
        .limit(1);
      const locId = locs[0].location_id;
      await chef.from('stock_lots').insert({
        user_id: userId,
        product_id: riceId,
        location_id: locId,
        qty_containers: 5,
      });

      await page.goto('/chef/scanner');
      await expect(page.getByTestId('mode-selector')).toBeVisible({ timeout: 15000 });

      // Switch to consume_macros mode
      await page.getByTestId('mode-consume_macros').click();

      // Click unit-toggle to switch to Container
      await page.getByTestId('unit-toggle').click();
      await expect(page.getByTestId('unit-toggle')).toContainText('Container');

      // Scan barcode (keypad default is 1)
      await page.getByTestId('barcode-input').fill('000000777702');
      await page.getByTestId('barcode-input').press('Enter');

      // Wait for queue
      await expect(page.getByTestId('queue-list')).toContainText('Brown Rice', { timeout: 15000 });

      // Verify food_log: 1 container of Brown Rice = 8 servings
      // 8 * 216 cal = 1728 cal, 8 * 5 = 40 protein
      const todayDate = new Date().toISOString().slice(0, 10);
      await expectDbRow(
        client,
        'chefbyte',
        'food_logs',
        { product_id: riceId, user_id: userId, logical_date: todayDate },
        { calories: 1728, protein: 40 },
      );
    } finally {
      await cleanup();
    }
  });

  test('undo consume re-adds stock and deletes food_log', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-undoconsume');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const eggsId = productMap['Eggs'];

      const chef = (client as any).schema('chefbyte');
      await chef.from('products').update({ barcode: '000000777703' }).eq('product_id', eggsId);

      // Add extra stock so consume doesn't fail
      const { data: locs } = await chef
        .from('locations')
        .select('location_id')
        .eq('user_id', userId)
        .order('created_at')
        .limit(1);
      const locId = locs[0].location_id;
      await chef.from('stock_lots').insert({
        user_id: userId,
        product_id: eggsId,
        location_id: locId,
        qty_containers: 5,
      });

      // Count food_logs before
      const logsBefore = await countDbRows(client, 'chefbyte', 'food_logs', {
        product_id: eggsId,
        user_id: userId,
      });

      await page.goto('/chef/scanner');
      await expect(page.getByTestId('mode-selector')).toBeVisible({ timeout: 15000 });

      // Switch to consume_macros mode, scan
      await page.getByTestId('mode-consume_macros').click();
      await page.getByTestId('barcode-input').fill('000000777703');
      await page.getByTestId('barcode-input').press('Enter');

      // Wait for queue to show Eggs
      await expect(page.getByTestId('queue-list')).toContainText('Eggs', { timeout: 15000 });

      // Count food_logs after scan — should be +1
      const logsAfterScan = await countDbRows(client, 'chefbyte', 'food_logs', {
        product_id: eggsId,
        user_id: userId,
      });
      expect(logsAfterScan).toBe(logsBefore + 1);

      // Click undo/delete button on the queue item
      const undoBtn = page.locator('[data-testid^="delete-item-"]').first();
      await expect(undoBtn).toBeVisible();
      await undoBtn.click();

      // Wait for queue-empty
      await expect(page.getByTestId('queue-empty')).toBeVisible({ timeout: 5000 });

      // Count food_logs after undo — should be back to original count
      const logsAfterUndo = await countDbRows(client, 'chefbyte', 'food_logs', {
        product_id: eggsId,
        user_id: userId,
      });
      expect(logsAfterUndo).toBe(logsBefore);
    } finally {
      await cleanup();
    }
  });

  test('undo shopping scan removes item from shopping list', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-undoshop');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const bananasId = productMap['Bananas'];

      const chef = (client as any).schema('chefbyte');
      await chef.from('products').update({ barcode: '000000777704' }).eq('product_id', bananasId);

      await page.goto('/chef/scanner');
      await expect(page.getByTestId('mode-selector')).toBeVisible({ timeout: 15000 });

      // Switch to shopping mode
      await page.getByTestId('mode-shopping').click();

      // Scan barcode
      await page.getByTestId('barcode-input').fill('000000777704');
      await page.getByTestId('barcode-input').press('Enter');

      // Wait for queue to show Bananas
      await expect(page.getByTestId('queue-list')).toContainText('Bananas', { timeout: 15000 });

      // Count shopping_list items for this product — should be >= 1
      const cartCountAfterScan = await countDbRows(client, 'chefbyte', 'shopping_list', {
        product_id: bananasId,
        user_id: userId,
      });
      expect(cartCountAfterScan).toBeGreaterThanOrEqual(1);

      // Click undo/delete button
      const undoBtn = page.locator('[data-testid^="delete-item-"]').first();
      await expect(undoBtn).toBeVisible();
      await undoBtn.click();

      // Wait for queue-empty
      await expect(page.getByTestId('queue-empty')).toBeVisible({ timeout: 5000 });

      // Count shopping_list items — should be 0 for this product
      const cartCountAfterUndo = await countDbRows(client, 'chefbyte', 'shopping_list', {
        product_id: bananasId,
        user_id: userId,
      });
      expect(cartCountAfterUndo).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test('New filter shows only placeholder [!NEW] items', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-filternew');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const chickenId = productMap['Chicken Breast'];

      const chef = (client as any).schema('chefbyte');
      await chef.from('products').update({ barcode: '000000777705' }).eq('product_id', chickenId);

      await page.goto('/chef/scanner');
      await expect(page.getByTestId('barcode-input')).toBeVisible({ timeout: 15000 });

      // Scan known barcode first (Chicken Breast)
      await page.getByTestId('barcode-input').fill('000000777705');
      await page.getByTestId('barcode-input').press('Enter');
      await expect(page.getByTestId('queue-list')).toContainText('Chicken Breast', { timeout: 15000 });

      // Scan unknown barcode (will create placeholder)
      await page.getByTestId('barcode-input').fill('999999777706');
      await page.getByTestId('barcode-input').press('Enter');
      await expect(page.getByTestId('queue-list')).toContainText('Unknown (999999777706)', { timeout: 15000 });

      // Now 2 items in queue
      const allQueueItems = page.locator('[data-testid^="queue-item-"]');
      await expect(allQueueItems).toHaveCount(2);

      // Click filter-new button
      await page.getByTestId('filter-new').click();

      // Only the unknown/placeholder item should be visible (has [!NEW] badge)
      const filteredItems = page.locator('[data-testid^="queue-item-"]');
      await expect(filteredItems).toHaveCount(1);
      await expect(page.getByTestId('queue-list')).toContainText('Unknown');
      await expect(page.getByTestId('queue-list')).toContainText('[!NEW]');
    } finally {
      await cleanup();
    }
  });

  test('purchase scan saves edited nutrition to product', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-nutsave');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const proteinPowderId = productMap['Protein Powder'];

      const chef = (client as any).schema('chefbyte');
      await chef.from('products').update({ barcode: '000000777707' }).eq('product_id', proteinPowderId);

      await page.goto('/chef/scanner');
      await expect(page.getByTestId('barcode-input')).toBeVisible({ timeout: 15000 });

      // Scan barcode in purchase mode
      await page.getByTestId('barcode-input').fill('000000777707');
      await page.getByTestId('barcode-input').press('Enter');

      // Wait for queue to show Protein Powder
      await expect(page.getByTestId('queue-list')).toContainText('Protein Powder', { timeout: 15000 });

      // Nutrition editor should have values: calories=120, protein=24
      const caloriesInput = page.getByTestId('nut-calories');
      await expect(caloriesInput).toHaveValue('120');

      // Edit calories to 150
      await caloriesInput.fill('150');
      // Auto-scale should adjust protein to 24*(150/120)=30
      await expect(page.getByTestId('nut-protein')).toHaveValue('30');

      // Scan AGAIN with the same barcode (this triggers nutrition update via executeAction)
      await page.getByTestId('barcode-input').fill('000000777707');
      await page.getByTestId('barcode-input').press('Enter');

      // Wait for second queue item
      const queueItems = page.locator('[data-testid^="queue-item-"]');
      await expect(queueItems).toHaveCount(2, { timeout: 15000 });

      // Verify in DB: product should now have the updated calories_per_serving
      // The second scan re-reads the product from DB and overwrites nutrition,
      // but the first scan's executeAction already saved the edited values.
      // So we check the first scan's write took effect.
      await expectDbRow(client, 'chefbyte', 'products', { product_id: proteinPowderId }, { calories_per_serving: 150 });
    } finally {
      await cleanup();
    }
  });

  test('scanning same barcode twice in purchase mode creates 2 stock lots', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-twolots');
    try {
      const { productMap } = await seedChefByteData(client, userId);
      const eggsId = productMap['Eggs'];

      const chef = (client as any).schema('chefbyte');
      await chef.from('products').update({ barcode: '000000777708' }).eq('product_id', eggsId);

      // Count stock lots for Eggs before
      const lotsBefore = await countDbRows(client, 'chefbyte', 'stock_lots', {
        product_id: eggsId,
        user_id: userId,
      });

      await page.goto('/chef/scanner');
      await expect(page.getByTestId('barcode-input')).toBeVisible({ timeout: 15000 });

      // Scan barcode once, wait for queue
      await page.getByTestId('barcode-input').fill('000000777708');
      await page.getByTestId('barcode-input').press('Enter');
      await expect(page.getByTestId('queue-list')).toContainText('Eggs', { timeout: 15000 });

      // Scan barcode again, wait for 2 items in queue
      await page.getByTestId('barcode-input').fill('000000777708');
      await page.getByTestId('barcode-input').press('Enter');
      const queueItems = page.locator('[data-testid^="queue-item-"]');
      await expect(queueItems).toHaveCount(2, { timeout: 15000 });

      // Count stock lots after — should be +2
      const lotsAfter = await countDbRows(client, 'chefbyte', 'stock_lots', {
        product_id: eggsId,
        user_id: userId,
      });
      expect(lotsAfter).toBe(lotsBefore + 2);
    } finally {
      await cleanup();
    }
  });
});
