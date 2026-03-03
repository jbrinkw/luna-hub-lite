import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData } from '../helpers/seed';

test.describe('ChefByte Scanner', () => {
  test('scanner page loads with correct layout', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-layout');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef');
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
      await page.goto('/chef');
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
      await page.goto('/chef');
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
      await page.goto('/chef');
      await expect(page.getByTestId('mode-selector')).toBeVisible({ timeout: 15000 });

      // Purchase mode: unit-toggle NOT visible
      await expect(page.getByTestId('unit-toggle')).not.toBeVisible();

      // Switch to consume_macros → unit-toggle visible showing "Servings"
      await page.getByTestId('mode-consume_macros').click();
      await expect(page.getByTestId('unit-toggle')).toBeVisible();
      await expect(page.getByTestId('unit-toggle')).toContainText('Servings');

      // Click it → shows "Containers"
      await page.getByTestId('unit-toggle').click();
      await expect(page.getByTestId('unit-toggle')).toContainText('Containers');
    } finally {
      await cleanup();
    }
  });

  test('nutrition editor visible only in purchase mode', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'scan-nutedit');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef');
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

      await page.goto('/chef');
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
      await page.goto('/chef');
      await expect(page.getByTestId('barcode-input')).toBeVisible({ timeout: 15000 });

      // Scan a random unknown barcode
      await page.getByTestId('barcode-input').fill('9999999999999');
      await page.getByTestId('barcode-input').press('Enter');

      // Wait for queue item to process (name changes from "Processing..." to actual name)
      const queueList = page.getByTestId('queue-list');
      await expect(queueList).toContainText('9999999999999', { timeout: 15000 });

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

      await page.goto('/chef');
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

      await page.goto('/chef');
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

      await page.goto('/chef');
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
});
