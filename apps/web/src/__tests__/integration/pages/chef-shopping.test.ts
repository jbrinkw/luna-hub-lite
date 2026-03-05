import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPageTestContext,
  chefbyte,
  seedAllChefByte,
  assertQuerySucceeds,
  type PageTestContext,
  type ChefByteSeeds,
} from './helpers';

describe('ChefByte ShoppingPage queries', () => {
  let ctx: PageTestContext;
  let seeds: ChefByteSeeds;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-shopping');
    seeds = await seedAllChefByte(ctx);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // -----------------------------------------------------------------------
  // Exact query from ShoppingPage.tsx line 61-65 (loadItems)
  // -----------------------------------------------------------------------
  it('shopping_list query matches page pattern (empty list)', async () => {
    const result = await chefbyte(ctx.client)
      .from('shopping_list')
      .select('*, products:product_id(name, barcode, price)')
      .eq('user_id', ctx.userId)
      .order('created_at');

    const data = assertQuerySucceeds(result, 'shopping_list');
    // Initially empty since seedAllChefByte does not seed shopping items
    expect(Array.isArray(data)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Exact query from ShoppingPage.tsx line 91-95 (searchProducts)
  // -----------------------------------------------------------------------
  it('product search query matches page pattern', async () => {
    const result = await chefbyte(ctx.client)
      .from('products')
      .select('product_id, name')
      .eq('user_id', ctx.userId)
      .order('name');

    const data = assertQuerySucceeds(result, 'product search');
    expect(data.length).toBeGreaterThanOrEqual(5);

    // Verify shape
    const first = data[0];
    expect(first).toHaveProperty('product_id');
    expect(first).toHaveProperty('name');

    // Client-side filter replication (from ShoppingPage.tsx line 97-99)
    const searchText = 'chicken';
    const filtered = data.filter((p: any) => p.name.toLowerCase().includes(searchText.toLowerCase()));
    expect(filtered.length).toBeGreaterThanOrEqual(1);
    expect(filtered[0].name).toBe('Chicken Breast');
  });

  // -----------------------------------------------------------------------
  // Exact insert from ShoppingPage.tsx line 142-146 (addItem)
  // -----------------------------------------------------------------------
  it('add item to shopping list matches page pattern', async () => {
    const productId = seeds.productMap['Chicken Breast'];

    const insertResult = await chefbyte(ctx.client).from('shopping_list').insert({
      user_id: ctx.userId,
      product_id: productId,
      qty_containers: 2,
    });

    expect(insertResult.error).toBeNull();

    // Verify by reloading with the page query
    const result = await chefbyte(ctx.client)
      .from('shopping_list')
      .select('*, products:product_id(name, barcode, price)')
      .eq('user_id', ctx.userId)
      .order('created_at');

    const data = assertQuerySucceeds(result, 'shopping_list after add');
    expect(data.length).toBeGreaterThanOrEqual(1);

    const item = data.find((i: any) => i.product_id === productId);
    expect(item).toBeDefined();
    expect(Number(item.qty_containers)).toBe(2);
    expect(item.purchased).toBe(false);

    // Verify products join with exact seed values
    expect(item.products).not.toBeNull();
    expect(item.products.name).toBe('Chicken Breast');
    expect(item.products.barcode).toBeNull();
    expect(item.products.price).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Exact update from ShoppingPage.tsx line 155-158 (togglePurchased)
  // -----------------------------------------------------------------------
  it('toggle purchased matches page pattern', async () => {
    // First get the cart_item_id
    const { data: items } = await chefbyte(ctx.client)
      .from('shopping_list')
      .select('cart_item_id, purchased')
      .eq('user_id', ctx.userId);

    expect(items).not.toBeNull();
    expect(items!.length).toBe(1);

    const cartItemId = items![0].cart_item_id;
    const currentPurchased = items![0].purchased;

    // Toggle using exact page pattern
    const updateResult = await chefbyte(ctx.client)
      .from('shopping_list')
      .update({ purchased: !currentPurchased })
      .eq('cart_item_id', cartItemId);

    expect(updateResult.error).toBeNull();

    // Verify
    const { data: updated } = await chefbyte(ctx.client)
      .from('shopping_list')
      .select('purchased')
      .eq('cart_item_id', cartItemId);

    expect(updated![0].purchased).toBe(!currentPurchased);
  });

  // -----------------------------------------------------------------------
  // Exact delete from ShoppingPage.tsx line 163-166 (removeItem by cart_item_id)
  // -----------------------------------------------------------------------
  it('delete item by cart_item_id matches page pattern', async () => {
    // Add a second item to delete
    const productId = seeds.productMap['Bananas'];
    await chefbyte(ctx.client).from('shopping_list').insert({
      user_id: ctx.userId,
      product_id: productId,
      qty_containers: 3,
    });

    // Get the cart_item_id for the Bananas item
    const { data: items } = await chefbyte(ctx.client)
      .from('shopping_list')
      .select('cart_item_id, product_id')
      .eq('user_id', ctx.userId)
      .eq('product_id', productId);

    expect(items).not.toBeNull();
    expect(items!.length).toBe(1);
    const cartItemId = items![0].cart_item_id;

    // Delete using exact page pattern (by cart_item_id, NOT product_id)
    const deleteResult = await chefbyte(ctx.client).from('shopping_list').delete().eq('cart_item_id', cartItemId);

    expect(deleteResult.error).toBeNull();

    // Verify deleted
    const { data: remaining } = await chefbyte(ctx.client)
      .from('shopping_list')
      .select('cart_item_id')
      .eq('cart_item_id', cartItemId);

    expect(remaining).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Exact queries from ShoppingPage.tsx importToInventory (line 173-179)
  // -----------------------------------------------------------------------
  it('importToInventory location query matches page pattern', async () => {
    const result = await chefbyte(ctx.client)
      .from('locations')
      .select('location_id')
      .eq('user_id', ctx.userId)
      .order('created_at')
      .limit(1);

    const data = assertQuerySucceeds(result, 'import location');
    expect(data).toHaveLength(1);
    expect(data[0]).toHaveProperty('location_id');
  });

  // -----------------------------------------------------------------------
  // Exact queries from ShoppingPage.tsx autoAddBelowMinStock (line 205-217)
  // -----------------------------------------------------------------------
  it('autoAddBelowMinStock queries match page patterns', async () => {
    // Query 1: products with min_stock_amount > 0
    const productsResult = await chefbyte(ctx.client)
      .from('products')
      .select('product_id, name, min_stock_amount')
      .eq('user_id', ctx.userId)
      .gt('min_stock_amount', 0);

    const products = assertQuerySucceeds(productsResult, 'products with min_stock');
    // Chicken Breast (2), Brown Rice (1), Eggs (1), Bananas (3) have min_stock > 0
    expect(products.length).toBeGreaterThanOrEqual(3);

    for (const p of products) {
      expect(p).toHaveProperty('product_id');
      expect(p).toHaveProperty('name');
      expect(p).toHaveProperty('min_stock_amount');
      expect(Number(p.min_stock_amount)).toBeGreaterThan(0);
    }

    // Query 2: stock lots for calculating current stock
    const stockResult = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('product_id, qty_containers')
      .eq('user_id', ctx.userId);

    const stockLots = assertQuerySucceeds(stockResult, 'stock for auto-add');
    expect(Array.isArray(stockLots)).toBe(true);

    // Verify shape
    for (const lot of stockLots) {
      expect(lot).toHaveProperty('product_id');
      expect(lot).toHaveProperty('qty_containers');
    }
  });

  // -----------------------------------------------------------------------
  // Exact bulk delete from ShoppingPage.tsx importToInventory (line 196)
  // Uses .in('cart_item_id', ids)
  // -----------------------------------------------------------------------
  it('bulk delete by cart_item_id array matches page pattern', async () => {
    // Clean up any existing shopping items first
    await chefbyte(ctx.client).from('shopping_list').delete().eq('user_id', ctx.userId);

    // Insert 2 items
    const p1 = seeds.productMap['Brown Rice'];
    const p2 = seeds.productMap['Eggs'];

    await chefbyte(ctx.client).from('shopping_list').insert({
      user_id: ctx.userId,
      product_id: p1,
      qty_containers: 1,
    });
    await chefbyte(ctx.client).from('shopping_list').insert({
      user_id: ctx.userId,
      product_id: p2,
      qty_containers: 2,
    });

    // Get cart_item_ids
    const { data: items } = await chefbyte(ctx.client)
      .from('shopping_list')
      .select('cart_item_id')
      .eq('user_id', ctx.userId);

    expect(items!.length).toBe(2);
    const ids = items!.map((i: any) => i.cart_item_id);

    // Bulk delete using exact page pattern
    const deleteResult = await chefbyte(ctx.client).from('shopping_list').delete().in('cart_item_id', ids);

    expect(deleteResult.error).toBeNull();

    // Verify
    const { data: remaining } = await chefbyte(ctx.client)
      .from('shopping_list')
      .select('cart_item_id')
      .eq('user_id', ctx.userId);

    expect(remaining).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Exact insert from ShoppingPage.tsx addItem placeholder product (line 129-136)
  // -----------------------------------------------------------------------
  it('create placeholder product matches page pattern', async () => {
    const result = await chefbyte(ctx.client)
      .from('products')
      .insert({
        user_id: ctx.userId,
        name: 'Quick Add Item',
        is_placeholder: true,
      })
      .select('product_id')
      .single();

    const data = assertQuerySucceeds(result, 'placeholder product');
    expect(typeof data.product_id).toBe('string');
    expect(data.product_id.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // importToInventory batch: creates stock lots and deletes shopping items
  // Exact flow from ShoppingPage.tsx importToInventory
  // -----------------------------------------------------------------------
  it('importToInventory creates stock lots and removes purchased items', async () => {
    const riceId = seeds.productMap['Brown Rice'];

    // Clean up any existing shopping items first
    await chefbyte(ctx.client).from('shopping_list').delete().eq('user_id', ctx.userId);

    // Add item to shopping list and mark purchased
    const { data: item } = await chefbyte(ctx.client)
      .from('shopping_list')
      .insert({
        user_id: ctx.userId,
        product_id: riceId,
        qty_containers: 2,
        purchased: true,
      })
      .select('cart_item_id')
      .single();
    expect(item).not.toBeNull();

    // Get default location (EXACT query from ShoppingPage importToInventory)
    const { data: locs } = await chefbyte(ctx.client)
      .from('locations')
      .select('location_id')
      .eq('user_id', ctx.userId)
      .order('created_at')
      .limit(1);
    expect(locs!.length).toBeGreaterThan(0);
    const locId = locs![0].location_id;

    // Get stock before import
    const { data: stockBefore } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('qty_containers')
      .eq('product_id', riceId);
    const totalBefore = stockBefore!.reduce((sum: number, l: any) => sum + Number(l.qty_containers), 0);

    // Insert stock lot (EXACT pattern from ShoppingPage)
    const stockResult = await chefbyte(ctx.client).from('stock_lots').insert({
      user_id: ctx.userId,
      product_id: riceId,
      qty_containers: 2,
      location_id: locId,
    });
    expect(stockResult.error).toBeNull();

    // Delete from shopping list (EXACT pattern from ShoppingPage)
    const deleteResult = await chefbyte(ctx.client)
      .from('shopping_list')
      .delete()
      .eq('cart_item_id', item!.cart_item_id);
    expect(deleteResult.error).toBeNull();

    // Verify stock added
    const { data: stockAfter } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('qty_containers')
      .eq('product_id', riceId);
    const totalAfter = stockAfter!.reduce((sum: number, l: any) => sum + Number(l.qty_containers), 0);
    expect(totalAfter).toBeCloseTo(totalBefore + 2, 1);

    // Verify shopping list empty
    const { data: shopAfter } = await chefbyte(ctx.client)
      .from('shopping_list')
      .select('cart_item_id')
      .eq('user_id', ctx.userId);
    expect(shopAfter!.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Shopping list qty increment on existing item
  // Exact pattern from ShoppingPage.tsx addItem when product already on list
  // -----------------------------------------------------------------------
  it('shopping list qty increment updates existing item', async () => {
    const chickenId = seeds.productMap['Chicken Breast'];

    // Clean up any existing shopping items first
    await chefbyte(ctx.client).from('shopping_list').delete().eq('user_id', ctx.userId);

    // Add initial item
    const { data: initial } = await chefbyte(ctx.client)
      .from('shopping_list')
      .insert({
        user_id: ctx.userId,
        product_id: chickenId,
        qty_containers: 1,
        purchased: false,
      })
      .select('cart_item_id, qty_containers')
      .single();
    expect(initial).not.toBeNull();

    // Increment qty (EXACT pattern from ShoppingPage addItem when product already on list)
    const updateResult = await chefbyte(ctx.client)
      .from('shopping_list')
      .update({ qty_containers: Number(initial!.qty_containers) + 1 })
      .eq('cart_item_id', initial!.cart_item_id);
    expect(updateResult.error).toBeNull();

    // Verify incremented
    const { data: after } = await chefbyte(ctx.client)
      .from('shopping_list')
      .select('qty_containers')
      .eq('cart_item_id', initial!.cart_item_id)
      .single();
    expect(Number(after!.qty_containers)).toBe(2);

    // Cleanup
    await chefbyte(ctx.client).from('shopping_list').delete().eq('cart_item_id', initial!.cart_item_id);
  });

  // -----------------------------------------------------------------------
  // [MEAL] products excluded from shopping product search
  // -----------------------------------------------------------------------
  it('[MEAL] products excluded from shopping product search', async () => {
    // Insert a [MEAL] product
    await chefbyte(ctx.client).from('products').insert({
      user_id: ctx.userId,
      name: '[MEAL] Chicken Bowl',
      is_placeholder: false,
    });

    // Run the EXACT query from ShoppingPage searchProducts (searching for "Chicken")
    const { data } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id, name')
      .eq('user_id', ctx.userId)
      .not('name', 'ilike', '[MEAL]%')
      .ilike('name', '%Chicken%')
      .order('name');

    // Should find "Chicken Breast" but NOT "[MEAL] Chicken Bowl"
    const names = (data ?? []).map((p: any) => p.name);
    expect(names).toContain('Chicken Breast');
    expect(names.every((n: string) => !n.startsWith('[MEAL]'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // [MEAL] products excluded from auto-add below min stock
  // -----------------------------------------------------------------------
  it('[MEAL] products excluded from auto-add below min stock', async () => {
    // Insert a [MEAL] product with min_stock > 0
    await chefbyte(ctx.client).from('products').insert({
      user_id: ctx.userId,
      name: '[MEAL] Prep Bowl',
      is_placeholder: false,
      min_stock_amount: 5,
    });

    // Run the EXACT query from ShoppingPage autoAddBelowMinStock
    const { data } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id, name, min_stock_amount')
      .eq('user_id', ctx.userId)
      .not('name', 'ilike', '[MEAL]%')
      .gt('min_stock_amount', 0);

    // Should NOT include the [MEAL] product
    const names = (data ?? []).map((p: any) => p.name);
    expect(names.every((n: string) => !n.startsWith('[MEAL]'))).toBe(true);
  });
});
