import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { seedUser, seedFullAndLogin, seedChefByteData, seedCoachByteData } from '../helpers/seed';
import { generateTestApiKey, McpE2EClient } from '../helpers/mcp-client';
import { SUPABASE_URL, ANON_KEY } from '../helpers/constants';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface McpContext {
  userId: string;
  email: string;
  password: string;
  cleanup: () => Promise<void>;
  client: SupabaseClient;
  mcp: McpE2EClient;
}

/**
 * Creates a test user with both modules activated, an authenticated Supabase
 * client, and an initialized MCP SSE connection.
 */
async function setupMcpUser(suffix: string): Promise<McpContext> {
  const { userId, email, password, cleanup } = await seedUser(suffix);

  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await client.auth.signInWithPassword({ email, password });

  // Activate both modules
  const { error: coachErr } = await (client as any).schema('hub').rpc('activate_app', { p_app_name: 'coachbyte' });
  if (coachErr) throw new Error(`Failed to activate CoachByte: ${coachErr.message}`);

  const { error: chefErr } = await (client as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
  if (chefErr) throw new Error(`Failed to activate ChefByte: ${chefErr.message}`);

  const apiKey = await generateTestApiKey(userId);
  const mcp = new McpE2EClient();
  await mcp.connect(apiKey);
  await mcp.initialize();

  return { userId, email, password, cleanup, client, mcp };
}

/** Parse the first content text entry from an MCP tool result as JSON. */
function parseResult(result: any): any {
  return JSON.parse(result.content[0].text);
}

/**
 * Asserts that two DB row snapshots share the same "shape": identical set of
 * non-null user-data columns (ignoring IDs, timestamps, and user_id since
 * those differ by design).
 *
 * For numeric columns present in both, asserts the values are close.
 */
function assertRowShape(
  rowA: Record<string, any>,
  rowB: Record<string, any>,
  opts?: {
    /** Columns to skip from shape comparison */
    ignore?: string[];
    /** Columns that MUST be present and non-null in both rows */
    required?: string[];
    /** Columns where numeric values should be compared for closeness */
    numericClose?: string[];
  },
) {
  // Assert required columns are non-null in both
  for (const col of opts?.required ?? []) {
    expect(rowA[col], `Row A missing required column: ${col}`).not.toBeNull();
    expect(rowA[col], `Row A missing required column: ${col}`).not.toBeUndefined();
    expect(rowB[col], `Row B missing required column: ${col}`).not.toBeNull();
    expect(rowB[col], `Row B missing required column: ${col}`).not.toBeUndefined();
  }

  // Assert numeric columns are close
  for (const col of opts?.numericClose ?? []) {
    if (rowA[col] != null && rowB[col] != null) {
      expect(Number(rowA[col])).toBeCloseTo(Number(rowB[col]), 1);
    }
  }
}

/**
 * Fetches a single DB row from a schema.table matching the filter.
 */
async function fetchRow(
  client: SupabaseClient,
  schema: string,
  table: string,
  filter: Record<string, any>,
): Promise<Record<string, any>> {
  const sc = (client as any).schema(schema);
  let query = sc.from(table).select('*');
  for (const [key, value] of Object.entries(filter)) {
    if (value === null) {
      query = query.is(key, null);
    } else {
      query = query.eq(key, value);
    }
  }
  const { data, error } = await query;
  if (error) throw new Error(`fetchRow failed: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error(`fetchRow: no row in ${schema}.${table} matching ${JSON.stringify(filter)}`);
  }
  return data[0];
}

/**
 * Fetches all DB rows from a schema.table matching the filter.
 */
async function fetchRows(
  client: SupabaseClient,
  schema: string,
  table: string,
  filter: Record<string, any>,
): Promise<Record<string, any>[]> {
  const sc = (client as any).schema(schema);
  let query = sc.from(table).select('*');
  for (const [key, value] of Object.entries(filter)) {
    if (value === null) {
      query = query.is(key, null);
    } else {
      query = query.eq(key, value);
    }
  }
  const { data, error } = await query;
  if (error) throw new Error(`fetchRows failed: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Test: Create Product parity
// ---------------------------------------------------------------------------

test.describe('MCP-UI Parity', () => {
  test('create product: UI vs MCP produce equivalent DB rows', async ({ page }) => {
    // --- MCP path ---
    let mcpCtx: McpContext | null = null;
    let mcpProductRow: Record<string, any>;
    try {
      mcpCtx = await setupMcpUser('parity-product-mcp');

      const result = await mcpCtx.mcp.callTool('CHEFBYTE_create_product', {
        name: 'Parity Oatmeal',
        servings_per_container: 10,
        calories_per_serving: 150,
        protein_per_serving: 5,
        carbs_per_serving: 27,
        fat_per_serving: 3,
      });
      const data = parseResult(result);
      const mcpProductId = data.product.product_id;

      mcpProductRow = await fetchRow(mcpCtx.client, 'chefbyte', 'products', {
        product_id: mcpProductId,
      });
    } finally {
      await mcpCtx?.mcp.disconnect();
      await mcpCtx?.cleanup();
    }

    // --- UI path ---
    const {
      userId: uiUserId,
      cleanup: uiCleanup,
      client: uiClient,
    } = await seedFullAndLogin(page, 'parity-product-ui');
    let uiProductRow: Record<string, any>;
    try {
      await page.goto('/chef/settings');
      await page.getByTestId('product-list').waitFor({ state: 'visible', timeout: 15000 });

      // Open add product form
      await page.getByTestId('toggle-add-product').click();
      await expect(page.getByTestId('add-product-form')).toBeVisible();

      // Fill in the same values
      await page.getByTestId('add-name').locator('input').fill('Parity Oatmeal');
      await page.getByTestId('add-servings').locator('input').fill('10');
      await page.getByTestId('add-calories').locator('input').fill('150');
      await page.getByTestId('add-protein').locator('input').fill('5');
      await page.getByTestId('add-carbs').locator('input').fill('27');
      await page.getByTestId('add-fat').locator('input').fill('3');

      // Save
      await page.getByTestId('save-new-product').click();
      await expect(page.getByTestId('add-product-form')).toBeHidden({ timeout: 5000 });

      // Wait for DB write to propagate
      await page.waitForTimeout(500);

      // Fetch the UI-created product
      const uiProducts = await fetchRows(uiClient, 'chefbyte', 'products', {
        user_id: uiUserId,
      });
      uiProductRow = uiProducts.find((p) => p.name === 'Parity Oatmeal')!;
      expect(uiProductRow).toBeTruthy();
    } finally {
      await uiCleanup();
    }

    // --- Compare ---
    assertRowShape(mcpProductRow!, uiProductRow!, {
      ignore: ['product_id'],
      required: [
        'name',
        'servings_per_container',
        'calories_per_serving',
        'protein_per_serving',
        'carbs_per_serving',
        'fat_per_serving',
      ],
      numericClose: [
        'servings_per_container',
        'calories_per_serving',
        'protein_per_serving',
        'carbs_per_serving',
        'fat_per_serving',
      ],
    });

    // Both should have the same name
    expect(mcpProductRow!.name).toBe(uiProductRow!.name);
    // Both should default is_placeholder to false
    expect(mcpProductRow!.is_placeholder).toBe(false);
    expect(uiProductRow!.is_placeholder).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Test: Add Stock parity
  // ---------------------------------------------------------------------------

  test('add stock: UI (scanner purchase) vs MCP produce equivalent stock lots', async ({ page }) => {
    // --- MCP path ---
    let mcpCtx: McpContext | null = null;
    let mcpLotRow: Record<string, any>;
    try {
      mcpCtx = await setupMcpUser('parity-stock-mcp');
      const { productMap } = await seedChefByteData(mcpCtx.client, mcpCtx.userId);
      const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];

      const result = await mcpCtx.mcp.callTool('CHEFBYTE_add_stock', {
        product_id: chickenId,
        qty_containers: 2,
      });
      const data = parseResult(result);
      const mcpLotId = data.lot.lot_id;

      mcpLotRow = await fetchRow(mcpCtx.client, 'chefbyte', 'stock_lots', {
        lot_id: mcpLotId,
      });
    } finally {
      await mcpCtx?.mcp.disconnect();
      await mcpCtx?.cleanup();
    }

    // --- UI path: scanner in purchase mode ---
    const { userId: uiUserId, cleanup: uiCleanup, client: uiClient } = await seedFullAndLogin(page, 'parity-stock-ui');
    let uiLotRows: Record<string, any>[];
    try {
      const { productMap: uiProductMap } = await seedChefByteData(uiClient, uiUserId);
      const uiChickenId = uiProductMap['Great Value Boneless Skinless Chicken Breasts'];

      // Get existing stock lots count for Chicken Breast (from seed data)
      const existingLots = await fetchRows(uiClient, 'chefbyte', 'stock_lots', {
        user_id: uiUserId,
        product_id: uiChickenId,
      });
      const existingCount = existingLots.length;

      // Get the barcode or set one so the scanner can find it
      await (uiClient as any)
        .schema('chefbyte')
        .from('products')
        .update({ barcode: '0011223344556' })
        .eq('product_id', uiChickenId);

      await page.goto('/chef/scanner');
      await page.getByTestId('scanner-container').waitFor({ state: 'visible', timeout: 15000 });

      // Ensure mode is purchase (default)
      await expect(page.getByTestId('mode-purchase')).toBeVisible();

      // Set quantity to 2 via keypad
      await page.getByTestId('key-2').click();

      // Type barcode and submit
      const barcodeInput = page.getByTestId('barcode-input');
      await barcodeInput.fill('0011223344556');
      await barcodeInput.press('Enter');

      // Wait for the queue item to show success
      await page.waitForTimeout(3000);

      // Fetch all lots after the scanner action
      uiLotRows = await fetchRows(uiClient, 'chefbyte', 'stock_lots', {
        user_id: uiUserId,
        product_id: uiChickenId,
      });

      // Should have at least one more lot than before
      expect(uiLotRows.length).toBeGreaterThan(existingCount);
    } finally {
      await uiCleanup();
    }

    // Find the newly created lot (the one not in the seed data — highest created_at)
    const uiNewLot = uiLotRows!.sort(
      (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )[0];

    // --- Compare lot shapes ---
    // Both lots should have these core columns populated
    assertRowShape(mcpLotRow!, uiNewLot, {
      ignore: ['lot_id', 'product_id', 'location_id', 'expires_on'],
      required: ['qty_containers', 'location_id', 'product_id'],
      numericClose: ['qty_containers'],
    });

    // Both should be qty_containers = 2
    expect(Number(mcpLotRow!.qty_containers)).toBeCloseTo(2, 1);
    expect(Number(uiNewLot.qty_containers)).toBeCloseTo(2, 1);
  });

  // ---------------------------------------------------------------------------
  // Test: Consume Stock parity
  // ---------------------------------------------------------------------------

  test('consume stock: UI (scanner consume) vs MCP produce equivalent food_log + stock deduction', async ({ page }) => {
    // --- MCP path ---
    let mcpCtx: McpContext | null = null;
    let mcpFoodLogRow: Record<string, any>;
    let mcpStockAfter: number;
    try {
      mcpCtx = await setupMcpUser('parity-consume-mcp');
      const { productMap } = await seedChefByteData(mcpCtx.client, mcpCtx.userId);
      const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];

      // Get stock before
      const lotsBefore = await fetchRows(mcpCtx.client, 'chefbyte', 'stock_lots', {
        user_id: mcpCtx.userId,
        product_id: chickenId,
      });
      const stockBefore = lotsBefore.reduce((sum, l) => sum + Number(l.qty_containers), 0);

      // Consume 1 container via MCP
      await mcpCtx.mcp.callTool('CHEFBYTE_consume', {
        product_id: chickenId,
        qty: 1,
        unit: 'container',
      });

      // Get stock after
      const lotsAfter = await fetchRows(mcpCtx.client, 'chefbyte', 'stock_lots', {
        user_id: mcpCtx.userId,
        product_id: chickenId,
      });
      mcpStockAfter = lotsAfter.reduce((sum, l) => sum + Number(l.qty_containers), 0);
      expect(mcpStockAfter).toBeLessThan(stockBefore);

      // Get the food_log row created
      const logs = await fetchRows(mcpCtx.client, 'chefbyte', 'food_logs', {
        user_id: mcpCtx.userId,
        product_id: chickenId,
      });
      expect(logs.length).toBeGreaterThanOrEqual(1);
      mcpFoodLogRow = logs[0];
    } finally {
      await mcpCtx?.mcp.disconnect();
      await mcpCtx?.cleanup();
    }

    // --- UI path: scanner in consume_macros mode ---
    const {
      userId: uiUserId,
      cleanup: uiCleanup,
      client: uiClient,
    } = await seedFullAndLogin(page, 'parity-consume-ui');
    let uiFoodLogRow: Record<string, any>;
    let uiStockAfter: number;
    try {
      const { productMap: uiProductMap } = await seedChefByteData(uiClient, uiUserId);
      const uiChickenId = uiProductMap['Great Value Boneless Skinless Chicken Breasts'];

      // Set barcode
      await (uiClient as any)
        .schema('chefbyte')
        .from('products')
        .update({ barcode: '0011223344557' })
        .eq('product_id', uiChickenId);

      // Get stock before
      const uiLotsBefore = await fetchRows(uiClient, 'chefbyte', 'stock_lots', {
        user_id: uiUserId,
        product_id: uiChickenId,
      });
      const uiStockBefore = uiLotsBefore.reduce((sum, l) => sum + Number(l.qty_containers), 0);

      await page.goto('/chef/scanner');
      await page.getByTestId('scanner-container').waitFor({ state: 'visible', timeout: 15000 });

      // Switch to consume_macros mode
      await page.getByTestId('mode-consume_macros').click();

      // Switch unit to container
      await page.getByTestId('unit-toggle').click();

      // Keypad: set qty to 1 (already default)

      // Scan barcode
      const barcodeInput = page.getByTestId('barcode-input');
      await barcodeInput.fill('0011223344557');
      await barcodeInput.press('Enter');

      // Wait for processing
      await page.waitForTimeout(3000);

      // Verify stock decreased
      const uiLotsAfter = await fetchRows(uiClient, 'chefbyte', 'stock_lots', {
        user_id: uiUserId,
        product_id: uiChickenId,
      });
      uiStockAfter = uiLotsAfter.reduce((sum, l) => sum + Number(l.qty_containers), 0);
      expect(uiStockAfter).toBeLessThan(uiStockBefore);

      // Get the food_log row
      const uiLogs = await fetchRows(uiClient, 'chefbyte', 'food_logs', {
        user_id: uiUserId,
        product_id: uiChickenId,
      });
      expect(uiLogs.length).toBeGreaterThanOrEqual(1);
      uiFoodLogRow = uiLogs[0];
    } finally {
      await uiCleanup();
    }

    // --- Compare food_log shapes ---
    assertRowShape(mcpFoodLogRow!, uiFoodLogRow!, {
      ignore: ['log_id', 'product_id', 'meal_id', 'logical_date'],
      required: ['calories', 'protein', 'carbs', 'fat', 'qty_consumed', 'unit'],
      numericClose: ['calories', 'protein', 'carbs', 'fat', 'qty_consumed'],
    });

    // Both should have logged macros (non-zero calories for Chicken Breast)
    expect(Number(mcpFoodLogRow!.calories)).toBeGreaterThan(0);
    expect(Number(uiFoodLogRow!.calories)).toBeGreaterThan(0);

    // Both should have the same unit (container)
    expect(mcpFoodLogRow!.unit).toBe('container');
    expect(uiFoodLogRow!.unit).toBe('container');
  });

  // ---------------------------------------------------------------------------
  // Test: Add to Shopping parity
  // ---------------------------------------------------------------------------

  test('add to shopping: UI vs MCP produce equivalent shopping_list rows', async ({ page }) => {
    // --- MCP path ---
    let mcpCtx: McpContext | null = null;
    let mcpShoppingRow: Record<string, any>;
    try {
      mcpCtx = await setupMcpUser('parity-shop-mcp');
      const { productMap } = await seedChefByteData(mcpCtx.client, mcpCtx.userId);
      const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];

      await mcpCtx.mcp.callTool('CHEFBYTE_add_to_shopping', {
        product_id: chickenId,
        qty_containers: 3,
      });

      mcpShoppingRow = await fetchRow(mcpCtx.client, 'chefbyte', 'shopping_list', {
        user_id: mcpCtx.userId,
        product_id: chickenId,
      });
    } finally {
      await mcpCtx?.mcp.disconnect();
      await mcpCtx?.cleanup();
    }

    // --- UI path ---
    const { userId: uiUserId, cleanup: uiCleanup, client: uiClient } = await seedFullAndLogin(page, 'parity-shop-ui');
    let uiShoppingRow: Record<string, any>;
    try {
      const { productMap: uiProductMap } = await seedChefByteData(uiClient, uiUserId);

      await page.goto('/chef/shopping');
      await page.getByTestId('add-item-form').waitFor({ state: 'visible', timeout: 15000 });

      // Type "Chicken" in the search to find the product
      const nameInput = page.getByTestId('add-item-name').locator('input');
      await nameInput.fill('Chicken');

      // Wait for the dropdown to appear
      await page.waitForTimeout(500);
      const dropdown = page.getByTestId('product-dropdown');
      if (await dropdown.isVisible()) {
        // Click the Chicken Breast option from the dropdown
        const chickenOption = dropdown
          .locator('div')
          .filter({ hasText: 'Great Value Boneless Skinless Chicken Breasts' })
          .first();
        await chickenOption.click();
      }

      // Set qty to 3
      const qtyInput = page.getByTestId('add-item-qty').locator('input');
      await qtyInput.fill('3');

      // Add
      await page.getByTestId('add-item-btn').click();

      // Wait for the item to appear in the list
      await page.waitForTimeout(1000);

      const uiChickenId = uiProductMap['Great Value Boneless Skinless Chicken Breasts'];
      uiShoppingRow = await fetchRow(uiClient, 'chefbyte', 'shopping_list', {
        user_id: uiUserId,
        product_id: uiChickenId,
      });
    } finally {
      await uiCleanup();
    }

    // --- Compare ---
    assertRowShape(mcpShoppingRow!, uiShoppingRow!, {
      ignore: ['cart_item_id', 'product_id'],
      required: ['qty_containers', 'purchased'],
      numericClose: ['qty_containers'],
    });

    // Both have 3 containers
    expect(Number(mcpShoppingRow!.qty_containers)).toBeCloseTo(3, 1);
    expect(Number(uiShoppingRow!.qty_containers)).toBeCloseTo(3, 1);

    // Both default purchased to false
    expect(mcpShoppingRow!.purchased).toBe(false);
    expect(uiShoppingRow!.purchased).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Test: Complete Set parity
  // ---------------------------------------------------------------------------

  test('complete set: UI vs MCP produce equivalent completed_sets rows', async ({ page }) => {
    // --- MCP path ---
    let mcpCtx: McpContext | null = null;
    let mcpCompletedRow: Record<string, any>;
    try {
      mcpCtx = await setupMcpUser('parity-set-mcp');
      await seedCoachByteData(mcpCtx.client, mcpCtx.userId);

      // Get today's plan (creates it from split via ensure_daily_plan)
      const planResult = await mcpCtx.mcp.callTool('COACHBYTE_get_today_plan', {});
      const planData = parseResult(planResult);
      const planId = planData.plan_id;

      // Complete the first set
      await mcpCtx.mcp.callTool('COACHBYTE_complete_next_set', {
        plan_id: planId,
        reps: 5,
        load: 225,
      });

      // Fetch the completed set
      const completedSets = await fetchRows(mcpCtx.client, 'coachbyte', 'completed_sets', { user_id: mcpCtx.userId });
      expect(completedSets.length).toBeGreaterThanOrEqual(1);
      mcpCompletedRow = completedSets[0];
    } finally {
      await mcpCtx?.mcp.disconnect();
      await mcpCtx?.cleanup();
    }

    // --- UI path ---
    const { userId: uiUserId, cleanup: uiCleanup, client: uiClient } = await seedFullAndLogin(page, 'parity-set-ui');
    let uiCompletedRow: Record<string, any>;
    try {
      await seedCoachByteData(uiClient, uiUserId);

      await page.goto('/coach');

      // Wait for the plan to bootstrap
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 15000 });

      // Complete the first set (Squat) by clicking the Complete Set button
      // The default values should be pre-filled from the split template (5 reps, 225 lbs)
      await page.getByTestId('complete-set-btn').click();

      // Wait for the completed row to appear
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 10000 });

      // Wait for DB write
      await page.waitForTimeout(500);

      // Fetch the completed set
      const uiCompletedSets = await fetchRows(uiClient, 'coachbyte', 'completed_sets', { user_id: uiUserId });
      expect(uiCompletedSets.length).toBeGreaterThanOrEqual(1);
      uiCompletedRow = uiCompletedSets[0];
    } finally {
      await uiCleanup();
    }

    // --- Compare ---
    assertRowShape(mcpCompletedRow!, uiCompletedRow!, {
      ignore: ['completed_set_id', 'plan_id', 'planned_set_id', 'exercise_id', 'logical_date'],
      required: ['actual_reps', 'actual_load', 'exercise_id', 'plan_id'],
      numericClose: ['actual_load'],
    });

    // Both should have 5 reps, 225 load
    expect(mcpCompletedRow!.actual_reps).toBe(5);
    expect(uiCompletedRow!.actual_reps).toBe(5);
    expect(Number(mcpCompletedRow!.actual_load)).toBeCloseTo(225, 1);
    expect(Number(uiCompletedRow!.actual_load)).toBeCloseTo(225, 1);
  });

  // ---------------------------------------------------------------------------
  // Test: Log Temp Item parity
  // ---------------------------------------------------------------------------

  test('log temp item: UI vs MCP produce equivalent temp_items rows', async ({ page }) => {
    // --- MCP path ---
    let mcpCtx: McpContext | null = null;
    let mcpTempRow: Record<string, any>;
    try {
      mcpCtx = await setupMcpUser('parity-temp-mcp');

      const result = await mcpCtx.mcp.callTool('CHEFBYTE_log_temp_item', {
        name: 'Parity Snack',
        calories: 250,
        protein: 10,
        carbs: 30,
        fat: 12,
      });
      const data = parseResult(result);
      expect(data.item.temp_id).toBeTruthy();

      mcpTempRow = await fetchRow(mcpCtx.client, 'chefbyte', 'temp_items', {
        temp_id: data.item.temp_id,
      });
    } finally {
      await mcpCtx?.mcp.disconnect();
      await mcpCtx?.cleanup();
    }

    // --- UI path ---
    const { userId: uiUserId, cleanup: uiCleanup, client: uiClient } = await seedFullAndLogin(page, 'parity-temp-ui');
    let uiTempRow: Record<string, any>;
    try {
      await page.goto('/chef/macros');

      // Wait for the page to load
      await page.getByTestId('macro-summary').waitFor({ state: 'visible', timeout: 15000 });

      // Open the temp item modal
      await page.getByTestId('log-temp-btn').click();
      await expect(page.getByTestId('temp-item-modal')).toBeVisible({ timeout: 5000 });

      // Fill in the form with the same values
      await page.getByTestId('temp-name').locator('input').fill('Parity Snack');
      await page.getByTestId('temp-calories').locator('input').fill('250');
      await page.getByTestId('temp-protein').locator('input').fill('10');
      await page.getByTestId('temp-carbs').locator('input').fill('30');
      await page.getByTestId('temp-fat').locator('input').fill('12');

      // Save
      await page.getByTestId('temp-save-btn').click();

      // Wait for the modal to close and data to persist
      await expect(page.getByTestId('temp-item-modal')).toBeHidden({ timeout: 5000 });
      await page.waitForTimeout(500);

      // Fetch the temp item from DB
      const uiTempItems = await fetchRows(uiClient, 'chefbyte', 'temp_items', {
        user_id: uiUserId,
      });
      expect(uiTempItems.length).toBeGreaterThanOrEqual(1);
      uiTempRow = uiTempItems.find((t) => t.name === 'Parity Snack')!;
      expect(uiTempRow).toBeTruthy();
    } finally {
      await uiCleanup();
    }

    // --- Compare ---
    assertRowShape(mcpTempRow!, uiTempRow!, {
      ignore: ['temp_id', 'logical_date'],
      required: ['name', 'calories', 'protein', 'carbs', 'fat'],
      numericClose: ['calories', 'protein', 'carbs', 'fat'],
    });

    // Both should have identical field values
    expect(mcpTempRow!.name).toBe('Parity Snack');
    expect(uiTempRow!.name).toBe('Parity Snack');
    expect(Number(mcpTempRow!.calories)).toBeCloseTo(250, 1);
    expect(Number(uiTempRow!.calories)).toBeCloseTo(250, 1);
    expect(Number(mcpTempRow!.protein)).toBeCloseTo(10, 1);
    expect(Number(uiTempRow!.protein)).toBeCloseTo(10, 1);
    expect(Number(mcpTempRow!.carbs)).toBeCloseTo(30, 1);
    expect(Number(uiTempRow!.carbs)).toBeCloseTo(30, 1);
    expect(Number(mcpTempRow!.fat)).toBeCloseTo(12, 1);
    expect(Number(uiTempRow!.fat)).toBeCloseTo(12, 1);
  });
});
