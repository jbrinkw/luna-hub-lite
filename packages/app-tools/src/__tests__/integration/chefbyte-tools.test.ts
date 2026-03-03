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

    it('upserts when adding the same product again', async () => {
      const result = await addToShopping.handler(
        {
          product_id: secondProductId,
          qty_containers: 7,
        },
        ctx,
      );
      const data = parseToolResult(result);

      // Should update, not duplicate
      expect(Number(data.item.qty_containers)).toBe(7);
      expect(data.item.product_id).toBe(secondProductId);
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
      expect(Number(yogurtItem.qty_containers)).toBe(7);
      // Price = 5.99, qty = 7 => estimated_cost = 41.93
      expect(Number(yogurtItem.price)).toBeCloseTo(5.99, 2);
      expect(Number(yogurtItem.estimated_cost)).toBeCloseTo(41.93, 2);

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
      // productId now has 0 stock after the over-consume test above
      const result = await consume.handler(
        {
          product_id: productId,
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
    });

    it('consumes by servings (converts to containers)', async () => {
      // Add some stock back first
      await addStock.handler(
        {
          product_id: productId,
          qty_containers: 2,
          location_id: locationId,
        },
        ctx,
      );

      // Product has servings_per_container = 4
      // Consume 4 servings = 1 container
      const result = await consume.handler(
        {
          product_id: productId,
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
    });

    it('setPrice updates price to zero', async () => {
      const result = await setPrice.handler({ product_id: productId, price: 0 }, ctx);
      const data = parseToolResult(result);

      expect(Number(data.product.price)).toBe(0);
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
});
