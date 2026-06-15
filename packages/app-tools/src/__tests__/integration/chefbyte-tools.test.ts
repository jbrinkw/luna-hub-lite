import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUser, createToolContext, parseToolResult, admin } from './helpers';
import type { ToolContext } from '../../types';

// Import all handlers under test
import { createProduct } from '../../chefbyte/create-product';
import { getProducts } from '../../chefbyte/get-products';
import { addStock } from '../../chefbyte/add-stock';
import { getInventory } from '../../chefbyte/get-inventory';
import { consume } from '../../chefbyte/consume';
import { getProductLots } from '../../chefbyte/get-product-lots';
import { addToShopping } from '../../chefbyte/add-to-shopping';
import { getShoppingList } from '../../chefbyte/get-shopping-list';
import { clearShopping } from '../../chefbyte/clear-shopping';
import { belowMinStock } from '../../chefbyte/below-min-stock';
import { getMacros } from '../../chefbyte/get-macros';
import { logTempItem } from '../../chefbyte/log-temp-item';
import { setPrice } from '../../chefbyte/set-price';
import { createRecipe } from '../../chefbyte/create-recipe';
import { getRecipes } from '../../chefbyte/get-recipes';
import { updateRecipe } from '../../chefbyte/update-recipe';
import { getCookable } from '../../chefbyte/get-cookable';
import { addMeal } from '../../chefbyte/add-meal';
import { getMealPlan } from '../../chefbyte/get-meal-plan';
import { markDone } from '../../chefbyte/mark-done';
import { updateProduct } from '../../chefbyte/update-product';
import { deleteShoppingItem } from '../../chefbyte/delete-shopping-item';
import { togglePurchased } from '../../chefbyte/toggle-purchased';
import { importShoppingToInventory } from '../../chefbyte/import-shopping-to-inventory';
import { deleteMealEntry } from '../../chefbyte/delete-meal-entry';
import { deleteFoodLog } from '../../chefbyte/delete-food-log';
import { deleteTempItem } from '../../chefbyte/delete-temp-item';
import { deleteRecipe } from '../../chefbyte/delete-recipe';
import { deleteProduct } from '../../chefbyte/delete-product';

// ---------------------------------------------------------------------------
// ChefByte Tool Integration Tests
// ---------------------------------------------------------------------------
// Tests run sequentially within each describe. Order matters because later
// tests depend on data created by earlier ones (products, stock, etc.).
// ---------------------------------------------------------------------------

describe('ChefByte Tool Integration Tests', () => {
  let userId: string;
  let ctx: ToolContext;
  let cleanup: () => Promise<void>;

  // Shared state across sequential tests
  let productId: string;
  let secondProductId: string;
  let locationId: string;

  beforeAll(async () => {
    const user = await createTestUser('chefbyte-tools');
    userId = user.userId;
    ctx = createToolContext(userId);
    cleanup = user.cleanup;

    // Fetch the first default location (seeded on chefbyte activation)
    const { data: locations } = await admin
      .schema('chefbyte')
      .from('locations')
      .select('location_id, name')
      .eq('user_id', userId)
      .order('name', { ascending: true })
      .limit(1);

    expect(locations).toBeDefined();
    expect(locations!.length).toBeGreaterThan(0);
    locationId = locations![0].location_id;
  }, 30_000);

  afterAll(async () => {
    await cleanup();
  });

  // -----------------------------------------------------------------------
  // 1. createProduct
  // -----------------------------------------------------------------------

  describe('createProduct', () => {
    it('creates a product with only a name', async () => {
      const result = await createProduct.handler({ name: 'Test Chicken Breast' }, ctx);
      const data = parseToolResult(result);

      expect(data.message).toContain('Test Chicken Breast');
      expect(data.product).toBeDefined();
      expect(data.product.product_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(data.product.name).toBe('Test Chicken Breast');

      // Save for later tests
      productId = data.product.product_id;
    });

    it('creates a product with full nutritional info', async () => {
      const result = await createProduct.handler(
        {
          name: 'Test Greek Yogurt',
          servings_per_container: 2,
          calories_per_serving: 150,
          protein_per_serving: 20,
          carbs_per_serving: 8,
          fat_per_serving: 4,
          price: 5.99,
          min_stock_amount: 3,
          barcode: '1234567890',
        },
        ctx,
      );
      const data = parseToolResult(result);

      expect(data.product.name).toBe('Test Greek Yogurt');
      expect(data.product.barcode).toBe('1234567890');
      expect(data.product.product_id).toBeTruthy();

      secondProductId = data.product.product_id;
    });

    it('rejects a product without a name (DB constraint)', async () => {
      const result = await createProduct.handler({}, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to create product');
    });
  });

  // -----------------------------------------------------------------------
  // 2. getProducts
  // -----------------------------------------------------------------------

  describe('getProducts', () => {
    it('lists all products for the user', async () => {
      const result = await getProducts.handler({}, ctx);
      const data = parseToolResult(result);

      expect(data.products).toBeInstanceOf(Array);
      expect(data.total).toBeGreaterThanOrEqual(2);

      const names = data.products.map((p: any) => p.name);
      expect(names).toContain('Test Chicken Breast');
      expect(names).toContain('Test Greek Yogurt');
    });

    it('filters products by search term', async () => {
      const result = await getProducts.handler({ search: 'Yogurt' }, ctx);
      const data = parseToolResult(result);

      expect(data.total).toBe(1);
      expect(data.products[0].name).toBe('Test Greek Yogurt');
      expect(data.products[0].calories_per_serving).toBe(150);
    });

    it('returns empty array for non-matching search', async () => {
      const result = await getProducts.handler({ search: 'XYZNONEXISTENT' }, ctx);
      const data = parseToolResult(result);

      expect(data.products).toEqual([]);
      expect(data.total).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 3. setPrice
  // -----------------------------------------------------------------------

  describe('setPrice', () => {
    it('sets the price on a product', async () => {
      const result = await setPrice.handler({ product_id: productId, price: 12.49 }, ctx);
      const data = parseToolResult(result);

      expect(data.message).toContain('12.49');
      expect(data.product.product_id).toBe(productId);
      expect(data.product.name).toBe('Test Chicken Breast');
      expect(Number(data.product.price)).toBeCloseTo(12.49, 2);

      // L11 fix: Re-read DB to confirm price write persisted
      const { data: row, error } = await admin
        .schema('chefbyte')
        .from('products')
        .select('price')
        .eq('product_id', productId)
        .single();
      expect(error).toBeNull();
      expect(Number(row!.price)).toBeCloseTo(12.49, 2);
    });

    it('rejects a negative price', async () => {
      const result = await setPrice.handler({ product_id: productId, price: -5 }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('negative');
    });
  });

  // -----------------------------------------------------------------------
  // 4. addStock
  // -----------------------------------------------------------------------

  describe('addStock', () => {
    it('adds stock for a product with location', async () => {
      const result = await addStock.handler(
        {
          product_id: productId,
          qty_containers: 5,
          location_id: locationId,
          expires_on: '2026-12-31',
        },
        ctx,
      );
      const data = parseToolResult(result);

      expect(data.message).toContain('5');
      expect(data.lot).toBeDefined();
      expect(data.lot.lot_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(Number(data.lot.qty_containers)).toBe(5);
      expect(data.lot.expires_on).toBe('2026-12-31');
      expect(data.lot.location_id).toBe(locationId);
    });

    it('adds a second lot for the same product (different expiry)', async () => {
      const result = await addStock.handler(
        {
          product_id: productId,
          qty_containers: 3,
          location_id: locationId,
          expires_on: '2026-06-15',
        },
        ctx,
      );
      const data = parseToolResult(result);

      expect(data.lot.lot_id).toBeTruthy();
      expect(Number(data.lot.qty_containers)).toBe(3);
      expect(data.lot.expires_on).toBe('2026-06-15');
    });

    it('adds stock for the second product', async () => {
      const result = await addStock.handler(
        {
          product_id: secondProductId,
          qty_containers: 1,
          location_id: locationId,
        },
        ctx,
      );
      const data = parseToolResult(result);

      expect(Number(data.lot.qty_containers)).toBe(1);
    });

    it('rejects zero qty_containers', async () => {
      const result = await addStock.handler(
        {
          product_id: productId,
          qty_containers: 0,
          location_id: locationId,
        },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('positive');
    });

    it('rejects negative qty_containers', async () => {
      const result = await addStock.handler(
        {
          product_id: productId,
          qty_containers: -2,
          location_id: locationId,
        },
        ctx,
      );
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 5. getProductLots
  // -----------------------------------------------------------------------

  describe('getProductLots', () => {
    it('returns all lots for a product ordered by expiration', async () => {
      const result = await getProductLots.handler({ product_id: productId }, ctx);
      const data = parseToolResult(result);

      expect(data.product_id).toBe(productId);
      expect(data.lots).toBeInstanceOf(Array);
      expect(data.total_lots).toBe(2);

      // Verify ordering: nearest expiration first
      // 2026-06-15 should come before 2026-12-31
      expect(data.lots[0].expires_on).toBe('2026-06-15');
      expect(Number(data.lots[0].qty_containers)).toBe(3);
      expect(data.lots[1].expires_on).toBe('2026-12-31');
      expect(Number(data.lots[1].qty_containers)).toBe(5);
    });

    it('returns empty lots for a product with no stock', async () => {
      // Create a product with no stock
      const createResult = await createProduct.handler({ name: 'Test Unused Product' }, ctx);
      const product = parseToolResult(createResult);

      const result = await getProductLots.handler({ product_id: product.product.product_id }, ctx);
      const data = parseToolResult(result);

      expect(data.total_lots).toBe(0);
      expect(data.lots).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // 6. getInventory
  // -----------------------------------------------------------------------

  describe('getInventory', () => {
    it('returns inventory grouped by product', async () => {
      const result = await getInventory.handler({}, ctx);
      const data = parseToolResult(result);

      expect(data.inventory).toBeInstanceOf(Array);
      expect(data.total_products).toBeGreaterThanOrEqual(2);

      // Find the first product in inventory
      const chickenItem = data.inventory.find((i: any) => i.product_id === productId);
      expect(chickenItem).toBeDefined();
      expect(chickenItem.product_name).toBe('Test Chicken Breast');
      // 5 + 3 = 8 total containers
      expect(chickenItem.total_containers).toBe(8);
      // Nearest expiry should be the earlier date
      expect(chickenItem.nearest_expiry).toBe('2026-06-15');
    });

    it('includes lot details when include_lots is true', async () => {
      const result = await getInventory.handler({ include_lots: true }, ctx);
      const data = parseToolResult(result);

      const chickenItem = data.inventory.find((i: any) => i.product_id === productId);
      expect(chickenItem).toBeDefined();
      expect(chickenItem.lots).toBeInstanceOf(Array);
      expect(chickenItem.lots.length).toBe(2);

      // Each lot should have a lot_id and qty
      for (const lot of chickenItem.lots) {
        expect(lot.lot_id).toBeTruthy();
        expect(lot.qty_containers).toBeGreaterThan(0);
      }
    });

    it('does not include lots by default', async () => {
      const result = await getInventory.handler({}, ctx);
      const data = parseToolResult(result);

      const chickenItem = data.inventory.find((i: any) => i.product_id === productId);
      expect(chickenItem).toBeDefined();
      expect(chickenItem.lots).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 7. consume
  // -----------------------------------------------------------------------

  describe('consume', () => {
    it('consumes stock by containers (FIFO order)', async () => {
      // Consume 2 containers — should deduct from earliest-expiring lot (2026-06-15)
      const result = await consume.handler(
        {
          product_id: productId,
          qty: 2,
          unit: 'container',
          log_macros: false,
        },
        ctx,
      );
      const data = parseToolResult(result);

      expect(data.success).toBe(true);
      expect(Number(data.qty_consumed)).toBe(2);
      // stock_remaining should be 8 - 2 = 6
      expect(Number(data.stock_remaining)).toBe(6);
    });

    it('verifies lots after partial consume', async () => {
      const result = await getProductLots.handler({ product_id: productId }, ctx);
      const data = parseToolResult(result);

      expect(data.total_lots).toBe(2);
      // The first lot (2026-06-15) had 3, consumed 2 => 1 remaining
      expect(Number(data.lots[0].qty_containers)).toBe(1);
      // The second lot (2026-12-31) should be untouched at 5
      expect(Number(data.lots[1].qty_containers)).toBe(5);
    });

    it('consumes across lot boundaries', async () => {
      // Consume 3 containers — should exhaust lot 1 (1 left) and take 2 from lot 2
      const result = await consume.handler(
        {
          product_id: productId,
          qty: 3,
          unit: 'container',
          log_macros: false,
        },
        ctx,
      );
      const data = parseToolResult(result);

      expect(data.success).toBe(true);
      // 6 - 3 = 3 remaining
      expect(Number(data.stock_remaining)).toBe(3);
    });

    it('verifies first lot was fully consumed (deleted)', async () => {
      const result = await getProductLots.handler({ product_id: productId }, ctx);
      const data = parseToolResult(result);

      // First lot should be gone (qty reached 0 => deleted)
      expect(data.total_lots).toBe(1);
      expect(data.lots[0].expires_on).toBe('2026-12-31');
      expect(Number(data.lots[0].qty_containers)).toBe(3);
    });

    it('consumes with macros logged', async () => {
      // First update the product with nutritional info so we can verify macros
      await admin
        .schema('chefbyte')
        .from('products')
        .update({
          servings_per_container: 4,
          calories_per_serving: 200,
          protein_per_serving: 30,
          carbs_per_serving: 0,
          fat_per_serving: 5,
        })
        .eq('product_id', productId);

      const result = await consume.handler(
        {
          product_id: productId,
          qty: 1,
          unit: 'container',
          log_macros: true,
        },
        ctx,
      );
      const data = parseToolResult(result);

      expect(data.success).toBe(true);
      expect(data.macros).toBeDefined();
      // 1 container * 4 servings * 200 cal = 800
      expect(Number(data.macros.calories)).toBe(800);
      // 1 container * 4 servings * 30g protein = 120
      expect(Number(data.macros.protein)).toBe(120);
      expect(Number(data.stock_remaining)).toBe(2);

      // H6 fix: Re-query stock_lots to verify stock was actually decremented
      const lotsResult = await getProductLots.handler({ product_id: productId }, ctx);
      const lotsData = parseToolResult(lotsResult);
      expect(lotsData.total_lots).toBe(1);
      expect(Number(lotsData.lots[0].qty_containers)).toBe(2);

      // H6 fix: Re-query food_logs to verify macro entry was created in DB
      const { data: foodLogs } = await admin
        .schema('chefbyte')
        .from('food_logs')
        .select('calories, protein, carbs, fat, qty_consumed, unit')
        .eq('product_id', productId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1);
      expect(foodLogs).toHaveLength(1);
      expect(Number(foodLogs![0].calories)).toBe(800);
      expect(Number(foodLogs![0].protein)).toBe(120);
      expect(Number(foodLogs![0].qty_consumed)).toBe(1);
      expect(foodLogs![0].unit).toBe('container');
    });

    it('rejects zero qty', async () => {
      const result = await consume.handler(
        {
          product_id: productId,
          qty: 0,
          unit: 'container',
        },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('positive');
    });

    it('floors at zero when consuming more than available', async () => {
      // Only 2 containers left; consume 10 — stock should floor at 0
      const result = await consume.handler(
        {
          product_id: productId,
          qty: 10,
          unit: 'container',
          log_macros: false,
        },
        ctx,
      );
      const data = parseToolResult(result);

      expect(data.success).toBe(true);
      expect(Number(data.stock_remaining)).toBe(0);

      // H6 fix: Re-query stock_lots to verify all lots were actually deleted
      const lotsResult = await getProductLots.handler({ product_id: productId }, ctx);
      const lotsData = parseToolResult(lotsResult);
      expect(lotsData.total_lots).toBe(0);
      expect(lotsData.lots).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 8. addToShopping
  // -----------------------------------------------------------------------

  describe('addToShopping', () => {
    it('adds an item to the shopping list', async () => {
      const result = await addToShopping.handler(
        {
          product_id: secondProductId,
          qty_containers: 4,
        },
        ctx,
      );
      const data = parseToolResult(result);

      expect(data.message).toContain('4');
      expect(data.item).toBeDefined();
      expect(data.item.product_id).toBe(secondProductId);
      expect(Number(data.item.qty_containers)).toBe(4);
    });

    it('additive upsert: adding the same product again SUMS the quantities (bug 2 fix)', async () => {
      // Previous qty was 4. Adding 7 more should yield 11, not replace with 7.
      // This is the 2026-04-22 MCP E2E audit Bug 2 regression pin.
      const result = await addToShopping.handler(
        {
          product_id: secondProductId,
          qty_containers: 7,
        },
        ctx,
      );
      const data = parseToolResult(result);

      expect(Number(data.item.qty_containers)).toBe(11);
      expect(data.item.product_id).toBe(secondProductId);

      // Confirm via the admin-read path too (no UI-side merging).
      const { data: row } = await admin
        .schema('chefbyte')
        .from('shopping_list')
        .select('qty_containers')
        .eq('user_id', userId)
        .eq('product_id', secondProductId)
        .single();
      expect(Number(row!.qty_containers)).toBe(11);
    });

    it('additive upsert: multiple small adds accumulate (3 + 2 = 5)', async () => {
      // Use productId (a fresh slot) — this product was stocked/consumed earlier
      // but never added to the shopping list in this test file.
      // Make sure we start from 0 on the shopping list for this product.
      await admin.schema('chefbyte').from('shopping_list').delete().eq('user_id', userId).eq('product_id', productId);

      await addToShopping.handler({ product_id: productId, qty_containers: 3 }, ctx);
      const result2 = await addToShopping.handler({ product_id: productId, qty_containers: 2 }, ctx);
      const data2 = parseToolResult(result2);

      expect(Number(data2.item.qty_containers)).toBe(5);

      // Cleanup so later tests that re-seed the shopping list behave normally.
      await admin.schema('chefbyte').from('shopping_list').delete().eq('user_id', userId).eq('product_id', productId);
    });

    it('rejects zero qty_containers', async () => {
      const result = await addToShopping.handler(
        {
          product_id: productId,
          qty_containers: 0,
        },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('positive');
    });
  });

  // -----------------------------------------------------------------------
  // 9. getShoppingList
  // -----------------------------------------------------------------------

  describe('getShoppingList', () => {
    it('returns the current shopping list with product details', async () => {
      const result = await getShoppingList.handler({}, ctx);
      const data = parseToolResult(result);

      expect(data.items).toBeInstanceOf(Array);
      expect(data.total_items).toBeGreaterThanOrEqual(1);

      // Find the yogurt item we added
      const yogurtItem = data.items.find((i: any) => i.product_id === secondProductId);
      expect(yogurtItem).toBeDefined();
      expect(yogurtItem.product_name).toBe('Test Greek Yogurt');
      // Additive upsert: 4 (first add) + 7 (second add) = 11
      expect(Number(yogurtItem.qty_containers)).toBe(11);
      // Price = 5.99, qty = 11 => estimated_cost = 65.89
      expect(Number(yogurtItem.price)).toBeCloseTo(5.99, 2);
      expect(Number(yogurtItem.estimated_cost)).toBeCloseTo(65.89, 2);

      // estimated_total should reflect the sum
      expect(data.estimated_total).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // 10. clearShopping
  // -----------------------------------------------------------------------

  describe('clearShopping', () => {
    it('clears the entire shopping list', async () => {
      const result = await clearShopping.handler({}, ctx);
      const data = parseToolResult(result);

      expect(data.message).toBe('Shopping list cleared');
    });

    it('verifies shopping list is empty after clearing', async () => {
      const result = await getShoppingList.handler({}, ctx);
      const data = parseToolResult(result);

      expect(data.items).toEqual([]);
      expect(data.total_items).toBe(0);
      expect(data.estimated_total).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 11. belowMinStock
  // -----------------------------------------------------------------------

  describe('belowMinStock', () => {
    it('detects products below minimum stock', async () => {
      // secondProductId (Greek Yogurt) has min_stock_amount=3 and only 1 container in stock
      const result = await belowMinStock.handler({}, ctx);
      const data = parseToolResult(result);

      expect(data.below_min).toBeInstanceOf(Array);
      expect(data.total).toBeGreaterThanOrEqual(1);

      const yogurtItem = data.below_min.find((i: any) => i.product_id === secondProductId);
      expect(yogurtItem).toBeDefined();
      expect(yogurtItem.product_name).toBe('Test Greek Yogurt');
      expect(yogurtItem.min_stock).toBe(3);
      expect(yogurtItem.current_stock).toBe(1);
      expect(yogurtItem.deficit).toBe(2); // ceil(3 - 1) = 2
    });

    it('auto-adds deficit to shopping list when auto_add is true', async () => {
      const result = await belowMinStock.handler({ auto_add: true }, ctx);
      const data = parseToolResult(result);

      expect(data.added_to_shopping).toBe(true);

      // Verify shopping list now contains the auto-added item
      const shopResult = await getShoppingList.handler({}, ctx);
      const shopData = parseToolResult(shopResult);

      expect(shopData.total_items).toBeGreaterThanOrEqual(1);

      const yogurtItem = shopData.items.find((i: any) => i.product_id === secondProductId);
      expect(yogurtItem).toBeDefined();
      expect(Number(yogurtItem.qty_containers)).toBe(2); // deficit amount
    });

    it('returns empty when no products have min_stock set', async () => {
      // Create a separate context scenario: clear min_stock on all products
      // Instead, create a new user to test cleanly
      const freshUser = await createTestUser('chefbyte-below-empty');
      const freshCtx = createToolContext(freshUser.userId);

      try {
        const result = await belowMinStock.handler({}, freshCtx);
        const data = parseToolResult(result);

        expect(data.below_min).toEqual([]);
        expect(data.total).toBe(0);
      } finally {
        await freshUser.cleanup();
      }
    });

    it('does not add to shopping when auto_add is false', async () => {
      // Clear shopping first
      await clearShopping.handler({}, ctx);

      const result = await belowMinStock.handler({ auto_add: false }, ctx);
      const data = parseToolResult(result);

      expect(data.added_to_shopping).toBe(false);

      // Shopping list should still be empty
      const shopResult = await getShoppingList.handler({}, ctx);
      const shopData = parseToolResult(shopResult);
      expect(shopData.total_items).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 12. logTempItem
  // -----------------------------------------------------------------------

  describe('logTempItem', () => {
    it('logs a temporary food item with full macros', async () => {
      const result = await logTempItem.handler(
        {
          name: 'Birthday Cake Slice',
          calories: 350,
          carbs: 45,
          protein: 4,
          fat: 18,
        },
        ctx,
      );
      const data = parseToolResult(result);

      expect(data.message).toContain('Birthday Cake Slice');
      expect(data.message).toContain('350');
      expect(data.item).toBeDefined();
      expect(data.item.temp_id).toBeTruthy();
      expect(data.item.name).toBe('Birthday Cake Slice');
      expect(Number(data.item.calories)).toBe(350);
      expect(Number(data.item.carbs)).toBe(45);
      expect(Number(data.item.protein)).toBe(4);
      expect(Number(data.item.fat)).toBe(18);
      expect(data.item.logical_date).toBeTruthy();
    });

    it('logs a temp item with only required fields', async () => {
      const result = await logTempItem.handler(
        {
          name: 'Random Snack',
          calories: 100,
        },
        ctx,
      );
      const data = parseToolResult(result);

      expect(data.item.name).toBe('Random Snack');
      expect(Number(data.item.calories)).toBe(100);
    });
  });

  // -----------------------------------------------------------------------
  // 13. getMacros
  // -----------------------------------------------------------------------

  describe('getMacros', () => {
    it('returns daily macro summary for today', async () => {
      const result = await getMacros.handler({}, ctx);
      const data = parseToolResult(result);

      // The RPC returns JSONB with calories, carbs, protein, fat objects
      expect(data).toBeDefined();
      expect(data.calories).toBeDefined();
      expect(data.calories).toHaveProperty('consumed');
      expect(data.calories).toHaveProperty('goal');
      expect(data.calories).toHaveProperty('remaining');

      expect(data.protein).toBeDefined();
      expect(data.carbs).toBeDefined();
      expect(data.fat).toBeDefined();

      // We logged a consume with macros + 2 temp items today
      // consume: 800 cal, 120 protein, 0 carbs, 20 fat (1 container * 4 servings)
      // temp1: 350 cal, 4 protein, 45 carbs, 18 fat
      // temp2: 100 cal
      // Total should be at least 1250 cal
      expect(Number(data.calories.consumed)).toBeGreaterThanOrEqual(1250);
    });

    it('returns zeroed macros for a date with no entries', async () => {
      const result = await getMacros.handler({ date: '2020-01-01' }, ctx);
      const data = parseToolResult(result);

      expect(Number(data.calories.consumed)).toBe(0);
      expect(Number(data.protein.consumed)).toBe(0);
      expect(Number(data.carbs.consumed)).toBe(0);
      expect(Number(data.fat.consumed)).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 14. createRecipe — create a recipe with ingredients
  // -----------------------------------------------------------------------

  describe('createRecipe', () => {
    let recipeId: string;

    it('creates a recipe with ingredients referencing existing products', async () => {
      // Before: no recipes exist
      const beforeResult = await getRecipes.handler({}, ctx);
      const beforeData = parseToolResult(beforeResult);
      const recipeCountBefore = beforeData.total;

      const result = await createRecipe.handler(
        {
          name: 'Test Chicken Bowl',
          description: 'Cook chicken, add yogurt on top.',
          base_servings: 2,
          active_time: 20,
          ingredients: [
            { product_id: productId, quantity: 1 },
            { product_id: secondProductId, quantity: 0.5 },
          ],
        },
        ctx,
      );
      const data = parseToolResult(result);

      expect(data.message).toContain('Test Chicken Bowl');
      expect(data.message).toContain('2 ingredient(s)');
      expect(data.recipe.recipe_id).toBeTruthy();
      expect(data.recipe.name).toBe('Test Chicken Bowl');
      recipeId = data.recipe.recipe_id;

      // After: recipe count increased
      const afterResult = await getRecipes.handler({}, ctx);
      const afterData = parseToolResult(afterResult);
      expect(afterData.total).toBe(recipeCountBefore + 1);
    });

    it('rejects a recipe with no ingredients', async () => {
      const result = await createRecipe.handler({ name: 'Empty Recipe', ingredients: [] }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('ingredient');
    });

    it('the created recipe is retrievable with ingredients and macros', async () => {
      const result = await getRecipes.handler({ search: 'Chicken Bowl' }, ctx);
      const data = parseToolResult(result);

      expect(data.total).toBe(1);
      const recipe = data.recipes[0];
      expect(recipe.recipe_id).toBe(recipeId);
      expect(recipe.name).toBe('Test Chicken Bowl');
      expect(recipe.description).toBe('Cook chicken, add yogurt on top.');
      expect(recipe.base_servings).toBe(2);
      expect(recipe.active_time).toBe(20);
      expect(recipe.ingredients).toHaveLength(2);

      // Verify ingredient product references are resolved
      const chickenIng = recipe.ingredients.find((i: any) => i.product_id === productId);
      expect(chickenIng).toBeDefined();
      expect(chickenIng.product_name).toBe('Test Chicken Breast');
      expect(chickenIng.quantity).toBe(1);

      const yogurtIng = recipe.ingredients.find((i: any) => i.product_id === secondProductId);
      expect(yogurtIng).toBeDefined();
      expect(yogurtIng.product_name).toBe('Test Greek Yogurt');
      expect(yogurtIng.quantity).toBe(0.5);
    });
  });

  // -----------------------------------------------------------------------
  // 15. getRecipes — list/search recipes
  // -----------------------------------------------------------------------

  describe('getRecipes', () => {
    it('lists all recipes for the user', async () => {
      const result = await getRecipes.handler({}, ctx);
      const data = parseToolResult(result);

      expect(data.recipes).toBeInstanceOf(Array);
      expect(data.total).toBeGreaterThanOrEqual(1);

      const names = data.recipes.map((r: any) => r.name);
      expect(names).toContain('Test Chicken Bowl');
    });

    it('filters recipes by search term', async () => {
      const result = await getRecipes.handler({ search: 'Chicken' }, ctx);
      const data = parseToolResult(result);

      expect(data.total).toBe(1);
      expect(data.recipes[0].name).toBe('Test Chicken Bowl');
    });

    it('returns empty for non-matching search', async () => {
      const result = await getRecipes.handler({ search: 'XYZNONEXISTENT' }, ctx);
      const data = parseToolResult(result);

      expect(data.total).toBe(0);
      expect(data.recipes).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // 16. getCookable — recipes makeable with current stock
  // -----------------------------------------------------------------------

  describe('getCookable', () => {
    it('returns cookable recipes based on current stock levels', async () => {
      // Our recipe needs: 1 container Chicken Breast + 0.5 container Greek Yogurt
      // Current stock: Chicken Breast has some stock (re-added in edge case tests),
      // Greek Yogurt has 1 container.
      // First ensure we have enough stock for the recipe
      await addStock.handler({ product_id: productId, qty_containers: 3, location_id: locationId }, ctx);

      const result = await getCookable.handler({}, ctx);
      const data = parseToolResult(result);

      expect(data.cookable).toBeInstanceOf(Array);

      const chickenBowl = data.cookable.find((c: any) => c.name === 'Test Chicken Bowl');
      expect(chickenBowl).toBeDefined();
      expect(chickenBowl.max_batches).toBeGreaterThanOrEqual(1);
      expect(chickenBowl.servings_per_batch).toBe(2); // base_servings from recipe
      if (chickenBowl.max_servings !== null) {
        expect(chickenBowl.max_servings).toBe(chickenBowl.max_batches * 2);
      }
    });

    it('returns empty when no recipes are cookable', async () => {
      // Create a user with no stock
      const freshUser = await createTestUser('chefbyte-cookable-empty');
      const freshCtx = createToolContext(freshUser.userId);

      try {
        // Create a recipe with an ingredient that has no stock
        const { data: tmpProduct } = await admin
          .schema('chefbyte')
          .from('products')
          .insert({ user_id: freshUser.userId, name: 'Rare Ingredient' })
          .select('product_id')
          .single();

        await createRecipe.handler(
          {
            name: 'Impossible Recipe',
            ingredients: [{ product_id: tmpProduct!.product_id, quantity: 10 }],
          },
          freshCtx,
        );

        const result = await getCookable.handler({}, freshCtx);
        const data = parseToolResult(result);

        expect(data.cookable).toEqual([]);
        expect(data.total).toBe(0);
      } finally {
        await freshUser.cleanup();
      }
    });
  });

  // -----------------------------------------------------------------------
  // 17. addMeal — add a meal plan entry
  // -----------------------------------------------------------------------

  describe('addMeal', () => {
    let mealId: string;
    const today = new Date().toISOString().slice(0, 10);

    it('adds a meal plan entry with a product', async () => {
      // Before: no meal plan entries for today
      const beforeResult = await getMealPlan.handler({ start_date: today, end_date: today }, ctx);
      const beforeData = parseToolResult(beforeResult);
      const mealCountBefore = beforeData.total;

      const result = await addMeal.handler(
        {
          logical_date: today,
          product_id: productId,
          servings: 2,
        },
        ctx,
      );
      const data = parseToolResult(result);

      expect(data.message).toBe('Meal plan entry added');
      expect(data.meal.meal_id).toBeTruthy();
      expect(data.meal.logical_date).toBe(today);
      expect(data.meal.product_id).toBe(productId);
      expect(Number(data.meal.servings)).toBe(2);
      mealId = data.meal.meal_id;

      // After: meal count increased by 1
      const afterResult = await getMealPlan.handler({ start_date: today, end_date: today }, ctx);
      const afterData = parseToolResult(afterResult);
      expect(afterData.total).toBe(mealCountBefore + 1);
    });

    it('adds a meal plan entry with a recipe', async () => {
      // Get our recipe ID
      const recipesResult = await getRecipes.handler({ search: 'Chicken Bowl' }, ctx);
      const recipesData = parseToolResult(recipesResult);
      const recipeId = recipesData.recipes[0].recipe_id;

      const result = await addMeal.handler(
        {
          logical_date: today,
          recipe_id: recipeId,
        },
        ctx,
      );
      const data = parseToolResult(result);

      expect(data.meal.recipe_id).toBe(recipeId);
    });

    it('rejects a meal with neither recipe_id nor product_id', async () => {
      const result = await addMeal.handler({ logical_date: today }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('recipe_id or product_id');
    });

    // Store mealId for markDone test
    it('getMealPlan confirms the entries exist with product/recipe names', () => {
      // mealId is set by the first addMeal test — used by markDone below.
      // Verify it was populated with a real UUID (not just truthy — e.g. the
      // string 'undefined' or '0' would also pass toBeTruthy).
      expect(typeof mealId).toBe('string');
      expect(mealId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  // -----------------------------------------------------------------------
  // 18. getMealPlan — list meal plan entries for a date range
  // -----------------------------------------------------------------------

  describe('getMealPlan', () => {
    const today = new Date().toISOString().slice(0, 10);

    it('returns meal plan entries with resolved names', async () => {
      const result = await getMealPlan.handler({ start_date: today, end_date: today }, ctx);
      const data = parseToolResult(result);

      expect(data.entries).toBeInstanceOf(Array);
      expect(data.total).toBeGreaterThanOrEqual(2);

      // Verify product-based entry
      const productEntry = data.entries.find((e: any) => e.product_id === productId);
      expect(productEntry).toBeDefined();
      expect(productEntry.product_name).toBe('Test Chicken Breast');
      expect(productEntry.completed).toBe(false);

      // Verify recipe-based entry
      const recipeEntry = data.entries.find((e: any) => e.recipe_id != null);
      expect(recipeEntry).toBeDefined();
      expect(recipeEntry.recipe_name).toBe('Test Chicken Bowl');
    });

    it('returns empty for a date range with no entries', async () => {
      const result = await getMealPlan.handler({ start_date: '2020-01-01', end_date: '2020-01-01' }, ctx);
      const data = parseToolResult(result);

      expect(data.entries).toEqual([]);
      expect(data.total).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 19. markDone — mark a meal plan entry as completed
  // -----------------------------------------------------------------------

  describe('markDone', () => {
    const today = new Date().toISOString().slice(0, 10);

    it('marks a meal plan entry as completed and verifies state change', async () => {
      // Find the product-based entry's meal_id
      const planResult = await getMealPlan.handler({ start_date: today, end_date: today }, ctx);
      const planData = parseToolResult(planResult);
      const productEntry = planData.entries.find((e: any) => e.product_id === productId && !e.completed);
      expect(productEntry).toBeDefined();
      expect(productEntry.completed).toBe(false);

      const mealId = productEntry.meal_id;

      // Mark done
      const result = await markDone.handler({ meal_id: mealId }, ctx);
      const data = parseToolResult(result);
      expect(data).toBeDefined();

      // After: verify the entry is now completed
      const afterResult = await getMealPlan.handler({ start_date: today, end_date: today }, ctx);
      const afterData = parseToolResult(afterResult);
      const updatedEntry = afterData.entries.find((e: any) => e.meal_id === mealId);
      expect(updatedEntry).toBeDefined();
      expect(updatedEntry.completed).toBe(true);
      expect(updatedEntry.completed_at).toBeTruthy();
    });

    it('rejects marking a non-existent meal', async () => {
      const result = await markDone.handler({ meal_id: '00000000-0000-0000-0000-000000000000' }, ctx);
      expect(result.isError).toBe(true);
    });

    // -----------------------------------------------------------------
    // Atomicity: insufficient stock → full rollback (Bug B)
    // -----------------------------------------------------------------
    // Drives the atomic mark_meal_done RPC end-to-end. Seeds a recipe
    // where one ingredient is short of stock, calls CHEFBYTE_mark_done,
    // and asserts:
    //   (a) handler returns isError=true with an "Insufficient stock" message
    //   (b) the *other* ingredient's stock is untouched (no partial deduct)
    //   (c) the meal stays uncompleted
    //   (d) no food_logs were written for the meal_id
    it('insufficient stock on any ingredient rolls back the whole mark_meal_done', async () => {
      const u = await createTestUser('chefbyte-markdone-atomic');
      const uctx = createToolContext(u.userId);
      try {
        // Two products: one with plenty of stock, one with almost none.
        const plentyRes = parseToolResult(await createProduct.handler({ name: 'AtomicChickenMCP' }, uctx));
        const shortRes = parseToolResult(await createProduct.handler({ name: 'AtomicRiceMCP' }, uctx));
        const plentyId = plentyRes.product.product_id;
        const shortId = shortRes.product.product_id;

        // Plenty: 5 containers. Short: 0.1 container.
        await addStock.handler({ product_id: plentyId, qty_containers: 5 }, uctx);
        await addStock.handler({ product_id: shortId, qty_containers: 0.1 }, uctx);

        // Recipe requires 1 container of each; base_servings=2, meal
        // servings=2 → scale_factor 1.0 → needs 1 short container
        // which is MORE than the 0.1 in stock.
        const recipeRes = parseToolResult(
          await createRecipe.handler(
            {
              name: 'AtomicRollbackBowl',
              base_servings: 2,
              ingredients: [
                { product_id: plentyId, quantity: 1, unit: 'container' },
                { product_id: shortId, quantity: 1, unit: 'container' },
              ],
            },
            uctx,
          ),
        );
        const recipeId = recipeRes.recipe.recipe_id;

        const today = new Date().toISOString().slice(0, 10);
        const mealRes = parseToolResult(
          await addMeal.handler({ logical_date: today, recipe_id: recipeId, servings: 2 }, uctx),
        );
        const mealId = mealRes.meal.meal_id;

        // (a) Handler surfaces the raise as isError=true + a stock message.
        const result = await markDone.handler({ meal_id: mealId }, uctx);
        expect(result.isError).toBe(true);
        const errMsg = (result.content?.[0] as any)?.text ?? '';
        expect(errMsg.toLowerCase()).toContain('insufficient stock');

        // (b) Plenty-stock ingredient is untouched.
        const plentyLots = parseToolResult(await getProductLots.handler({ product_id: plentyId }, uctx));
        const plentyTotal = plentyLots.lots.reduce((sum: number, l: any) => sum + Number(l.qty_containers), 0);
        expect(plentyTotal).toBeCloseTo(5, 3);

        // (c) Short-stock ingredient is also untouched (still 0.1).
        const shortLots = parseToolResult(await getProductLots.handler({ product_id: shortId }, uctx));
        const shortTotal = shortLots.lots.reduce((sum: number, l: any) => sum + Number(l.qty_containers), 0);
        expect(shortTotal).toBeCloseTo(0.1, 3);

        // (d) Meal stays uncompleted.
        const afterPlan = parseToolResult(await getMealPlan.handler({ start_date: today, end_date: today }, uctx));
        const entry = afterPlan.entries.find((e: any) => e.meal_id === mealId);
        expect(entry).toBeDefined();
        expect(entry.completed).toBe(false);

        // (e) No food_logs written for the meal_id (verify via admin).
        const { data: logs } = await admin
          .schema('chefbyte')
          .from('food_logs')
          .select('log_id')
          .eq('user_id', u.userId)
          .eq('meal_id', mealId);
        expect(logs ?? []).toEqual([]);
      } finally {
        await u.cleanup();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Cross-cutting: user isolation
  // -----------------------------------------------------------------------

  describe('User Isolation', () => {
    it("cannot see another user's products", async () => {
      const otherUser = await createTestUser('chefbyte-isolation');
      const otherCtx = createToolContext(otherUser.userId);

      try {
        const result = await getProducts.handler({}, otherCtx);
        const data = parseToolResult(result);

        // Other user should see zero products
        expect(data.total).toBe(0);
        expect(data.products).toEqual([]);
      } finally {
        await otherUser.cleanup();
      }
    });

    it("cannot see another user's inventory", async () => {
      const otherUser = await createTestUser('chefbyte-isolation-inv');
      const otherCtx = createToolContext(otherUser.userId);

      try {
        const result = await getInventory.handler({}, otherCtx);
        const data = parseToolResult(result);

        expect(data.total_products).toBe(0);
        expect(data.inventory).toEqual([]);
      } finally {
        await otherUser.cleanup();
      }
    });

    it("cannot consume another user's stock", async () => {
      const otherUser = await createTestUser('chefbyte-isolation-consume');
      const otherCtx = createToolContext(otherUser.userId);

      try {
        // Try to consume the main user's product with the other user's context
        const result = await consume.handler(
          {
            product_id: productId,
            qty: 1,
            unit: 'container',
          },
          otherCtx,
        );
        // Should fail because the product belongs to a different user
        expect(result.isError).toBe(true);
      } finally {
        await otherUser.cleanup();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('Edge Cases', () => {
    it('handles consuming from product with zero stock gracefully', async () => {
      // Create a fresh product with no stock to test zero-stock consume
      const createResult = await createProduct.handler({ name: 'Zero Stock Product' }, ctx);
      const zeroProduct = parseToolResult(createResult);

      const result = await consume.handler(
        {
          product_id: zeroProduct.product.product_id,
          qty: 1,
          unit: 'container',
          log_macros: false,
        },
        ctx,
      );
      const data = parseToolResult(result);

      // Should succeed with stock_remaining = 0 (stock floors at 0)
      expect(data.success).toBe(true);
      expect(Number(data.stock_remaining)).toBe(0);

      // H6 fix: Re-query stock_lots to confirm no lots exist for this product
      const lotsResult = await getProductLots.handler({ product_id: zeroProduct.product.product_id }, ctx);
      const lotsData = parseToolResult(lotsResult);
      expect(lotsData.total_lots).toBe(0);
      expect(lotsData.lots).toHaveLength(0);
    });

    it('consumes by servings (converts to containers)', async () => {
      // Create a fresh product to test serving-based consumption in isolation
      const createRes = await createProduct.handler({ name: 'Serving Test Product' }, ctx);
      const servProd = parseToolResult(createRes);
      const servProdId = servProd.product.product_id;

      // Set servings_per_container so the conversion works
      await admin
        .schema('chefbyte')
        .from('products')
        .update({ servings_per_container: 4 })
        .eq('product_id', servProdId);

      // Add exactly 2 containers of stock
      await addStock.handler({ product_id: servProdId, qty_containers: 2, location_id: locationId }, ctx);

      // Consume 4 servings = 1 container (servings_per_container = 4)
      const result = await consume.handler(
        {
          product_id: servProdId,
          qty: 4,
          unit: 'serving',
          log_macros: false,
        },
        ctx,
      );
      const data = parseToolResult(result);

      expect(data.success).toBe(true);
      // 2 - 1 = 1 container remaining
      expect(Number(data.stock_remaining)).toBe(1);

      // H6 fix: Re-query stock_lots to verify actual DB state after serving-based consume
      const lotsResult = await getProductLots.handler({ product_id: servProdId }, ctx);
      const lotsData = parseToolResult(lotsResult);
      expect(lotsData.total_lots).toBe(1);
      expect(Number(lotsData.lots[0].qty_containers)).toBe(1);
    });

    it('setPrice updates price to zero', async () => {
      const result = await setPrice.handler({ product_id: productId, price: 0 }, ctx);
      const data = parseToolResult(result);

      expect(Number(data.product.price)).toBe(0);

      // L11 fix: Re-read DB to confirm zero price persisted
      const { data: row, error } = await admin
        .schema('chefbyte')
        .from('products')
        .select('price')
        .eq('product_id', productId)
        .single();
      expect(error).toBeNull();
      expect(Number(row!.price)).toBe(0);
    });

    it('clearShopping on empty list is a no-op', async () => {
      // First ensure it's clear
      await clearShopping.handler({}, ctx);

      // Second call should still succeed
      const result = await clearShopping.handler({}, ctx);
      const data = parseToolResult(result);
      expect(data.message).toBe('Shopping list cleared');
    });

    it('getProductLots for non-existent product returns empty', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const result = await getProductLots.handler({ product_id: fakeId }, ctx);
      const data = parseToolResult(result);

      expect(data.product_id).toBe(fakeId);
      expect(data.lots).toEqual([]);
      expect(data.total_lots).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 20. updateProduct — update product fields
  // -----------------------------------------------------------------------

  describe('updateProduct', () => {
    it('updates product name', async () => {
      const result = await updateProduct.handler({ product_id: productId, name: 'Grilled Chicken Breast' }, ctx);
      const data = parseToolResult(result);

      expect(data.message).toContain('Grilled Chicken Breast');
      expect(data.product.product_id).toBe(productId);
      expect(data.product.name).toBe('Grilled Chicken Breast');
    });

    it('updates macros (calories, protein, carbs, fat)', async () => {
      const result = await updateProduct.handler(
        {
          product_id: secondProductId,
          calories_per_serving: 165,
          protein_per_serving: 31,
          carbs_per_serving: 0,
          fat_per_serving: 3.6,
        },
        ctx,
      );
      const data = parseToolResult(result);

      expect(data.message).toContain('updated');
      expect(data.product.product_id).toBe(secondProductId);

      // Verify the macros were actually updated in the DB
      const { data: dbProduct } = await admin
        .schema('chefbyte')
        .from('products')
        .select('calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving')
        .eq('product_id', secondProductId)
        .single();

      expect(Number(dbProduct!.calories_per_serving)).toBe(165);
      expect(Number(dbProduct!.protein_per_serving)).toBe(31);
      expect(Number(dbProduct!.carbs_per_serving)).toBe(0);
      expect(Number(dbProduct!.fat_per_serving)).toBe(3.6);
    });

    it('updates barcode', async () => {
      const result = await updateProduct.handler({ product_id: productId, barcode: '9876543210' }, ctx);
      const data = parseToolResult(result);

      expect(data.product.barcode).toBe('9876543210');
    });

    it('returns error when no fields provided besides product_id', async () => {
      const result = await updateProduct.handler({ product_id: productId }, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No fields to update');
    });

    it('returns error for non-existent product', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const result = await updateProduct.handler({ product_id: fakeId, name: 'Ghost' }, ctx);

      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 21. deleteShoppingItem — delete a single shopping list item
  // -----------------------------------------------------------------------

  describe('deleteShoppingItem', () => {
    let tempItemId: string;

    it('deletes a shopping item successfully', async () => {
      // Seed a shopping item
      await addToShopping.handler({ product_id: productId, qty_containers: 1 }, ctx);
      const listResult = await getShoppingList.handler({}, ctx);
      const listData = parseToolResult(listResult);
      const item = listData.items.find((i: any) => i.product_id === productId);
      expect(item).toBeDefined();
      tempItemId = item.id;

      const result = await deleteShoppingItem.handler({ item_id: tempItemId }, ctx);
      const data = parseToolResult(result);

      expect(data.message).toBe('Shopping item deleted');
      expect(data.item_id).toBe(tempItemId);

      // Verify it's gone
      const afterResult = await getShoppingList.handler({}, ctx);
      const afterData = parseToolResult(afterResult);
      const deleted = afterData.items.find((i: any) => i.id === tempItemId);
      expect(deleted).toBeUndefined();
    });

    it('returns error for non-existent item', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const result = await deleteShoppingItem.handler({ item_id: fakeId }, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });
  });

  // -----------------------------------------------------------------------
  // 22. togglePurchased — toggle purchased status on shopping item
  // -----------------------------------------------------------------------

  describe('togglePurchased', () => {
    let toggleItemId: string;

    it('toggles item to purchased=true', async () => {
      // Seed a shopping item
      await addToShopping.handler({ product_id: secondProductId, qty_containers: 2 }, ctx);
      const listResult = await getShoppingList.handler({}, ctx);
      const listData = parseToolResult(listResult);
      const item = listData.items.find((i: any) => i.product_id === secondProductId);
      expect(item).toBeDefined();
      toggleItemId = item.id;

      // Toggle on (purchased = true)
      const result = await togglePurchased.handler({ item_id: toggleItemId }, ctx);
      const data = parseToolResult(result);

      expect(data.message).toContain('purchased');
      expect(data.item.purchased).toBe(true);
      expect(data.item.id).toBe(toggleItemId);
      expect(data.item.qty_containers).toBe(2);
    });

    it('toggles item back to purchased=false', async () => {
      const result = await togglePurchased.handler({ item_id: toggleItemId }, ctx);
      const data = parseToolResult(result);

      expect(data.message).toContain('not purchased');
      expect(data.item.purchased).toBe(false);
    });

    it('returns error for non-existent item', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const result = await togglePurchased.handler({ item_id: fakeId }, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    // Cleanup: clear shopping for subsequent tests
    it('cleanup — clear shopping list', async () => {
      await clearShopping.handler({}, ctx);
    });
  });

  // -----------------------------------------------------------------------
  // 23. importShoppingToInventory — import purchased items to stock
  // -----------------------------------------------------------------------

  describe('importShoppingToInventory', () => {
    it('imports purchased shopping items into inventory and removes them', async () => {
      // Seed two shopping items and mark them as purchased
      await addToShopping.handler({ product_id: productId, qty_containers: 3 }, ctx);
      await addToShopping.handler({ product_id: secondProductId, qty_containers: 1 }, ctx);

      const listResult = await getShoppingList.handler({}, ctx);
      const listData = parseToolResult(listResult);
      expect(listData.total_items).toBe(2);

      // Toggle both to purchased (getShoppingList returns items with `id`, not `cart_item_id`)
      for (const item of listData.items) {
        await togglePurchased.handler({ item_id: item.id }, ctx);
      }

      // Verify they are purchased via admin client (getShoppingList doesn't expose purchased)
      const { data: dbItems } = await admin
        .schema('chefbyte')
        .from('shopping_list')
        .select('cart_item_id, purchased')
        .eq('user_id', userId);
      expect(dbItems!.every((i: any) => i.purchased === true)).toBe(true);

      // Import. ctx.supabase is the service-role client (no JWT), so this
      // exercises the H-18 fix: the handler must call the _admin overload with
      // ctx.userId — the auth.uid()-based wrapper would raise 'No storage
      // locations found' here because auth.uid() is NULL under service_role.
      const result = await importShoppingToInventory.handler({}, ctx);
      const data = parseToolResult(result);

      // Handler return shape is { message, lots_created, imported_at } — there
      // is no `lots` array (the old assertion was stale; the RPC returns a
      // JSONB summary, not per-lot rows). lots_created=2 is the RPC's own
      // report that both purchased rows were processed — the core H-18 proof
      // that the import ran (pre-fix it raised 'No storage locations found'
      // under service_role). Exact per-lot qty is asserted on a clean,
      // isolated user in the pgTAP test (mcp_admin_overloads.test.sql); here
      // both products already carry residual lots from the addStock/consume
      // describes above, so a total-qty assertion would be order-dependent.
      expect(data.message).toContain('2 item(s)');
      expect(data.lots_created).toBe(2);
      expect(data.imported_at).toBeTruthy();
      expect(data.lots).toBeUndefined();

      // Both imported products have at least one VISIBLE (not ghosted) lot —
      // proves the import wrote real, spendable stock rather than landing on a
      // tombstone (the C-2 ghost-import class, now closed by the T1 trigger).
      const { data: lots } = await admin
        .schema('chefbyte')
        .from('stock_lots')
        .select('product_id, qty_containers, deleted_at')
        .eq('user_id', userId)
        .is('deleted_at', null);
      expect(lots!.some((l: any) => l.product_id === productId)).toBe(true);
      expect(lots!.some((l: any) => l.product_id === secondProductId)).toBe(true);

      // Verify the imported rows left the ACTIVE cart: the import stamps
      // imported_at (it does NOT delete rows — that has been the design since
      // migration 20260425010000). The active cart is `imported_at IS NULL`.
      // (We assert against the DB directly rather than getShoppingList, which
      // does not yet filter imported_at — a separate finding, SEAM-MCP-03.)
      const { data: activeRows } = await admin
        .schema('chefbyte')
        .from('shopping_list')
        .select('cart_item_id')
        .eq('user_id', userId)
        .is('imported_at', null);
      expect(activeRows).toHaveLength(0);

      const { data: importedRows } = await admin
        .schema('chefbyte')
        .from('shopping_list')
        .select('cart_item_id')
        .eq('user_id', userId)
        .not('imported_at', 'is', null);
      expect(importedRows).toHaveLength(2);
    });

    it('returns error when no purchased items exist', async () => {
      // Shopping list should be empty after the previous test
      const result = await importShoppingToInventory.handler({}, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No purchased items');
    });

    it('does not import unpurchased items', async () => {
      // Add an item but do NOT mark it as purchased
      await addToShopping.handler({ product_id: productId, qty_containers: 5 }, ctx);

      const result = await importShoppingToInventory.handler({}, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No purchased items');

      // Cleanup
      await clearShopping.handler({}, ctx);
    });
  });

  // -----------------------------------------------------------------------
  // 23b. updateRecipe — metadata patch + full ingredient replacement (H-17)
  // -----------------------------------------------------------------------
  // ctx.supabase is the service-role client (no JWT), so the ingredient-replace
  // path here is the exact MCP condition from H-17: auth.uid() is NULL inside
  // the RPC. Before the fix the handler called the 2-arg public wrapper, which
  // forwarded private.save_recipe_ingredients(NULL, …) → 'Recipe not found'.
  // The handler now calls save_recipe_ingredients_admin with ctx.userId.

  describe('updateRecipe', () => {
    let recipeId: string;

    it('creates a recipe to update (2 ingredients)', async () => {
      const result = await createRecipe.handler(
        {
          name: 'Update Target Recipe',
          base_servings: 2,
          ingredients: [
            { product_id: productId, quantity: 1 },
            { product_id: secondProductId, quantity: 0.5 },
          ],
        },
        ctx,
      );
      const data = parseToolResult(result);
      recipeId = data.recipe.recipe_id;
      expect(recipeId).toBeTruthy();
    });

    it('fully replaces the ingredient list via the service-role _admin overload (H-17)', async () => {
      const result = await updateRecipe.handler(
        {
          recipe_id: recipeId,
          name: 'Updated Recipe Name',
          // Replace the 2-ingredient list with a single different ingredient.
          ingredients: [{ product_id: secondProductId, quantity: 3, unit: 'container' }],
        },
        ctx,
      );
      const data = parseToolResult(result);
      expect(data.success).toBe(true);
      expect(data.ingredients_replaced).toBe(true);
      expect(data.meta_fields_updated).toContain('name');

      // The ingredient list was actually replaced (not a no-op / partial fail):
      // exactly one ingredient now, and it is the new product+qty.
      const { data: ings } = await admin
        .schema('chefbyte')
        .from('recipe_ingredients')
        .select('product_id, quantity')
        .eq('recipe_id', recipeId);
      expect(ings).toHaveLength(1);
      expect(ings![0].product_id).toBe(secondProductId);
      expect(Number(ings![0].quantity)).toBe(3);

      // And the metadata patch landed.
      const { data: recipeRow } = await admin
        .schema('chefbyte')
        .from('recipes')
        .select('name')
        .eq('recipe_id', recipeId)
        .single();
      expect(recipeRow!.name).toBe('Updated Recipe Name');
    });

    it('patches metadata only when ingredients omitted (list untouched)', async () => {
      const result = await updateRecipe.handler({ recipe_id: recipeId, base_servings: 5 }, ctx);
      const data = parseToolResult(result);
      expect(data.ingredients_replaced).toBe(false);

      // The single ingredient from the previous replace is still present.
      const { data: ings } = await admin
        .schema('chefbyte')
        .from('recipe_ingredients')
        .select('product_id')
        .eq('recipe_id', recipeId);
      expect(ings).toHaveLength(1);

      // Cleanup so later recipe-count assertions are unaffected.
      await deleteRecipe.handler({ recipe_id: recipeId }, ctx);
    });
  });

  // -----------------------------------------------------------------------
  // 24. deleteMealEntry — delete a meal plan entry
  // -----------------------------------------------------------------------

  describe('deleteMealEntry', () => {
    const today = new Date().toISOString().slice(0, 10);
    let testMealId: string;

    it('creates a meal entry for deletion test', async () => {
      const result = await addMeal.handler({ logical_date: today, product_id: productId, servings: 1 }, ctx);
      const data = parseToolResult(result);
      testMealId = data.meal.meal_id;
      // A meaningful identity check: UUID shape, not just truthiness.
      expect(typeof testMealId).toBe('string');
      expect(testMealId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(data.meal.logical_date).toBe(today);
      expect(data.meal.product_id).toBe(productId);
    });

    it('deletes the meal entry successfully', async () => {
      const result = await deleteMealEntry.handler({ meal_id: testMealId }, ctx);
      const data = parseToolResult(result);

      expect(data.message).toBe('Meal plan entry deleted');
      expect(data.meal_id).toBe(testMealId);

      // Verify it's gone
      const planResult = await getMealPlan.handler({ start_date: today, end_date: today }, ctx);
      const planData = parseToolResult(planResult);
      const found = planData.entries.find((e: any) => e.meal_id === testMealId);
      expect(found).toBeUndefined();
    });

    it('returns error for non-existent meal entry', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const result = await deleteMealEntry.handler({ meal_id: fakeId }, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });
  });

  // -----------------------------------------------------------------------
  // Bug 1 (2026-04-22 audit): get_products / get_recipes ilike wildcard escape
  // -----------------------------------------------------------------------

  describe('ilike wildcard escape (Bug 1)', () => {
    it('search:"%" does NOT match every product (escapes %)', async () => {
      // Use a dedicated user to get a clean, known product count.
      const u = await createTestUser('chefbyte-ilike-percent');
      const uctx = createToolContext(u.userId);
      try {
        await createProduct.handler({ name: 'Apple' }, uctx);
        await createProduct.handler({ name: 'Banana' }, uctx);
        await createProduct.handler({ name: 'Cherry' }, uctx);

        // Sanity: with empty search, we see 3
        const all = parseToolResult(await getProducts.handler({}, uctx));
        expect(all.total).toBe(3);

        // Bug 1 pin: search='%' must NOT return every row. Escaped, it becomes
        // a literal '%' which matches nothing in 'Apple', 'Banana', 'Cherry'.
        const pct = parseToolResult(await getProducts.handler({ search: '%' }, uctx));
        expect(pct.total).toBe(0);
      } finally {
        await u.cleanup();
      }
    });

    it('search:"_" does NOT match every product (escapes _)', async () => {
      const u = await createTestUser('chefbyte-ilike-underscore');
      const uctx = createToolContext(u.userId);
      try {
        await createProduct.handler({ name: 'Apple' }, uctx);
        await createProduct.handler({ name: 'Banana' }, uctx);

        // Pre-escape, '_' as ilike wildcard would match any single char, so a
        // 5-letter name like 'Apple' would be picked up by a single '_' with
        // the '%_%' wrap. Escaped, it matches literal '_' — zero rows.
        const underscore = parseToolResult(await getProducts.handler({ search: '_' }, uctx));
        expect(underscore.total).toBe(0);
      } finally {
        await u.cleanup();
      }
    });

    it('literal "%" in product name is still findable via escaped search', async () => {
      // If a user names a product 'Off 50% Deal' and searches '50%', the
      // escaped '%' becomes a literal and matches only that one product.
      const u = await createTestUser('chefbyte-ilike-literal');
      const uctx = createToolContext(u.userId);
      try {
        await createProduct.handler({ name: 'Off 50% Deal' }, uctx);
        await createProduct.handler({ name: 'Regular Item' }, uctx);

        const res = parseToolResult(await getProducts.handler({ search: '50%' }, uctx));
        expect(res.total).toBe(1);
        expect(res.products[0].name).toBe('Off 50% Deal');
      } finally {
        await u.cleanup();
      }
    });

    it('get_recipes:search="%" does NOT match every recipe (escapes %)', async () => {
      const u = await createTestUser('chefbyte-ilike-recipe');
      const uctx = createToolContext(u.userId);
      try {
        // Need a product to build a recipe.
        const prod = parseToolResult(await createProduct.handler({ name: 'Ingredient' }, uctx));
        await createRecipe.handler(
          {
            name: 'Alpha Bowl',
            ingredients: [{ product_id: prod.product.product_id, quantity: 1 }],
          },
          uctx,
        );
        await createRecipe.handler(
          {
            name: 'Beta Bowl',
            ingredients: [{ product_id: prod.product.product_id, quantity: 1 }],
          },
          uctx,
        );

        const all = parseToolResult(await getRecipes.handler({}, uctx));
        expect(all.total).toBe(2);

        const pct = parseToolResult(await getRecipes.handler({ search: '%' }, uctx));
        expect(pct.total).toBe(0);
      } finally {
        await u.cleanup();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Bug 3 (2026-04-22 audit): PGRST116 → clean "not found" messages
  // -----------------------------------------------------------------------

  describe('PGRST116 clean errors (Bug 3)', () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';

    it('update_product with non-existent UUID returns "not found" (not PGRST116 jargon)', async () => {
      const res = await updateProduct.handler({ product_id: fakeId, name: 'Ghost' }, ctx);
      expect(res.isError).toBe(true);
      const msg = res.content[0].text;
      expect(msg.toLowerCase()).toContain('not found');
      expect(msg).not.toContain('Cannot coerce');
      expect(msg).not.toContain('PGRST116');
    });

    it('set_price with non-existent UUID returns "not found"', async () => {
      const res = await setPrice.handler({ product_id: fakeId, price: 1.0 }, ctx);
      expect(res.isError).toBe(true);
      const msg = res.content[0].text;
      expect(msg.toLowerCase()).toContain('not found');
      expect(msg).not.toContain('Cannot coerce');
      expect(msg).not.toContain('PGRST116');
    });

    it('toggle_purchased with non-existent UUID returns "not found"', async () => {
      const res = await togglePurchased.handler({ item_id: fakeId }, ctx);
      expect(res.isError).toBe(true);
      const msg = res.content[0].text;
      expect(msg.toLowerCase()).toContain('not found');
      expect(msg).not.toContain('Cannot coerce');
      expect(msg).not.toContain('PGRST116');
    });
  });

  // -----------------------------------------------------------------------
  // Bug 4 (2026-04-22 audit): new delete tools
  // -----------------------------------------------------------------------

  describe('delete tools (Bug 4)', () => {
    it('delete_food_log: seed → delete → row gone', async () => {
      const u = await createTestUser('chefbyte-delete-food-log');
      const uctx = createToolContext(u.userId);
      try {
        const prod = parseToolResult(await createProduct.handler({ name: 'DeleteLogProd' }, uctx));
        const prodId = prod.product.product_id;

        // Give it macros so consume logs something non-trivial.
        await admin
          .schema('chefbyte')
          .from('products')
          .update({ calories_per_serving: 10, servings_per_container: 1 })
          .eq('product_id', prodId);

        // Seed stock and consume (creates a food_log row).
        const { data: locs } = await admin
          .schema('chefbyte')
          .from('locations')
          .select('location_id')
          .eq('user_id', u.userId)
          .limit(1);
        await addStock.handler({ product_id: prodId, qty_containers: 2, location_id: locs![0].location_id }, uctx);
        await consume.handler({ product_id: prodId, qty: 1, unit: 'container', log_macros: true }, uctx);

        const { data: logsBefore } = await admin
          .schema('chefbyte')
          .from('food_logs')
          .select('log_id')
          .eq('user_id', u.userId)
          .eq('product_id', prodId);
        expect(logsBefore!.length).toBe(1);
        const logId = logsBefore![0].log_id;

        const delRes = parseToolResult(await deleteFoodLog.handler({ log_id: logId }, uctx));
        expect(delRes.success).toBe(true);
        expect(delRes.deleted.log_id).toBe(logId);

        const { data: logsAfter } = await admin
          .schema('chefbyte')
          .from('food_logs')
          .select('log_id')
          .eq('user_id', u.userId)
          .eq('product_id', prodId);
        expect(logsAfter!.length).toBe(0);
      } finally {
        await u.cleanup();
      }
    });

    it('delete_food_log: non-existent log_id returns not-found error', async () => {
      const res = await deleteFoodLog.handler({ log_id: '00000000-0000-0000-0000-000000000000' }, ctx);
      expect(res.isError).toBe(true);
      expect(res.content[0].text.toLowerCase()).toContain('not found');
    });

    it('delete_temp_item: seed → delete → row gone', async () => {
      const u = await createTestUser('chefbyte-delete-temp-item');
      const uctx = createToolContext(u.userId);
      try {
        const logged = parseToolResult(await logTempItem.handler({ name: 'Coffee', calories: 5 }, uctx));
        const tempId = logged.item.temp_id;
        expect(tempId).toBeTruthy();

        const delRes = parseToolResult(await deleteTempItem.handler({ temp_id: tempId }, uctx));
        expect(delRes.success).toBe(true);
        expect(delRes.deleted.temp_id).toBe(tempId);

        const { data: rowsAfter } = await admin
          .schema('chefbyte')
          .from('temp_items')
          .select('temp_id')
          .eq('user_id', u.userId)
          .eq('temp_id', tempId);
        expect(rowsAfter!.length).toBe(0);
      } finally {
        await u.cleanup();
      }
    });

    it('delete_temp_item: non-existent temp_id returns not-found error', async () => {
      const res = await deleteTempItem.handler({ temp_id: '00000000-0000-0000-0000-000000000000' }, ctx);
      expect(res.isError).toBe(true);
      expect(res.content[0].text.toLowerCase()).toContain('not found');
    });

    it('delete_recipe: seed with no meal plan refs → delete → row gone', async () => {
      const u = await createTestUser('chefbyte-delete-recipe');
      const uctx = createToolContext(u.userId);
      try {
        const prod = parseToolResult(await createProduct.handler({ name: 'RecipeProd' }, uctx));
        const created = parseToolResult(
          await createRecipe.handler(
            {
              name: 'Disposable Recipe',
              ingredients: [{ product_id: prod.product.product_id, quantity: 1 }],
            },
            uctx,
          ),
        );
        const recipeId = created.recipe.recipe_id;

        const delRes = parseToolResult(await deleteRecipe.handler({ recipe_id: recipeId }, uctx));
        expect(delRes.success).toBe(true);
        expect(delRes.deleted.recipe_id).toBe(recipeId);
        expect(delRes.deleted.name).toBe('Disposable Recipe');

        // Recipe should be gone; recipe_ingredients cascaded.
        const { data: rcpAfter } = await admin
          .schema('chefbyte')
          .from('recipes')
          .select('recipe_id')
          .eq('recipe_id', recipeId);
        expect(rcpAfter!.length).toBe(0);

        const { data: ingsAfter } = await admin
          .schema('chefbyte')
          .from('recipe_ingredients')
          .select('ingredient_id')
          .eq('recipe_id', recipeId);
        expect(ingsAfter!.length).toBe(0);
      } finally {
        await u.cleanup();
      }
    });

    it('delete_recipe: blocks delete when meal_plan_entries still reference the recipe', async () => {
      const u = await createTestUser('chefbyte-delete-recipe-blocked');
      const uctx = createToolContext(u.userId);
      try {
        const prod = parseToolResult(await createProduct.handler({ name: 'BlockerProd' }, uctx));
        const created = parseToolResult(
          await createRecipe.handler(
            {
              name: 'Locked Recipe',
              ingredients: [{ product_id: prod.product.product_id, quantity: 1 }],
            },
            uctx,
          ),
        );
        const recipeId = created.recipe.recipe_id;

        // Add a meal plan entry referencing this recipe — no explicit
        // logical_date, server should derive it (Bug 5 fix).
        await addMeal.handler({ recipe_id: recipeId }, uctx);

        const res = await deleteRecipe.handler({ recipe_id: recipeId }, uctx);
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain('meal plan entries');

        // Recipe still exists.
        const { data: rcpStill } = await admin
          .schema('chefbyte')
          .from('recipes')
          .select('recipe_id')
          .eq('recipe_id', recipeId);
        expect(rcpStill!.length).toBe(1);
      } finally {
        await u.cleanup();
      }
    });

    it('delete_product: seed → delete → row gone (and stock cascades)', async () => {
      const u = await createTestUser('chefbyte-delete-product');
      const uctx = createToolContext(u.userId);
      try {
        const created = parseToolResult(await createProduct.handler({ name: 'Doomed Product' }, uctx));
        const prodId = created.product.product_id;
        const { data: locs } = await admin
          .schema('chefbyte')
          .from('locations')
          .select('location_id')
          .eq('user_id', u.userId)
          .limit(1);
        await addStock.handler({ product_id: prodId, qty_containers: 2, location_id: locs![0].location_id }, uctx);

        const delRes = parseToolResult(await deleteProduct.handler({ product_id: prodId }, uctx));
        expect(delRes.success).toBe(true);
        expect(delRes.deleted.product_id).toBe(prodId);

        const { data: prodAfter } = await admin
          .schema('chefbyte')
          .from('products')
          .select('product_id')
          .eq('product_id', prodId);
        expect(prodAfter!.length).toBe(0);

        // stock_lots should have cascaded.
        const { data: lotsAfter } = await admin
          .schema('chefbyte')
          .from('stock_lots')
          .select('lot_id')
          .eq('product_id', prodId);
        expect(lotsAfter!.length).toBe(0);
      } finally {
        await u.cleanup();
      }
    });

    it('delete_product: non-existent product_id returns not-found error', async () => {
      const res = await deleteProduct.handler({ product_id: '00000000-0000-0000-0000-000000000000' }, ctx);
      expect(res.isError).toBe(true);
      expect(res.content[0].text.toLowerCase()).toContain('not found');
    });
  });

  // -----------------------------------------------------------------------
  // Bug 5 (2026-04-22 audit): add_meal logical_date optional → server default
  // -----------------------------------------------------------------------

  describe('add_meal optional logical_date (Bug 5)', () => {
    it('omitting logical_date defaults to private.get_logical_date for the user', async () => {
      const u = await createTestUser('chefbyte-addmeal-default-date');
      const uctx = createToolContext(u.userId);
      try {
        const prod = parseToolResult(await createProduct.handler({ name: 'NoDateProd' }, uctx));

        // Call add_meal WITHOUT logical_date
        const res = parseToolResult(await addMeal.handler({ product_id: prod.product.product_id, servings: 1 }, uctx));
        expect(res.meal).toBeDefined();
        expect(res.meal.logical_date).toBeTruthy();

        // Fetch the user's current logical_date via the authoritative RPC
        // (mirrors what the handler should have used).
        const { data: rpcDate, error: rpcErr } = await (admin as any)
          .schema('private')
          .rpc('get_logical_date', { p_user_id: u.userId });
        // If the RPC isn't exposed to service_role, fall back to computing
        // via profile read (same logic the TS helper uses).
        let expected: string;
        if (!rpcErr && rpcDate) {
          expected = rpcDate as string;
        } else {
          const { data: profile } = await admin
            .schema('hub')
            .from('profiles')
            .select('timezone, day_start_hour')
            .eq('user_id', u.userId)
            .single();
          const tz = profile?.timezone || 'America/New_York';
          const dayStart = profile?.day_start_hour ?? 6;
          const now = new Date();
          const localDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
          const localHour = parseInt(
            new Intl.DateTimeFormat('en-US', {
              timeZone: tz,
              hour: 'numeric',
              hour12: false,
            }).format(now),
          );
          expected =
            localHour < dayStart
              ? new Date(new Date(localDateStr).getTime() - 86400000).toISOString().slice(0, 10)
              : localDateStr;
        }

        expect(res.meal.logical_date).toBe(expected);
      } finally {
        await u.cleanup();
      }
    });

    it('explicit logical_date still overrides the default (backward compat)', async () => {
      const u = await createTestUser('chefbyte-addmeal-explicit-date');
      const uctx = createToolContext(u.userId);
      try {
        const prod = parseToolResult(await createProduct.handler({ name: 'ExplicitProd' }, uctx));
        const explicitDate = '2029-07-04';

        const res = parseToolResult(
          await addMeal.handler({ product_id: prod.product.product_id, logical_date: explicitDate, servings: 1 }, uctx),
        );
        expect(res.meal.logical_date).toBe(explicitDate);
      } finally {
        await u.cleanup();
      }
    });
  });
});
