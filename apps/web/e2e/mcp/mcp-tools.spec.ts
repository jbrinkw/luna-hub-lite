import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  seedUser,
  seedChefByteData,
  seedCoachByteData,
  seedMealEntry,
  seedCompletedSet,
  seedShoppingItems,
  todayStr,
  signInWithRetry,
} from '../helpers/seed';
import { generateTestApiKey, McpE2EClient } from '../helpers/mcp-client';
import { SUPABASE_URL, ANON_KEY } from '../helpers/constants';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface TestContext {
  userId: string;
  email: string;
  password: string;
  cleanup: () => Promise<void>;
  client: SupabaseClient;
  mcp: McpE2EClient;
}

/**
 * Creates a test user with both modules activated, an authenticated Supabase
 * client, and an initialized MCP SSE connection. Callers must call
 * ctx.mcp.disconnect() and ctx.cleanup() in a finally block.
 */
async function setupMcpUser(suffix: string): Promise<TestContext> {
  const { userId, email, password, cleanup } = await seedUser(suffix);

  // Authenticated client for seeding / verification
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

  // Generate API key and connect MCP client
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

/** Assert an MCP result has isError: true and the text contains a substring. */
function expectError(result: any, substring?: string) {
  expect(result.isError).toBe(true);
  if (substring) {
    expect(result.content[0].text).toContain(substring);
  }
}

// ---------------------------------------------------------------------------
// ChefByte MCP tool tests
// ---------------------------------------------------------------------------

test.describe('MCP Tools — ChefByte', () => {
  test('CHEFBYTE_get_products returns all seeded products', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-products');
      await seedChefByteData(ctx.client, ctx.userId);

      const result = await ctx.mcp.callTool('CHEFBYTE_get_products', {});
      const data = parseResult(result);

      expect(data.total).toBe(5);
      const names = data.products.map((p: any) => p.name);
      expect(names).toContain('Great Value Boneless Skinless Chicken Breasts');
      expect(names).toContain('Great Value Long Grain Brown Rice');
      expect(names).toContain('Great Value Large White Eggs');
      expect(names).toContain('Birds Eye Sweet Peas');
      expect(names).toContain('Banquet Chicken Breast Patties');

      // Verify nutritional data is returned
      const chicken = data.products.find((p: any) => p.name === 'Great Value Boneless Skinless Chicken Breasts');
      expect(chicken.calories_per_serving).toBe(165);
      expect(chicken.protein_per_serving).toBe(31);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_consume reduces stock and logs macros', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-consume');
      const { productMap } = await seedChefByteData(ctx.client, ctx.userId);

      const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];

      // Get stock before consuming
      const chef = (ctx.client as any).schema('chefbyte');
      const { data: lotsBefore } = await chef
        .from('stock_lots')
        .select('qty_containers')
        .eq('product_id', chickenId)
        .gt('qty_containers', 0);
      const stockBefore = lotsBefore.reduce((sum: number, l: any) => sum + Number(l.qty_containers), 0);

      // Consume 1 container via MCP
      const result = await ctx.mcp.callTool('CHEFBYTE_consume', {
        product_id: chickenId,
        qty: 1,
        unit: 'container',
      });
      const data = parseResult(result);
      expect(data).toBeTruthy();

      // Verify stock decreased
      const { data: lotsAfter } = await chef
        .from('stock_lots')
        .select('qty_containers')
        .eq('product_id', chickenId)
        .gte('qty_containers', 0);
      const stockAfter = lotsAfter.reduce((sum: number, l: any) => sum + Number(l.qty_containers), 0);
      expect(stockAfter).toBeLessThan(stockBefore);

      // Verify macro log was created
      const today = todayStr();
      const { data: logs } = await chef
        .from('food_logs')
        .select('product_id, qty_consumed, unit')
        .eq('user_id', ctx.userId)
        .eq('logical_date', today);
      expect(logs!.length).toBeGreaterThanOrEqual(1);
      const chickenLog = logs!.find((l: any) => l.product_id === chickenId);
      expect(chickenLog).toBeTruthy();
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_get_macros returns daily totals after consuming', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-macros');
      const { productMap } = await seedChefByteData(ctx.client, ctx.userId);

      // Consume 1 container of Chicken Breast (4 servings x 165 cal = 660 cal)
      await ctx.mcp.callTool('CHEFBYTE_consume', {
        product_id: productMap['Great Value Boneless Skinless Chicken Breasts'],
        qty: 1,
        unit: 'container',
      });

      // Get macros for today
      const result = await ctx.mcp.callTool('CHEFBYTE_get_macros', {});
      const data = parseResult(result);

      // The RPC returns nested objects: { calories: { consumed, goal, remaining }, ... }
      expect(Number(data.calories.consumed)).toBeGreaterThan(0);
      expect(Number(data.protein.consumed)).toBeGreaterThan(0);
      // Goals should be set from the seed data
      expect(Number(data.calories.goal)).toBe(2200);
      expect(Number(data.protein.goal)).toBe(180);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_create_recipe with ingredients', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-recipe');
      const { productMap } = await seedChefByteData(ctx.client, ctx.userId);

      const result = await ctx.mcp.callTool('CHEFBYTE_create_recipe', {
        name: 'MCP Protein Bowl',
        description: 'High protein post-workout meal',
        base_servings: 1,
        ingredients: [
          { product_id: productMap['Great Value Boneless Skinless Chicken Breasts'], quantity: 0.5, unit: 'container' },
          { product_id: productMap['Great Value Long Grain Brown Rice'], quantity: 0.25, unit: 'container' },
          { product_id: productMap['Great Value Large White Eggs'], quantity: 3, unit: 'serving' },
        ],
      });
      const data = parseResult(result);

      expect(data.message).toContain('MCP Protein Bowl');
      expect(data.message).toContain('3 ingredient');
      expect(data.recipe.recipe_id).toBeTruthy();
      expect(data.recipe.name).toBe('MCP Protein Bowl');

      // Verify in DB
      const chef = (ctx.client as any).schema('chefbyte');
      const { data: ingredients } = await chef
        .from('recipe_ingredients')
        .select('product_id, quantity, unit')
        .eq('recipe_id', data.recipe.recipe_id);
      expect(ingredients!.length).toBe(3);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_get_meal_plan returns week with seeded entries', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-mealplan');
      const { recipeId } = await seedChefByteData(ctx.client, ctx.userId);

      const today = todayStr();
      await seedMealEntry(ctx.client, ctx.userId, recipeId, today, {
        servings: 2,
        mealType: 'lunch',
      });

      // Query meal plan via MCP for the current week
      const result = await ctx.mcp.callTool('CHEFBYTE_get_meal_plan', {
        start_date: today,
        end_date: today,
      });
      const data = parseResult(result);

      expect(data.total).toBeGreaterThanOrEqual(1);
      const entry = data.entries.find((e: any) => e.recipe_name === 'Chicken & Rice');
      expect(entry).toBeTruthy();
      expect(Number(entry.servings)).toBe(2);
      expect(entry.logical_date).toBe(today);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_below_min_stock identifies low-stock products', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-minstock');
      await seedChefByteData(ctx.client, ctx.userId);

      // Bananas has qty=0 and min_stock=3, Eggs has qty=0.5 and min_stock=1,
      // Protein Powder has qty=0.5 and min_stock=0.5 (exactly at min)
      const result = await ctx.mcp.callTool('CHEFBYTE_below_min_stock', {});
      const data = parseResult(result);

      expect(data.total).toBeGreaterThanOrEqual(1);
      const names = data.below_min.map((item: any) => item.product_name);
      // Bananas: stock=0, min=3 -> definitely below
      expect(names).toContain('Banquet Chicken Breast Patties');
      // Eggs: stock=0.5, min=1 -> below
      expect(names).toContain('Great Value Large White Eggs');

      // Each below-min item should have deficit info
      const bananas = data.below_min.find((item: any) => item.product_name === 'Banquet Chicken Breast Patties');
      expect(bananas.deficit).toBeGreaterThan(0);
      expect(bananas.current_stock).toBe(0);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_delete_meal_entry removes entry', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-delmeal');
      const { recipeId } = await seedChefByteData(ctx.client, ctx.userId);

      const today = todayStr();
      const mealId = await seedMealEntry(ctx.client, ctx.userId, recipeId, today);

      // Verify entry exists
      const chef = (ctx.client as any).schema('chefbyte');
      const { data: before } = await chef.from('meal_plan_entries').select('meal_id').eq('meal_id', mealId);
      expect(before!.length).toBe(1);

      // Delete via MCP
      const result = await ctx.mcp.callTool('CHEFBYTE_delete_meal_entry', {
        meal_id: mealId,
      });
      const data = parseResult(result);
      expect(data.message).toContain('deleted');
      expect(data.meal_id).toBe(mealId);

      // Verify deletion in DB
      const { data: after } = await chef.from('meal_plan_entries').select('meal_id').eq('meal_id', mealId);
      expect(after!.length).toBe(0);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_update_product changes product fields', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-update');
      const { productMap } = await seedChefByteData(ctx.client, ctx.userId);

      const riceId = productMap['Great Value Long Grain Brown Rice'];

      const result = await ctx.mcp.callTool('CHEFBYTE_update_product', {
        product_id: riceId,
        name: 'White Rice',
        calories_per_serving: 200,
        price: 3.99,
      });
      const data = parseResult(result);

      expect(data.message).toContain('White Rice');
      expect(data.product.product_id).toBe(riceId);
      expect(data.product.name).toBe('White Rice');

      // Verify in DB
      const chef = (ctx.client as any).schema('chefbyte');
      const { data: updated } = await chef
        .from('products')
        .select('name, calories_per_serving, price')
        .eq('product_id', riceId)
        .single();
      expect(updated.name).toBe('White Rice');
      expect(Number(updated.calories_per_serving)).toBe(200);
      expect(Number(updated.price)).toBeCloseTo(3.99, 1);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_get_shopping_list returns shopping items', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-shoplist');
      const { productMap } = await seedChefByteData(ctx.client, ctx.userId);

      // Seed 2 shopping items
      await seedShoppingItems(ctx.client, ctx.userId, [
        { productId: productMap['Great Value Boneless Skinless Chicken Breasts'], qtyContainers: 2 },
        { productId: productMap['Great Value Long Grain Brown Rice'], qtyContainers: 1 },
      ]);

      const result = await ctx.mcp.callTool('CHEFBYTE_get_shopping_list', {});
      const data = parseResult(result);

      expect(data.total_items).toBe(2);
      const names = data.items.map((i: any) => i.product_name);
      expect(names).toContain('Great Value Boneless Skinless Chicken Breasts');
      expect(names).toContain('Great Value Long Grain Brown Rice');

      // Verify item structure
      const chicken = data.items.find((i: any) => i.product_name === 'Great Value Boneless Skinless Chicken Breasts');
      expect(chicken.product_id).toBe(productMap['Great Value Boneless Skinless Chicken Breasts']);
      expect(chicken.qty_containers).toBe(2);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_clear_shopping removes all items', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-clearshop');
      const { productMap } = await seedChefByteData(ctx.client, ctx.userId);

      // Seed shopping items
      await seedShoppingItems(ctx.client, ctx.userId, [
        { productId: productMap['Great Value Large White Eggs'], qtyContainers: 1 },
        { productId: productMap['Banquet Chicken Breast Patties'], qtyContainers: 5 },
      ]);

      // Verify items exist before clearing
      const chef = (ctx.client as any).schema('chefbyte');
      const { data: before } = await chef.from('shopping_list').select('cart_item_id').eq('user_id', ctx.userId);
      expect(before!.length).toBe(2);

      // Clear via MCP
      const result = await ctx.mcp.callTool('CHEFBYTE_clear_shopping', {});
      const data = parseResult(result);
      expect(data.message).toContain('cleared');

      // Verify all items are gone
      const { data: after } = await chef.from('shopping_list').select('cart_item_id').eq('user_id', ctx.userId);
      expect(after!.length).toBe(0);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_set_price updates product price', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-setprice');
      const { productMap } = await seedChefByteData(ctx.client, ctx.userId);

      const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];

      const result = await ctx.mcp.callTool('CHEFBYTE_set_price', {
        product_id: chickenId,
        price: 8.49,
      });
      const data = parseResult(result);

      expect(data.message).toContain('Great Value Boneless Skinless Chicken Breasts');
      expect(data.message).toContain('$8.49');
      expect(data.product.product_id).toBe(chickenId);
      expect(Number(data.product.price)).toBeCloseTo(8.49, 2);

      // Verify in DB
      const chef = (ctx.client as any).schema('chefbyte');
      const { data: product } = await chef.from('products').select('price').eq('product_id', chickenId).single();
      expect(Number(product.price)).toBeCloseTo(8.49, 2);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_toggle_purchased toggles purchased flag', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-toggle');
      const { productMap } = await seedChefByteData(ctx.client, ctx.userId);

      // Seed an unpurchased item
      const [itemId] = await seedShoppingItems(ctx.client, ctx.userId, [
        { productId: productMap['Birds Eye Sweet Peas'], qtyContainers: 1, purchased: false },
      ]);

      // Toggle to purchased
      const result1 = await ctx.mcp.callTool('CHEFBYTE_toggle_purchased', {
        item_id: itemId,
      });
      const data1 = parseResult(result1);
      expect(data1.item.purchased).toBe(true);
      expect(data1.message).toContain('purchased');

      // Toggle back to not purchased
      const result2 = await ctx.mcp.callTool('CHEFBYTE_toggle_purchased', {
        item_id: itemId,
      });
      const data2 = parseResult(result2);
      expect(data2.item.purchased).toBe(false);
      expect(data2.message).toContain('not purchased');
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_delete_shopping_item removes single item', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-delshop');
      const { productMap } = await seedChefByteData(ctx.client, ctx.userId);

      // Seed 2 items
      const [itemId1, itemId2] = await seedShoppingItems(ctx.client, ctx.userId, [
        { productId: productMap['Great Value Boneless Skinless Chicken Breasts'], qtyContainers: 2 },
        { productId: productMap['Great Value Large White Eggs'], qtyContainers: 1 },
      ]);

      // Delete the first item
      const result = await ctx.mcp.callTool('CHEFBYTE_delete_shopping_item', {
        item_id: itemId1,
      });
      const data = parseResult(result);
      expect(data.message).toContain('deleted');
      expect(data.item_id).toBe(itemId1);

      // Verify only the second item remains
      const chef = (ctx.client as any).schema('chefbyte');
      const { data: remaining } = await chef.from('shopping_list').select('cart_item_id').eq('user_id', ctx.userId);
      expect(remaining!.length).toBe(1);
      expect(remaining![0].cart_item_id).toBe(itemId2);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_import_shopping_to_inventory creates stock lots from purchased items', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-import');
      const { productMap, locationId } = await seedChefByteData(ctx.client, ctx.userId);

      const chef = (ctx.client as any).schema('chefbyte');

      // Seed shopping items: 1 purchased, 1 not purchased
      await seedShoppingItems(ctx.client, ctx.userId, [
        { productId: productMap['Banquet Chicken Breast Patties'], qtyContainers: 3, purchased: true },
        { productId: productMap['Birds Eye Sweet Peas'], qtyContainers: 1, purchased: false },
      ]);

      // Get stock before import
      const { data: lotsBefore } = await chef
        .from('stock_lots')
        .select('lot_id')
        .eq('product_id', productMap['Banquet Chicken Breast Patties'])
        .eq('user_id', ctx.userId);
      const countBefore = lotsBefore!.length;

      // Import via MCP (uses the Fridge location)
      const result = await ctx.mcp.callTool('CHEFBYTE_import_shopping_to_inventory', {
        location_id: locationId,
      });
      const data = parseResult(result);

      expect(data.lots_created).toBe(1); // Only the purchased Bananas
      expect(data.lots.length).toBe(1);
      expect(data.lots[0].product_id).toBe(productMap['Banquet Chicken Breast Patties']);
      expect(data.lots[0].qty_containers).toBe(3);

      // Verify new stock lot was created
      const { data: lotsAfter } = await chef
        .from('stock_lots')
        .select('lot_id')
        .eq('product_id', productMap['Banquet Chicken Breast Patties'])
        .eq('user_id', ctx.userId);
      expect(lotsAfter!.length).toBe(countBefore + 1);

      // Verify purchased items were removed from shopping list
      const { data: shopAfter } = await chef
        .from('shopping_list')
        .select('cart_item_id, purchased')
        .eq('user_id', ctx.userId);
      expect(shopAfter!.length).toBe(1); // Only the unpurchased Protein Powder remains
      expect(shopAfter![0].purchased).toBe(false);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_get_recipes returns recipes with ingredients', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-recipes');
      await seedChefByteData(ctx.client, ctx.userId);

      const result = await ctx.mcp.callTool('CHEFBYTE_get_recipes', {});
      const data = parseResult(result);

      expect(data.total).toBeGreaterThanOrEqual(1);
      const recipe = data.recipes.find((r: any) => r.name === 'Chicken & Rice');
      expect(recipe).toBeTruthy();
      expect(recipe.recipe_id).toBeTruthy();
      expect(recipe.base_servings).toBe(2);
      expect(recipe.ingredients.length).toBe(2);

      // Verify ingredient structure includes product names and macros
      const chickenIngredient = recipe.ingredients.find(
        (i: any) => i.product_name === 'Great Value Boneless Skinless Chicken Breasts',
      );
      expect(chickenIngredient).toBeTruthy();
      expect(chickenIngredient.quantity).toBe(0.5);
      expect(chickenIngredient.unit).toBe('container');
      expect(chickenIngredient.macros_per_container).toBeTruthy();
      expect(chickenIngredient.macros_per_container.calories).toBeGreaterThan(0);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_get_cookable identifies recipes with sufficient stock', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-cookable');
      await seedChefByteData(ctx.client, ctx.userId);

      // The seeded "Chicken & Rice" recipe requires:
      //   - 0.5 container Chicken Breast (stock: 3)
      //   - 0.25 container Brown Rice (stock: 2)
      // So it should be cookable.
      const result = await ctx.mcp.callTool('CHEFBYTE_get_cookable', {});
      const data = parseResult(result);

      expect(data.total).toBeGreaterThanOrEqual(1);
      const chickenRice = data.cookable.find((c: any) => c.name === 'Chicken & Rice');
      expect(chickenRice).toBeTruthy();
      expect(chickenRice.max_batches).toBeGreaterThanOrEqual(1);
      expect(chickenRice.servings_per_batch).toBe(2);
      expect(chickenRice.max_servings).toBeGreaterThanOrEqual(2);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_add_meal creates a meal plan entry', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-addmeal');
      const { recipeId } = await seedChefByteData(ctx.client, ctx.userId);

      const today = todayStr();
      const result = await ctx.mcp.callTool('CHEFBYTE_add_meal', {
        logical_date: today,
        recipe_id: recipeId,
        servings: 3,
      });
      const data = parseResult(result);

      expect(data.message).toContain('added');
      expect(data.meal.meal_id).toBeTruthy();
      expect(data.meal.logical_date).toBe(today);
      expect(data.meal.recipe_id).toBe(recipeId);
      expect(Number(data.meal.servings)).toBe(3);
      expect(data.meal.meal_prep).toBe(false);

      // Verify in DB
      const chef = (ctx.client as any).schema('chefbyte');
      const { data: entry } = await chef
        .from('meal_plan_entries')
        .select('meal_id, recipe_id, servings, logical_date')
        .eq('meal_id', data.meal.meal_id)
        .single();
      expect(entry.recipe_id).toBe(recipeId);
      expect(Number(entry.servings)).toBe(3);
      expect(entry.logical_date).toBe(today);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_get_inventory returns inventory grouped by product', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-inventory');
      await seedChefByteData(ctx.client, ctx.userId);

      const result = await ctx.mcp.callTool('CHEFBYTE_get_inventory', {});
      const data = parseResult(result);

      // seedChefByteData creates 5 products with stock lots
      expect(data.total_products).toBeGreaterThanOrEqual(1);
      expect(data.inventory.length).toBeGreaterThanOrEqual(1);

      // Chicken Breast should appear with total_containers = 3 (seeded)
      const chicken = data.inventory.find(
        (i: any) => i.product_name === 'Great Value Boneless Skinless Chicken Breasts',
      );
      expect(chicken).toBeTruthy();
      expect(Number(chicken.total_containers)).toBe(3);
      expect(chicken.nearest_expiry).toBeTruthy();

      // Brown Rice should have total_containers = 2
      const rice = data.inventory.find((i: any) => i.product_name === 'Great Value Long Grain Brown Rice');
      expect(rice).toBeTruthy();
      expect(Number(rice.total_containers)).toBe(2);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_get_product_lots returns lots for a specific product', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-lots');
      const { productMap } = await seedChefByteData(ctx.client, ctx.userId);

      const chickenId = productMap['Great Value Boneless Skinless Chicken Breasts'];

      const result = await ctx.mcp.callTool('CHEFBYTE_get_product_lots', {
        product_id: chickenId,
      });
      const data = parseResult(result);

      expect(data.product_id).toBe(chickenId);
      expect(data.total_lots).toBeGreaterThanOrEqual(1);
      expect(data.lots.length).toBeGreaterThanOrEqual(1);

      // Verify lot structure
      const lot = data.lots[0];
      expect(lot.lot_id).toBeTruthy();
      expect(Number(lot.qty_containers)).toBe(3); // seeded with 3 containers
      expect(lot.expires_on).toBeTruthy();
      expect(lot.location).toBeTruthy(); // Should be "Fridge"
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_mark_done completes meal and deducts stock', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-markdone');
      const { recipeId, productMap } = await seedChefByteData(ctx.client, ctx.userId);

      const chef = (ctx.client as any).schema('chefbyte');
      const today = todayStr();

      // Seed a meal plan entry (1 serving of Chicken & Rice, base_servings=2)
      const mealId = await seedMealEntry(ctx.client, ctx.userId, recipeId, today, {
        servings: 1,
      });

      // Get chicken stock before marking done
      const { data: chickenBefore } = await chef
        .from('stock_lots')
        .select('qty_containers')
        .eq('product_id', productMap['Great Value Boneless Skinless Chicken Breasts'])
        .eq('user_id', ctx.userId)
        .gt('qty_containers', 0);
      const chickenStockBefore = chickenBefore!.reduce((sum: number, l: any) => sum + Number(l.qty_containers), 0);

      // Mark done via MCP
      const result = await ctx.mcp.callTool('CHEFBYTE_mark_done', {
        meal_id: mealId,
      });
      const data = parseResult(result);
      expect(data.success).not.toBe(false); // Ensure no error from RPC

      // Verify completed_at is set
      const { data: meal } = await chef.from('meal_plan_entries').select('completed_at').eq('meal_id', mealId).single();
      expect(meal.completed_at).toBeTruthy();

      // Verify stock was deducted (chicken should have decreased)
      const { data: chickenAfter } = await chef
        .from('stock_lots')
        .select('qty_containers')
        .eq('product_id', productMap['Great Value Boneless Skinless Chicken Breasts'])
        .eq('user_id', ctx.userId)
        .gte('qty_containers', 0);
      const chickenStockAfter = chickenAfter!.reduce((sum: number, l: any) => sum + Number(l.qty_containers), 0);
      expect(chickenStockAfter).toBeLessThan(chickenStockBefore);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// CoachByte MCP tool tests
// ---------------------------------------------------------------------------

test.describe('MCP Tools — CoachByte', () => {
  test('COACHBYTE_get_exercises returns exercise list', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-coach-exercises');
      await seedCoachByteData(ctx.client, ctx.userId);

      // The get_exercises tool filters by user_id = ctx.userId, so global
      // exercises (user_id IS NULL) are not returned. We need to create
      // a user-specific exercise to test this tool.
      const coach = (ctx.client as any).schema('coachbyte');
      await coach.from('exercises').insert({
        user_id: ctx.userId,
        name: 'MCP Custom Exercise',
      });

      const result = await ctx.mcp.callTool('COACHBYTE_get_exercises', {});
      const data = parseResult(result);

      expect(data.total).toBeGreaterThanOrEqual(1);
      const names = data.exercises.map((e: any) => e.name);
      expect(names).toContain('MCP Custom Exercise');
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('COACHBYTE_get_split returns weekly split', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-coach-split');
      await seedCoachByteData(ctx.client, ctx.userId);

      // seedCoachByteData creates a split for today's weekday
      const todayWeekday = new Date().getDay();

      const result = await ctx.mcp.callTool('COACHBYTE_get_split', {
        weekday: todayWeekday,
      });
      const data = parseResult(result);

      expect(data.splits.length).toBeGreaterThanOrEqual(1);
      const todaySplit = data.splits.find((s: any) => s.weekday === todayWeekday);
      expect(todaySplit).toBeTruthy();
      expect(todaySplit.template_sets.length).toBe(3); // 2 squat + 1 bench from seed

      // Verify exercise names were resolved
      const exerciseNames = todaySplit.template_sets.map((ts: any) => ts.exercise_name);
      expect(exerciseNames).toContain('Squat');
      expect(exerciseNames).toContain('Bench Press');
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('COACHBYTE timer lifecycle: set -> get -> pause -> resume -> reset', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-coach-timer');

      // 1. Get timer — should be idle (no timer exists)
      const idleResult = await ctx.mcp.callTool('COACHBYTE_get_timer', {});
      const idleData = parseResult(idleResult);
      expect(idleData.state).toBe('idle');

      // 2. Set timer for 120 seconds
      const setResult = await ctx.mcp.callTool('COACHBYTE_set_timer', {
        duration_seconds: 120,
      });
      const setData = parseResult(setResult);
      expect(setData.state).toBe('running');
      expect(setData.duration_seconds).toBe(120);
      expect(setData.timer_id).toBeTruthy();

      // 3. Get timer — should be running
      const runningResult = await ctx.mcp.callTool('COACHBYTE_get_timer', {});
      const runningData = parseResult(runningResult);
      expect(runningData.state).toBe('running');
      expect(runningData.remaining_seconds).toBeGreaterThan(0);
      expect(runningData.remaining_seconds).toBeLessThanOrEqual(120);

      // 4. Pause the timer
      const pauseResult = await ctx.mcp.callTool('COACHBYTE_pause_timer', {});
      const pauseData = parseResult(pauseResult);
      expect(pauseData.state).toBe('paused');
      expect(pauseData.remaining_seconds).toBeGreaterThan(0);

      // 5. Resume the timer
      const resumeResult = await ctx.mcp.callTool('COACHBYTE_resume_timer', {});
      const resumeData = parseResult(resumeResult);
      expect(resumeData.state).toBe('running');
      expect(resumeData.remaining_seconds).toBeGreaterThan(0);

      // 6. Reset the timer
      const resetResult = await ctx.mcp.callTool('COACHBYTE_reset_timer', {});
      const resetData = parseResult(resetResult);
      expect(resetData.state).toBe('idle');

      // 7. Verify timer is gone
      const finalResult = await ctx.mcp.callTool('COACHBYTE_get_timer', {});
      const finalData = parseResult(finalResult);
      expect(finalData.state).toBe('idle');
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('COACHBYTE_get_history returns completed sets', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-coach-history');
      await seedCoachByteData(ctx.client, ctx.userId);

      const today = todayStr();
      await seedCompletedSet(ctx.client, ctx.userId, today);

      const result = await ctx.mcp.callTool('COACHBYTE_get_history', { days: 7 });
      const data = parseResult(result);

      expect(data.days.length).toBeGreaterThanOrEqual(1);

      const todayPlan = data.days.find((d: any) => d.plan_date === today || d.logical_date === today);
      expect(todayPlan).toBeTruthy();
      expect(todayPlan.total_sets_completed).toBeGreaterThanOrEqual(1);
      expect(todayPlan.completed_sets.length).toBeGreaterThanOrEqual(1);

      // Verify set details
      const firstSet = todayPlan.completed_sets[0];
      expect(firstSet.actual_reps).toBe(5);
      expect(Number(firstSet.actual_load)).toBe(225);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('COACHBYTE_get_prs returns personal records', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-coach-prs');
      await seedCoachByteData(ctx.client, ctx.userId);

      const today = todayStr();
      await seedCompletedSet(ctx.client, ctx.userId, today);

      const result = await ctx.mcp.callTool('COACHBYTE_get_prs', {});
      const data = parseResult(result);

      expect(data.prs.length).toBeGreaterThanOrEqual(1);

      const pr = data.prs[0];
      expect(pr.exercise_id).toBeTruthy();
      expect(pr.estimated_1rm).toBeGreaterThan(0);
      expect(pr.best_set.reps).toBe(5);
      expect(Number(pr.best_set.load)).toBe(225);
      expect(pr.rm_table).toBeTruthy();
      expect(pr.rm_table['1RM']).toBeGreaterThan(0);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('COACHBYTE_update_summary persists text', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-coach-summary');
      await seedCoachByteData(ctx.client, ctx.userId);

      // Get today's plan to get a plan_id
      const planResult = await ctx.mcp.callTool('COACHBYTE_get_today_plan', {});
      const planData = parseResult(planResult);
      const planId = planData.plan_id;
      expect(planId).toBeTruthy();

      // Update the summary
      const summaryText = 'Great workout session! Hit all targets.';
      const result = await ctx.mcp.callTool('COACHBYTE_update_summary', {
        plan_id: planId,
        summary: summaryText,
      });
      const data = parseResult(result);
      expect(data.message).toContain('updated');
      expect(data.summary).toBe(summaryText);

      // Verify in DB
      const coach = (ctx.client as any).schema('coachbyte');
      const { data: plan } = await coach.from('daily_plans').select('summary').eq('plan_id', planId).single();
      expect(plan.summary).toBe(summaryText);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('COACHBYTE_log_set logs an ad-hoc completed set', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-coach-logset');
      const { exerciseMap } = await seedCoachByteData(ctx.client, ctx.userId);

      const squatId = exerciseMap['Squat'];

      const result = await ctx.mcp.callTool('COACHBYTE_log_set', {
        exercise_id: squatId,
        reps: 8,
        load: 275,
      });
      const data = parseResult(result);

      expect(data.message).toContain('Ad-hoc set logged');
      expect(data.message).toContain('8 reps');
      expect(data.message).toContain('275');
      expect(data.completed_set_id).toBeTruthy();
      expect(data.completed_at).toBeTruthy();

      // Verify in DB
      const coach = (ctx.client as any).schema('coachbyte');
      const { data: setRow } = await coach
        .from('completed_sets')
        .select('actual_reps, actual_load, exercise_id, planned_set_id')
        .eq('completed_set_id', data.completed_set_id)
        .single();
      expect(setRow.actual_reps).toBe(8);
      expect(Number(setRow.actual_load)).toBe(275);
      expect(setRow.exercise_id).toBe(squatId);
      expect(setRow.planned_set_id).toBeNull(); // Ad-hoc set has no planned_set_id
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('COACHBYTE_update_split updates template sets for a weekday', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-coach-updatesplit');
      const { exerciseMap } = await seedCoachByteData(ctx.client, ctx.userId);

      const benchId = exerciseMap['Bench Press'];

      // Update split for a different weekday (use weekday 6 = Saturday to avoid
      // conflict with the seed which uses today's weekday)
      const targetWeekday = 6; // Saturday
      const newTemplateSets = [
        { exercise_id: benchId, target_reps: 10, target_load: 135, rest_seconds: 90 },
        { exercise_id: benchId, target_reps: 8, target_load: 155, rest_seconds: 120 },
      ];

      const result = await ctx.mcp.callTool('COACHBYTE_update_split', {
        weekday: targetWeekday,
        template_sets: newTemplateSets,
      });
      const data = parseResult(result);

      expect(data.message).toContain('Saturday');
      expect(data.split_id).toBeTruthy();
      expect(data.weekday).toBe(targetWeekday);
      expect(data.day_name).toBe('Saturday');
      expect(data.template_sets.length).toBe(2);
      expect(data.template_sets[0].exercise_id).toBe(benchId);
      expect(data.template_sets[0].target_reps).toBe(10);
      expect(data.template_sets[1].target_load).toBe(155);

      // Verify persistence in DB
      const coach = (ctx.client as any).schema('coachbyte');
      const { data: split } = await coach
        .from('splits')
        .select('weekday, template_sets')
        .eq('user_id', ctx.userId)
        .eq('weekday', targetWeekday)
        .single();
      expect(split.weekday).toBe(targetWeekday);
      expect(split.template_sets.length).toBe(2);
      expect(split.template_sets[0].target_reps).toBe(10);
      expect(split.template_sets[1].target_reps).toBe(8);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('COACHBYTE_update_plan replaces planned sets for a day', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-coach-updateplan');
      const { exerciseMap } = await seedCoachByteData(ctx.client, ctx.userId);

      const squatId = exerciseMap['Squat'];
      const benchId = exerciseMap['Bench Press'];

      // Bootstrap a plan first
      const planResult = await ctx.mcp.callTool('COACHBYTE_get_today_plan', {});
      const planData = parseResult(planResult);
      const planId = planData.plan_id;
      expect(planId).toBeTruthy();

      // Original plan has 3 sets (2 squat + 1 bench from seed)
      // Replace with 2 new sets
      const newSets = [
        { exercise_id: benchId, target_reps: 10, target_load: 135, rest_seconds: 60, order: 1 },
        { exercise_id: squatId, target_reps: 8, target_load: 185, rest_seconds: 90, order: 2 },
      ];

      const result = await ctx.mcp.callTool('COACHBYTE_update_plan', {
        plan_id: planId,
        sets: newSets,
      });
      const data = parseResult(result);

      expect(data.plan_id).toBe(planId);
      expect(data.sets.length).toBe(2);
      expect(data.sets[0].exercise_id).toBe(benchId);
      expect(data.sets[0].target_reps).toBe(10);
      expect(data.sets[0].order).toBe(1);
      expect(data.sets[1].exercise_id).toBe(squatId);
      expect(data.sets[1].target_load).toBe(185);
      expect(data.sets[1].order).toBe(2);

      // Verify in DB - old sets replaced
      const coach = (ctx.client as any).schema('coachbyte');
      const { data: dbSets } = await coach
        .from('planned_sets')
        .select('exercise_id, target_reps, target_load, rest_seconds, "order"')
        .eq('plan_id', planId)
        .order('order');
      expect(dbSets!.length).toBe(2);
      expect(dbSets![0].target_reps).toBe(10);
      expect(dbSets![1].target_reps).toBe(8);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('COACHBYTE_complete_next_set completes the next queued set', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-coach-completenext');
      await seedCoachByteData(ctx.client, ctx.userId);

      // Bootstrap plan
      const planResult = await ctx.mcp.callTool('COACHBYTE_get_today_plan', {});
      const planData = parseResult(planResult);
      const planId = planData.plan_id;
      expect(planId).toBeTruthy();

      // Complete the first set (Squat, order 1)
      const result = await ctx.mcp.callTool('COACHBYTE_complete_next_set', {
        plan_id: planId,
        reps: 5,
        load: 225,
      });
      const data = parseResult(result);

      expect(data.message).toBeTruthy();

      // Verify a completed set was created in DB
      const coach = (ctx.client as any).schema('coachbyte');
      const { data: completedSets } = await coach
        .from('completed_sets')
        .select('actual_reps, actual_load, planned_set_id')
        .eq('plan_id', planId)
        .not('planned_set_id', 'is', null);
      expect(completedSets!.length).toBe(1);
      expect(completedSets![0].actual_reps).toBe(5);
      expect(Number(completedSets![0].actual_load)).toBe(225);

      // Complete the second set
      const result2 = await ctx.mcp.callTool('COACHBYTE_complete_next_set', {
        plan_id: planId,
        reps: 5,
        load: 225,
      });
      const data2 = parseResult(result2);
      expect(data2.message).toBeTruthy();

      // Now 2 completed sets
      const { data: afterSets } = await coach
        .from('completed_sets')
        .select('actual_reps')
        .eq('plan_id', planId)
        .not('planned_set_id', 'is', null);
      expect(afterSets!.length).toBe(2);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Error handling tests
// ---------------------------------------------------------------------------

test.describe('MCP Tools — Error Handling', () => {
  test('invalid tool name returns error', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-err-unknown');

      // The MCP server returns a JSON-RPC error for unknown tools,
      // which the client throws as an exception
      await expect(ctx.mcp.callTool('NONEXISTENT_TOOL', {})).rejects.toThrow(/Unknown tool/);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('missing required argument returns isError: true', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-err-missing');
      await seedChefByteData(ctx.client, ctx.userId);

      // CHEFBYTE_consume requires product_id, qty, unit — omit all
      const result = await ctx.mcp.callTool('CHEFBYTE_consume', {});
      expectError(result);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('invalid UUID returns isError: true', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-err-uuid');

      const result = await ctx.mcp.callTool('CHEFBYTE_delete_meal_entry', {
        meal_id: '00000000-0000-0000-0000-000000000000',
      });
      expectError(result, 'not found');
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });
});
