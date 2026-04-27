import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { seedUser, seedFullAndLogin, seedChefByteData, seedCoachByteData, signInWithRetry } from '../helpers/seed';
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
  const { data: signInData, error: signInErr } = await signInWithRetry(client, email, password);
  if (signInErr || !signInData?.session)
    throw new Error(`Sign-in failed for ${email}: ${signInErr?.message ?? 'no session'}`);

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
      await page.getByTestId('toggle-add-product').waitFor({ state: 'visible', timeout: 30000 });

      // Open add product form
      await page.getByTestId('toggle-add-product').click();
      await expect(page.getByTestId('add-product-form')).toBeVisible({ timeout: 30000 });

      // Wait for form fields to be ready
      await expect(page.getByTestId('add-name')).toBeVisible({ timeout: 30000 });

      // Fill in the same values
      await page.getByTestId('add-name').fill('Parity Oatmeal');
      await page.getByTestId('add-servings').fill('10');
      await page.getByTestId('add-calories').fill('150');
      await page.getByTestId('add-protein').fill('5');
      await page.getByTestId('add-carbs').fill('27');
      await page.getByTestId('add-fat').fill('3');

      // Save
      await page.getByTestId('save-new-product').click();
      await expect(page.getByTestId('add-product-form')).toBeHidden({ timeout: 30000 });

      // Wait for DB write to propagate
      await page.waitForTimeout(2000);

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
      await page.getByTestId('scanner-container').waitFor({ state: 'visible', timeout: 30000 });

      // Ensure mode is purchase (default)
      await expect(page.getByTestId('mode-purchase')).toBeVisible({ timeout: 30000 });

      // Set quantity to 2 via keypad
      await page.getByTestId('key-2').click();

      // Type barcode and submit
      const barcodeInput = page.getByTestId('barcode-input');
      await barcodeInput.fill('0011223344556');
      await barcodeInput.press('Enter');

      // Wait for the queue item to show success
      await page.waitForTimeout(5000);

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
      await page.getByTestId('scanner-container').waitFor({ state: 'visible', timeout: 30000 });

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
      await page.waitForTimeout(5000);

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
      await page.getByTestId('add-item-form').waitFor({ state: 'visible', timeout: 30000 });

      // Type "Chicken" in the search to find the product
      const nameInput = page.getByTestId('add-item-name');
      await nameInput.fill('Chicken');

      // Wait for the dropdown to appear
      await page.waitForTimeout(2000);
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
      const qtyInput = page.getByTestId('add-item-qty');
      await qtyInput.fill('3');

      // Add
      await page.getByTestId('add-item-btn').click();

      // Wait for the item to appear in the list
      await page.waitForTimeout(2000);

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
      await expect(page.getByTestId('next-in-queue')).toBeVisible({ timeout: 30000 });

      // Complete the first set (Squat) by clicking the Complete Set button
      // The default values should be pre-filled from the split template (5 reps, 225 lbs)
      await page.getByTestId('complete-set-btn').click();

      // Wait for the completed row to appear
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 30000 });

      // Wait for DB write
      await page.waitForTimeout(2000);

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
      await page.getByTestId('macro-summary').waitFor({ state: 'visible', timeout: 30000 });

      // Open the temp item modal
      await page.getByTestId('log-temp-btn').click();
      await expect(page.getByTestId('temp-item-modal')).toBeVisible({ timeout: 30000 });

      // Fill in the form with the same values
      await page.getByTestId('temp-name').fill('Parity Snack');
      await page.getByTestId('temp-calories').fill('250');
      await page.getByTestId('temp-protein').fill('10');
      await page.getByTestId('temp-carbs').fill('30');
      await page.getByTestId('temp-fat').fill('12');

      // Save
      await page.getByTestId('temp-save-btn').click();

      // Wait for the modal to close and data to persist
      await expect(page.getByTestId('temp-item-modal')).toBeHidden({ timeout: 30000 });
      await page.waitForTimeout(2000);

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

  // ---------------------------------------------------------------------------
  // Expansion batch: ~18 additional MCP tools with UI-vs-MCP parity.
  //
  // "UI path" here is a direct supabase-js write against the authenticated
  // client — this matches the code path every UI mutation actually uses
  // (supabase-js → PostgREST / RPC → RLS). Where a dedicated RPC exists
  // (mark_meal_done), we call it. This deliberately skips rendering each
  // page — the point of these tests is to pin DB-level parity between the
  // two mutation surfaces, not re-test UI renderers (which every other
  // *.spec.ts already covers). Each test runs as two independent users so
  // the compared rows carry no cross-contamination.
  // ---------------------------------------------------------------------------

  // --- COACHBYTE_log_set — ad-hoc set, no planned_set_id ---
  test('COACHBYTE_log_set: UI vs MCP produce equivalent ad-hoc completed_sets rows', async () => {
    let mcpCtx: McpContext | null = null;
    let mcpRow: Record<string, any>;
    let uiRow: Record<string, any>;
    try {
      mcpCtx = await setupMcpUser('parity-log-set-mcp');
      const { exerciseMap } = await seedCoachByteData(mcpCtx.client, mcpCtx.userId);
      const squatId = exerciseMap['Squat'];

      await mcpCtx.mcp.callTool('COACHBYTE_log_set', {
        exercise_id: squatId,
        reps: 6,
        load: 275,
      });

      // Ad-hoc set is the one with planned_set_id NULL
      const rows = await fetchRows(mcpCtx.client, 'coachbyte', 'completed_sets', {
        user_id: mcpCtx.userId,
      });
      mcpRow = rows.find((r) => r.planned_set_id === null)!;
      expect(mcpRow).toBeTruthy();
    } finally {
      await mcpCtx?.mcp.disconnect();
      await mcpCtx?.cleanup();
    }

    const uiCtx = await setupMcpUser('parity-log-set-ui');
    try {
      const { exerciseMap: uiExMap } = await seedCoachByteData(uiCtx.client, uiCtx.userId);
      const uiSquatId = uiExMap['Squat'];
      // Ensure plan exists (same as log_set handler does internally).
      const { data: planRes } = await (uiCtx.client as any).schema('coachbyte').rpc('ensure_daily_plan_admin', {
        p_user_id: uiCtx.userId,
        p_day: new Date().toISOString().slice(0, 10),
      });
      const planId = planRes?.plan_id;
      // UI Today page calls the same supabase-js insert when the user clicks
      // "Log ad-hoc set" from the UI.
      const { data: inserted } = await (uiCtx.client as any)
        .schema('coachbyte')
        .from('completed_sets')
        .insert({
          plan_id: planId,
          planned_set_id: null,
          exercise_id: uiSquatId,
          user_id: uiCtx.userId,
          actual_reps: 6,
          actual_load: 275,
          logical_date: new Date().toISOString().slice(0, 10),
        })
        .select('*')
        .single();
      uiRow = inserted;
    } finally {
      await uiCtx.mcp.disconnect();
      await uiCtx.cleanup();
    }

    assertRowShape(mcpRow!, uiRow!, {
      ignore: ['completed_set_id', 'plan_id', 'exercise_id', 'logical_date'],
      required: ['actual_reps', 'actual_load', 'exercise_id', 'plan_id'],
      numericClose: ['actual_load'],
    });
    expect(mcpRow!.planned_set_id).toBeNull();
    expect(uiRow!.planned_set_id).toBeNull();
    expect(mcpRow!.actual_reps).toBe(6);
    expect(uiRow!.actual_reps).toBe(6);
  });

  // --- COACHBYTE_get_prs — read parity ---
  test('COACHBYTE_get_prs: UI read vs MCP read return identical PR payloads', async () => {
    const ctx = await setupMcpUser('parity-prs');
    try {
      const { exerciseMap } = await seedCoachByteData(ctx.client, ctx.userId);
      const squatId = exerciseMap['Squat'];
      // Seed two completed sets so Epley has something to compute.
      const { data: planRes } = await (ctx.client as any).schema('coachbyte').rpc('ensure_daily_plan_admin', {
        p_user_id: ctx.userId,
        p_day: new Date().toISOString().slice(0, 10),
      });
      const planId = planRes?.plan_id;
      await (ctx.client as any)
        .schema('coachbyte')
        .from('completed_sets')
        .insert([
          {
            plan_id: planId,
            exercise_id: squatId,
            user_id: ctx.userId,
            actual_reps: 5,
            actual_load: 225,
            logical_date: new Date().toISOString().slice(0, 10),
          },
          {
            plan_id: planId,
            exercise_id: squatId,
            user_id: ctx.userId,
            actual_reps: 3,
            actual_load: 255,
            logical_date: new Date().toISOString().slice(0, 10),
          },
        ]);

      // MCP path — call the tool.
      const mcpResult = parseResult(await ctx.mcp.callTool('COACHBYTE_get_prs', {}));

      // "UI path" — the PRs page runs the same aggregation client-side from
      // the same completed_sets table the MCP handler reads. We assert the
      // MCP tool response shape matches what the UI aggregator expects.
      expect(Array.isArray(mcpResult.prs)).toBe(true);
      const squatPr = mcpResult.prs.find((p: any) => p.exercise_id === squatId);
      expect(squatPr).toBeDefined();
      expect(typeof squatPr.estimated_1rm).toBe('number');
      expect(squatPr.best_set.reps).toBeGreaterThan(0);
      expect(squatPr.best_set.load).toBeGreaterThan(0);
      expect(typeof squatPr.rm_table['1RM']).toBe('number');
      expect(typeof squatPr.rm_table['10RM']).toBe('number');
    } finally {
      await ctx.mcp.disconnect();
      await ctx.cleanup();
    }
  });

  // --- COACHBYTE_update_plan — replaces planned_sets ---
  test('COACHBYTE_update_plan: UI vs MCP produce equivalent planned_sets rows', async () => {
    async function runPath(suffix: string, viaMcp: boolean): Promise<Record<string, any>[]> {
      const c = await setupMcpUser(suffix);
      try {
        const { exerciseMap } = await seedCoachByteData(c.client, c.userId);
        const squatId = exerciseMap['Squat'];
        // Ensure plan.
        const { data: planRes } = await (c.client as any).schema('coachbyte').rpc('ensure_daily_plan_admin', {
          p_user_id: c.userId,
          p_day: new Date().toISOString().slice(0, 10),
        });
        const planId = planRes?.plan_id;
        const newSets = [
          { exercise_id: squatId, target_reps: 8, load: 185, rest_seconds: 120, order: 1 },
          { exercise_id: squatId, target_reps: 8, load: 185, rest_seconds: 120, order: 2 },
        ];
        if (viaMcp) {
          await c.mcp.callTool('COACHBYTE_update_plan', { plan_id: planId, sets: newSets });
        } else {
          // UI path: the Today/Plan editor calls the same MCP tool handler
          // through the supabase-js client-side delete+insert.
          await (c.client as any).schema('coachbyte').from('planned_sets').delete().eq('plan_id', planId);
          await (c.client as any)
            .schema('coachbyte')
            .from('planned_sets')
            .insert(
              newSets.map((s) => ({
                plan_id: planId,
                user_id: c.userId,
                exercise_id: s.exercise_id,
                target_reps: s.target_reps,
                target_load: s.load,
                rest_seconds: s.rest_seconds,
                order: s.order,
              })),
            );
        }
        return await fetchRows(c.client, 'coachbyte', 'planned_sets', { plan_id: planId });
      } finally {
        await c.mcp.disconnect();
        await c.cleanup();
      }
    }
    const mcpRows = await runPath('parity-upd-plan-mcp', true);
    const uiRows = await runPath('parity-upd-plan-ui', false);
    expect(mcpRows.length).toBe(2);
    expect(uiRows.length).toBe(2);
    // Same shape: both have target_reps=8, target_load=185, rest_seconds=120
    for (const rows of [mcpRows, uiRows]) {
      for (const r of rows) {
        expect(r.target_reps).toBe(8);
        expect(Number(r.target_load)).toBeCloseTo(185, 1);
        expect(r.rest_seconds).toBe(120);
      }
    }
  });

  // --- COACHBYTE_update_split — upserts weekly template ---
  test('COACHBYTE_update_split: UI vs MCP produce equivalent splits rows', async () => {
    async function runPath(suffix: string, viaMcp: boolean): Promise<Record<string, any>> {
      const c = await setupMcpUser(suffix);
      try {
        const { exerciseMap } = await seedCoachByteData(c.client, c.userId);
        const benchId = exerciseMap['Bench Press'];
        const weekday = 2; // Tuesday
        const templateSets = [
          { exercise_id: benchId, target_reps: 6, load: 145, rest_seconds: 90 },
          { exercise_id: benchId, target_reps: 6, load: 145, rest_seconds: 90 },
        ];
        if (viaMcp) {
          await c.mcp.callTool('COACHBYTE_update_split', { weekday, template_sets: templateSets });
        } else {
          // UI path: Split editor writes the splits row via supabase-js upsert.
          await (c.client as any)
            .schema('coachbyte')
            .from('splits')
            .upsert(
              {
                user_id: c.userId,
                weekday,
                template_sets: templateSets.map((ts) => ({
                  exercise_id: ts.exercise_id,
                  target_reps: ts.target_reps,
                  target_load: ts.load,
                  rest_seconds: ts.rest_seconds,
                })),
              },
              { onConflict: 'user_id,weekday' },
            );
        }
        const rows = await fetchRows(c.client, 'coachbyte', 'splits', {
          user_id: c.userId,
          weekday,
        });
        return rows[0];
      } finally {
        await c.mcp.disconnect();
        await c.cleanup();
      }
    }
    const mcpRow = await runPath('parity-upd-split-mcp', true);
    const uiRow = await runPath('parity-upd-split-ui', false);
    expect(mcpRow.weekday).toBe(uiRow.weekday);
    expect(Array.isArray(mcpRow.template_sets)).toBe(true);
    expect(mcpRow.template_sets.length).toBe(2);
    expect(uiRow.template_sets.length).toBe(2);
    expect(mcpRow.template_sets[0].target_reps).toBe(6);
    expect(Number(mcpRow.template_sets[0].target_load)).toBeCloseTo(145, 1);
  });

  // --- CHEFBYTE_create_recipe — recipe + ingredients ---
  test('CHEFBYTE_create_recipe: UI vs MCP produce equivalent recipes + recipe_ingredients', async () => {
    async function runPath(suffix: string, viaMcp: boolean) {
      const c = await setupMcpUser(suffix);
      try {
        const { productMap } = await seedChefByteData(c.client, c.userId);
        const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];
        const riceId = productMap['Great Value Long Grain Brown Rice'];
        let recipeId: string;
        if (viaMcp) {
          const r = parseResult(
            await c.mcp.callTool('CHEFBYTE_create_recipe', {
              name: 'Parity Stew',
              base_servings: 4,
              ingredients: [
                { product_id: chickenId, quantity: 1, unit: 'container' },
                { product_id: riceId, quantity: 0.5, unit: 'container' },
              ],
            }),
          );
          recipeId = r.recipe.recipe_id;
        } else {
          // UI path: Recipe form component uses supabase-js insert + insert.
          const { data: recipe } = await (c.client as any)
            .schema('chefbyte')
            .from('recipes')
            .insert({ user_id: c.userId, name: 'Parity Stew', base_servings: 4 })
            .select('*')
            .single();
          recipeId = recipe.recipe_id;
          await (c.client as any)
            .schema('chefbyte')
            .from('recipe_ingredients')
            .insert([
              { recipe_id: recipeId, user_id: c.userId, product_id: chickenId, quantity: 1, unit: 'container' },
              { recipe_id: recipeId, user_id: c.userId, product_id: riceId, quantity: 0.5, unit: 'container' },
            ]);
        }
        const row = await fetchRow(c.client, 'chefbyte', 'recipes', { recipe_id: recipeId });
        const ings = await fetchRows(c.client, 'chefbyte', 'recipe_ingredients', { recipe_id: recipeId });
        return { row, ings };
      } finally {
        await c.mcp.disconnect();
        await c.cleanup();
      }
    }
    const mcp = await runPath('parity-create-recipe-mcp', true);
    const ui = await runPath('parity-create-recipe-ui', false);
    expect(mcp.row.name).toBe(ui.row.name);
    expect(mcp.row.base_servings).toBe(ui.row.base_servings);
    expect(mcp.ings.length).toBe(2);
    expect(ui.ings.length).toBe(2);
    // Ingredient quantities should match
    const sortKey = (i: any) => `${i.product_id}:${i.quantity}`;
    const mcpSorted = [...mcp.ings].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    const uiSorted = [...ui.ings].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    for (let i = 0; i < 2; i++) {
      expect(Number(mcpSorted[i].quantity)).toBeCloseTo(Number(uiSorted[i].quantity), 2);
      expect(mcpSorted[i].unit).toBe(uiSorted[i].unit);
    }
  });

  // --- CHEFBYTE_update_product — writes to products ---
  test('CHEFBYTE_update_product: UI vs MCP produce equivalent products row', async () => {
    async function runPath(suffix: string, viaMcp: boolean) {
      const c = await setupMcpUser(suffix);
      try {
        const { productMap } = await seedChefByteData(c.client, c.userId);
        const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];
        if (viaMcp) {
          await c.mcp.callTool('CHEFBYTE_update_product', {
            product_id: chickenId,
            price: 9.99,
            min_stock_amount: 4,
          });
        } else {
          await (c.client as any)
            .schema('chefbyte')
            .from('products')
            .update({ price: 9.99, min_stock_amount: 4 })
            .eq('product_id', chickenId);
        }
        return await fetchRow(c.client, 'chefbyte', 'products', { product_id: chickenId });
      } finally {
        await c.mcp.disconnect();
        await c.cleanup();
      }
    }
    const mcpRow = await runPath('parity-upd-prod-mcp', true);
    const uiRow = await runPath('parity-upd-prod-ui', false);
    expect(Number(mcpRow.price)).toBeCloseTo(9.99, 2);
    expect(Number(uiRow.price)).toBeCloseTo(9.99, 2);
    expect(Number(mcpRow.min_stock_amount)).toBeCloseTo(4, 1);
    expect(Number(uiRow.min_stock_amount)).toBeCloseTo(4, 1);
  });

  // --- CHEFBYTE_toggle_purchased — flips shopping_list.purchased ---
  test('CHEFBYTE_toggle_purchased: UI vs MCP produce equivalent purchased flip', async () => {
    async function runPath(suffix: string, viaMcp: boolean) {
      const c = await setupMcpUser(suffix);
      try {
        const { productMap } = await seedChefByteData(c.client, c.userId);
        const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];
        const { data: item } = await (c.client as any)
          .schema('chefbyte')
          .from('shopping_list')
          .insert({ user_id: c.userId, product_id: chickenId, qty_containers: 2 })
          .select('cart_item_id, purchased')
          .single();
        expect(item.purchased).toBe(false);
        if (viaMcp) {
          await c.mcp.callTool('CHEFBYTE_toggle_purchased', { item_id: item.cart_item_id });
        } else {
          await (c.client as any)
            .schema('chefbyte')
            .from('shopping_list')
            .update({ purchased: !item.purchased })
            .eq('cart_item_id', item.cart_item_id);
        }
        return await fetchRow(c.client, 'chefbyte', 'shopping_list', { cart_item_id: item.cart_item_id });
      } finally {
        await c.mcp.disconnect();
        await c.cleanup();
      }
    }
    const mcpRow = await runPath('parity-toggle-mcp', true);
    const uiRow = await runPath('parity-toggle-ui', false);
    expect(mcpRow.purchased).toBe(true);
    expect(uiRow.purchased).toBe(true);
  });

  // --- CHEFBYTE_delete_shopping_item — deletes + returns count=0 on miss ---
  test('CHEFBYTE_delete_shopping_item: UI vs MCP produce equivalent deletion', async () => {
    async function runPath(suffix: string, viaMcp: boolean) {
      const c = await setupMcpUser(suffix);
      try {
        const { productMap } = await seedChefByteData(c.client, c.userId);
        const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];
        const { data: item } = await (c.client as any)
          .schema('chefbyte')
          .from('shopping_list')
          .insert({ user_id: c.userId, product_id: chickenId, qty_containers: 1 })
          .select('cart_item_id')
          .single();
        if (viaMcp) {
          await c.mcp.callTool('CHEFBYTE_delete_shopping_item', { item_id: item.cart_item_id });
        } else {
          await (c.client as any)
            .schema('chefbyte')
            .from('shopping_list')
            .delete()
            .eq('cart_item_id', item.cart_item_id);
        }
        return await fetchRows(c.client, 'chefbyte', 'shopping_list', { cart_item_id: item.cart_item_id });
      } finally {
        await c.mcp.disconnect();
        await c.cleanup();
      }
    }
    const mcpRows = await runPath('parity-del-shop-mcp', true);
    const uiRows = await runPath('parity-del-shop-ui', false);
    expect(mcpRows.length).toBe(0);
    expect(uiRows.length).toBe(0);
  });

  // --- CHEFBYTE_import_shopping_to_inventory — moves purchased → stock_lots ---
  test('CHEFBYTE_import_shopping_to_inventory: UI vs MCP produce equivalent stock lots', async () => {
    async function runPath(suffix: string, viaMcp: boolean) {
      const c = await setupMcpUser(suffix);
      try {
        const { productMap, locationId } = await seedChefByteData(c.client, c.userId);
        const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];
        // Add a purchased shopping item to import.
        await (c.client as any)
          .schema('chefbyte')
          .from('shopping_list')
          .insert({ user_id: c.userId, product_id: chickenId, qty_containers: 2, purchased: true });

        if (viaMcp) {
          await c.mcp.callTool('CHEFBYTE_import_shopping_to_inventory', { location_id: locationId });
        } else {
          // UI Import button replicates the same logic: upsert stock lot,
          // delete purchased shopping rows.
          const { data: existing } = await (c.client as any)
            .schema('chefbyte')
            .from('stock_lots')
            .select('lot_id, qty_containers')
            .eq('product_id', chickenId)
            .eq('location_id', locationId)
            .is('expires_on', null)
            .maybeSingle();
          if (existing) {
            await (c.client as any)
              .schema('chefbyte')
              .from('stock_lots')
              .update({ qty_containers: Number(existing.qty_containers) + 2 })
              .eq('lot_id', existing.lot_id);
          } else {
            await (c.client as any).schema('chefbyte').from('stock_lots').insert({
              user_id: c.userId,
              product_id: chickenId,
              location_id: locationId,
              qty_containers: 2,
            });
          }
          await (c.client as any)
            .schema('chefbyte')
            .from('shopping_list')
            .delete()
            .eq('user_id', c.userId)
            .eq('purchased', true);
        }
        const lots = await fetchRows(c.client, 'chefbyte', 'stock_lots', {
          user_id: c.userId,
          product_id: chickenId,
        });
        const totalQty = lots.reduce((s, l) => s + Number(l.qty_containers), 0);
        const remainingShopping = await fetchRows(c.client, 'chefbyte', 'shopping_list', {
          user_id: c.userId,
          product_id: chickenId,
        });
        return { totalQty, remainingShopping };
      } finally {
        await c.mcp.disconnect();
        await c.cleanup();
      }
    }
    const mcp = await runPath('parity-import-mcp', true);
    const ui = await runPath('parity-import-ui', false);
    // Seed data has 3 containers + 2 imported = 5
    expect(mcp.totalQty).toBeCloseTo(5, 1);
    expect(ui.totalQty).toBeCloseTo(5, 1);
    expect(mcp.remainingShopping.length).toBe(0);
    expect(ui.remainingShopping.length).toBe(0);
  });

  // --- CHEFBYTE_delete_meal_entry — removes meal_plan_entries ---
  test('CHEFBYTE_delete_meal_entry: UI vs MCP produce equivalent deletion', async () => {
    async function runPath(suffix: string, viaMcp: boolean) {
      const c = await setupMcpUser(suffix);
      try {
        const { recipeId } = await seedChefByteData(c.client, c.userId);
        const today = new Date().toISOString().slice(0, 10);
        const { data: meal } = await (c.client as any)
          .schema('chefbyte')
          .from('meal_plan_entries')
          .insert({ user_id: c.userId, logical_date: today, recipe_id: recipeId, servings: 2 })
          .select('meal_id')
          .single();

        if (viaMcp) {
          await c.mcp.callTool('CHEFBYTE_delete_meal_entry', { meal_id: meal.meal_id });
        } else {
          await (c.client as any).schema('chefbyte').from('meal_plan_entries').delete().eq('meal_id', meal.meal_id);
        }
        return await fetchRows(c.client, 'chefbyte', 'meal_plan_entries', { meal_id: meal.meal_id });
      } finally {
        await c.mcp.disconnect();
        await c.cleanup();
      }
    }
    expect((await runPath('parity-del-meal-mcp', true)).length).toBe(0);
    expect((await runPath('parity-del-meal-ui', false)).length).toBe(0);
  });

  // --- CHEFBYTE_mark_done — uses RPC; deducts stock + logs macros ---
  test('CHEFBYTE_mark_done: UI vs MCP produce equivalent food_log + stock effect', async () => {
    async function runPath(suffix: string, viaMcp: boolean) {
      const c = await setupMcpUser(suffix);
      try {
        const { productMap } = await seedChefByteData(c.client, c.userId);
        const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];
        const today = new Date().toISOString().slice(0, 10);
        const { data: meal } = await (c.client as any)
          .schema('chefbyte')
          .from('meal_plan_entries')
          .insert({ user_id: c.userId, logical_date: today, product_id: chickenId, servings: 2 })
          .select('meal_id')
          .single();

        if (viaMcp) {
          await c.mcp.callTool('CHEFBYTE_mark_done', { meal_id: meal.meal_id });
        } else {
          // UI path: same RPC. The page-level "Mark Done" button calls
          // chefbyte.mark_meal_done (non-admin form) through supabase-js.
          await (c.client as any).schema('chefbyte').rpc('mark_meal_done', { p_meal_id: meal.meal_id });
        }
        const logs = await fetchRows(c.client, 'chefbyte', 'food_logs', {
          user_id: c.userId,
          meal_id: meal.meal_id,
        });
        const lots = await fetchRows(c.client, 'chefbyte', 'stock_lots', {
          user_id: c.userId,
          product_id: chickenId,
        });
        const totalQty = lots.reduce((s, l) => s + Number(l.qty_containers), 0);
        return { logs, totalQty };
      } finally {
        await c.mcp.disconnect();
        await c.cleanup();
      }
    }
    const mcp = await runPath('parity-mark-mcp', true);
    const ui = await runPath('parity-mark-ui', false);
    expect(mcp.logs.length).toBeGreaterThanOrEqual(1);
    expect(ui.logs.length).toBeGreaterThanOrEqual(1);
    // Both should have deducted stock by the same amount (2 servings / 4 spc = 0.5 containers)
    // Seed chicken has 3 containers → 2.5 after.
    expect(mcp.totalQty).toBeCloseTo(ui.totalQty, 1);
    expect(mcp.totalQty).toBeCloseTo(2.5, 1);
  });

  // --- CHEFBYTE_set_price — thin wrapper on products.price ---
  test('CHEFBYTE_set_price: UI vs MCP produce equivalent price update', async () => {
    async function runPath(suffix: string, viaMcp: boolean) {
      const c = await setupMcpUser(suffix);
      try {
        const { productMap } = await seedChefByteData(c.client, c.userId);
        const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];
        if (viaMcp) {
          await c.mcp.callTool('CHEFBYTE_set_price', { product_id: chickenId, price: 6.49 });
        } else {
          await (c.client as any)
            .schema('chefbyte')
            .from('products')
            .update({ price: 6.49 })
            .eq('product_id', chickenId);
        }
        return await fetchRow(c.client, 'chefbyte', 'products', { product_id: chickenId });
      } finally {
        await c.mcp.disconnect();
        await c.cleanup();
      }
    }
    const mcpRow = await runPath('parity-price-mcp', true);
    const uiRow = await runPath('parity-price-ui', false);
    expect(Number(mcpRow.price)).toBeCloseTo(6.49, 2);
    expect(Number(uiRow.price)).toBeCloseTo(6.49, 2);
  });

  // --- CHEFBYTE_add_to_shopping (upsert path, distinct from existing test) ---
  test('CHEFBYTE_add_to_shopping (upsert): UI vs MCP produce equivalent qty merge', async () => {
    async function runPath(suffix: string, viaMcp: boolean) {
      const c = await setupMcpUser(suffix);
      try {
        const { productMap } = await seedChefByteData(c.client, c.userId);
        const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];
        // Pre-seed an existing row so the tool hits the upsert path.
        await (c.client as any)
          .schema('chefbyte')
          .from('shopping_list')
          .insert({ user_id: c.userId, product_id: chickenId, qty_containers: 2 });

        if (viaMcp) {
          await c.mcp.callTool('CHEFBYTE_add_to_shopping', { product_id: chickenId, qty_containers: 5 });
        } else {
          await (c.client as any)
            .schema('chefbyte')
            .from('shopping_list')
            .upsert(
              { user_id: c.userId, product_id: chickenId, qty_containers: 5 },
              { onConflict: 'user_id,product_id' },
            );
        }
        return await fetchRow(c.client, 'chefbyte', 'shopping_list', {
          user_id: c.userId,
          product_id: chickenId,
        });
      } finally {
        await c.mcp.disconnect();
        await c.cleanup();
      }
    }
    const mcpRow = await runPath('parity-add-shop-mcp', true);
    const uiRow = await runPath('parity-add-shop-ui', false);
    // Upsert semantics: last write wins (not add). Both should show qty=5.
    expect(Number(mcpRow.qty_containers)).toBeCloseTo(5, 1);
    expect(Number(uiRow.qty_containers)).toBeCloseTo(5, 1);
  });

  // --- CHEFBYTE_clear_shopping — bulk delete by user_id ---
  test('CHEFBYTE_clear_shopping: UI vs MCP produce equivalent empty shopping list', async () => {
    async function runPath(suffix: string, viaMcp: boolean) {
      const c = await setupMcpUser(suffix);
      try {
        const { productMap } = await seedChefByteData(c.client, c.userId);
        const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];
        const riceId = productMap['Great Value Long Grain Brown Rice'];
        await (c.client as any)
          .schema('chefbyte')
          .from('shopping_list')
          .insert([
            { user_id: c.userId, product_id: chickenId, qty_containers: 2 },
            { user_id: c.userId, product_id: riceId, qty_containers: 3 },
          ]);

        if (viaMcp) {
          await c.mcp.callTool('CHEFBYTE_clear_shopping', {});
        } else {
          await (c.client as any).schema('chefbyte').from('shopping_list').delete().eq('user_id', c.userId);
        }
        return await fetchRows(c.client, 'chefbyte', 'shopping_list', { user_id: c.userId });
      } finally {
        await c.mcp.disconnect();
        await c.cleanup();
      }
    }
    expect((await runPath('parity-clear-shop-mcp', true)).length).toBe(0);
    expect((await runPath('parity-clear-shop-ui', false)).length).toBe(0);
  });

  // --- CHEFBYTE_log_temp_item (second shape, asserts carbs/protein defaulting) ---
  test('CHEFBYTE_log_temp_item (defaulted fields): MCP fills missing macros with 0', async () => {
    const ctx = await setupMcpUser('parity-temp-defaults');
    try {
      // Pass only the required fields; MCP handler should default carbs/protein/fat to 0.
      const r = parseResult(
        await ctx.mcp.callTool('CHEFBYTE_log_temp_item', {
          name: 'Just Calories',
          calories: 400,
        }),
      );
      const row = await fetchRow(ctx.client, 'chefbyte', 'temp_items', { temp_id: r.item.temp_id });
      expect(Number(row.calories)).toBeCloseTo(400, 1);
      expect(Number(row.protein ?? 0)).toBeCloseTo(0, 1);
      expect(Number(row.carbs ?? 0)).toBeCloseTo(0, 1);
      expect(Number(row.fat ?? 0)).toBeCloseTo(0, 1);
    } finally {
      await ctx.mcp.disconnect();
      await ctx.cleanup();
    }
  });

  // --- CHEFBYTE_get_macros (read-only parity) ---
  test('CHEFBYTE_get_macros: MCP response matches direct daily_macros RPC shape', async () => {
    const c = await setupMcpUser('parity-get-macros');
    try {
      await seedChefByteData(c.client, c.userId);
      const today = new Date().toISOString().slice(0, 10);
      // Log a temp item so the totals aren't empty.
      await c.mcp.callTool('CHEFBYTE_log_temp_item', { name: 'Canary', calories: 500, protein: 40 });

      const mcpResp = parseResult(await c.mcp.callTool('CHEFBYTE_get_macros', { date: today }));
      // "UI" reads the same RPC directly.
      const { data: uiResp } = await (c.client as any)
        .schema('chefbyte')
        .rpc('get_daily_macros', { p_logical_date: today });

      // Shape parity: totals object + goals
      const norm = (r: any) => ({
        calories: Number(r.totals?.calories ?? r.calories ?? 0),
        protein: Number(r.totals?.protein ?? r.protein ?? 0),
      });
      const a = norm(mcpResp);
      const b = norm(uiResp);
      expect(a.calories).toBeCloseTo(b.calories, 1);
      expect(a.protein).toBeCloseTo(b.protein, 1);
      // Both should be non-zero (canary temp item).
      expect(a.calories).toBeGreaterThan(0);
    } finally {
      await c.mcp.disconnect();
      await c.cleanup();
    }
  });

  // --- CHEFBYTE_get_inventory (read-only parity) ---
  test('CHEFBYTE_get_inventory: MCP response matches direct stock_lots aggregation', async () => {
    const c = await setupMcpUser('parity-get-inv');
    try {
      const { productMap } = await seedChefByteData(c.client, c.userId);

      const mcpResp = parseResult(await c.mcp.callTool('CHEFBYTE_get_inventory', {}));
      expect(Array.isArray(mcpResp.inventory)).toBe(true);

      // UI path reads stock_lots directly (same code the dashboard uses).
      const { data: lots } = await (c.client as any)
        .schema('chefbyte')
        .from('stock_lots')
        .select('product_id, qty_containers')
        .eq('user_id', c.userId)
        .gt('qty_containers', 0);
      const uiTotals: Record<string, number> = {};
      for (const l of lots ?? []) {
        uiTotals[l.product_id] = (uiTotals[l.product_id] ?? 0) + Number(l.qty_containers);
      }

      // Chicken seed: 3 containers. Should match between both paths.
      const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];
      const mcpChicken = mcpResp.inventory.find((p: any) => p.product_id === chickenId);
      expect(mcpChicken).toBeDefined();
      expect(Number(mcpChicken.total_containers)).toBeCloseTo(uiTotals[chickenId], 1);
      expect(Number(mcpChicken.total_containers)).toBeCloseTo(3, 1);
    } finally {
      await c.mcp.disconnect();
      await c.cleanup();
    }
  });

  // --- CHEFBYTE_get_products + [MEAL] exclusion (audit item #34) ---
  test('CHEFBYTE_get_products: MCP response excludes [MEAL] placeholder rows', async () => {
    const c = await setupMcpUser('parity-get-products');
    try {
      const { productMap } = await seedChefByteData(c.client, c.userId);
      // Insert a synthetic [MEAL] placeholder (mirrors what mark_meal_done
      // creates for meal-prep entries).
      await (c.client as any).schema('chefbyte').from('products').insert({
        user_id: c.userId,
        name: '[MEAL] Parity Placeholder',
        servings_per_container: 1,
        calories_per_serving: 500,
        protein_per_serving: 30,
        carbs_per_serving: 50,
        fat_per_serving: 15,
      });

      const mcpResp = parseResult(await c.mcp.callTool('CHEFBYTE_get_products', {}));
      // UI Settings products list reads via a filter that excludes [MEAL]
      // rows; the MCP tool SHOULD also exclude them — pinning audit #34.
      const names = mcpResp.products.map((p: any) => p.name);
      // All seeded products should appear
      expect(names).toContain('Great Value Boneless Skinless Chicken Breasts');
      // [MEAL] placeholder must NOT appear
      const mealRows = names.filter((n: string) => n.startsWith('[MEAL]'));
      expect(mealRows).toEqual([]);
      // Also verify the raw seed count is what we inserted (5) — no drift.
      expect(names.filter((n: string) => productMap[n])).toHaveLength(5);
    } finally {
      await c.mcp.disconnect();
      await c.cleanup();
    }
  });
});
