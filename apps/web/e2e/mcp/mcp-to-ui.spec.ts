import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedChefByteData, seedCoachByteData } from '../helpers/seed';
import { generateTestApiKey, McpE2EClient } from '../helpers/mcp-client';

test.describe('MCP-to-UI E2E', () => {
  test('MCP creates product and adds stock, inventory shows it', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'mcp-inventory');
    let mcp: McpE2EClient | null = null;
    try {
      // Seed ChefByte data so the page structure is ready
      await seedChefByteData(client, userId);

      const apiKey = await generateTestApiKey(userId);
      mcp = new McpE2EClient();
      await mcp.connect(apiKey);
      await mcp.initialize();

      // Create a unique product via MCP
      const createResult = await mcp.callTool('CHEFBYTE_create_product', {
        name: 'MCP Test Almonds',
        servings_per_container: 10,
        calories_per_serving: 160,
        protein_per_serving: 6,
        carbs_per_serving: 6,
        fat_per_serving: 14,
      });
      // Parse the result content
      const createData = JSON.parse(createResult.content[0].text);
      const productId = createData.product.product_id;

      // Add stock via MCP
      await mcp.callTool('CHEFBYTE_add_stock', {
        product_id: productId,
        qty_containers: 5,
      });

      await mcp.disconnect();
      mcp = null;

      // Navigate to inventory page
      await page.goto('/chef/inventory');

      // Verify the MCP-created product appears in inventory
      await expect(page.getByText('MCP Test Almonds')).toBeVisible({ timeout: 30000 });
    } finally {
      await mcp?.disconnect();
      await cleanup();
    }
  });

  test('MCP completes workout set, Today page shows it', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'mcp-coach');
    let mcp: McpE2EClient | null = null;
    try {
      await seedCoachByteData(client, userId);

      const apiKey = await generateTestApiKey(userId);
      mcp = new McpE2EClient();
      await mcp.connect(apiKey);
      await mcp.initialize();

      // Get today's plan (creates it from split via ensure_daily_plan)
      const planResult = await mcp.callTool('COACHBYTE_get_today_plan', {});
      const planData = JSON.parse(planResult.content[0].text);
      const planId = planData.plan_id;

      // Complete the first set
      await mcp.callTool('COACHBYTE_complete_next_set', {
        plan_id: planId,
        reps: 5,
        load: 225,
      });

      await mcp.disconnect();
      mcp = null;

      // Navigate to Today page
      await page.goto('/coach');

      // Verify the completed set row is visible
      await expect(page.getByTestId('completed-row-1')).toBeVisible({ timeout: 30000 });
    } finally {
      await mcp?.disconnect();
      await cleanup();
    }
  });

  test('MCP adds to shopping list, Shopping page shows it', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'mcp-shop');
    let mcp: McpE2EClient | null = null;
    try {
      const { productMap } = await seedChefByteData(client, userId);

      const apiKey = await generateTestApiKey(userId);
      mcp = new McpE2EClient();
      await mcp.connect(apiKey);
      await mcp.initialize();

      // Add Chicken Breast to shopping list via MCP
      await mcp.callTool('CHEFBYTE_add_to_shopping', {
        product_id: productMap['Great Value Boneless Skinless Chicken Breasts'],
        qty_containers: 3,
      });

      await mcp.disconnect();
      mcp = null;

      // Navigate to Shopping page
      await page.goto('/chef/shopping');

      // Verify Chicken Breast appears in the shopping list
      await expect(page.getByText('Great Value Boneless Skinless Chicken Breasts')).toBeVisible({ timeout: 30000 });
    } finally {
      await mcp?.disconnect();
      await cleanup();
    }
  });
});
