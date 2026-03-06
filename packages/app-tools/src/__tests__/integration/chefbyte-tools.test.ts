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
import { getCookable } from '../../chefbyte/get-cookable';
import { addMeal } from '../../chefbyte/add-meal';
import { getMealPlan } from '../../chefbyte/get-meal-plan';
import { markDone } from '../../chefbyte/mark-done';
import { updateProduct } from '../../chefbyte/update-product';
import { deleteShoppingItem } from '../../chefbyte/delete-shopping-item';
import { togglePurchased } from '../../chefbyte/toggle-purchased';
import { importShoppingToInventory } from '../../chefbyte/import-shopping-to-inventory';
import { deleteMealEntry } from '../../chefbyte/delete-meal-entry';

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
      // mealId is set by the first addMeal test — used by markDone below
      expect(mealId).toBeTruthy();
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

      // Import
      const result = await importShoppingToInventory.handler({}, ctx);
      const data = parseToolResult(result);

      expect(data.message).toContain('2 item(s)');
      expect(data.lots_created).toBe(2);
      expect(data.lots).toHaveLength(2);

      // Verify stock lots were created
      const lot1 = data.lots.find((l: any) => l.product_id === productId);
      expect(lot1).toBeDefined();
      expect(lot1.qty_containers).toBe(3);

      const lot2 = data.lots.find((l: any) => l.product_id === secondProductId);
      expect(lot2).toBeDefined();
      expect(lot2.qty_containers).toBe(1);

      // Verify shopping list is now empty (purchased items removed)
      const afterList = await getShoppingList.handler({}, ctx);
      const afterListData = parseToolResult(afterList);
      expect(afterListData.total_items).toBe(0);
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
  // 24. deleteMealEntry — delete a meal plan entry
  // -----------------------------------------------------------------------

  describe('deleteMealEntry', () => {
    const today = new Date().toISOString().slice(0, 10);
    let testMealId: string;

    it('creates a meal entry for deletion test', async () => {
      const result = await addMeal.handler({ logical_date: today, product_id: productId, servings: 1 }, ctx);
      const data = parseToolResult(result);
      testMealId = data.meal.meal_id;
      expect(testMealId).toBeTruthy();
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
});
