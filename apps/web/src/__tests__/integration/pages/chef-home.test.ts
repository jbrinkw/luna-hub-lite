import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPageTestContext,
  chefbyte,
  seedAllChefByte,
  assertQuerySucceeds,
  todayDate,
  type PageTestContext,
  type ChefByteSeeds,
} from './helpers';

describe('ChefByte HomePage queries', () => {
  let ctx: PageTestContext;
  let seeds: ChefByteSeeds;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-home');
    seeds = await seedAllChefByte(ctx);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // -------------------------------------------------------------------
  // HomePage: products query — missing prices
  // Source: HomePage.tsx line 86-87
  //   .from('products').select('product_id').eq('user_id', userId).is('price', null)
  // -------------------------------------------------------------------
  it('products missing prices query returns rows where price is null', async () => {
    const result = await chefbyte(ctx.client)
      .from('products')
      .select('product_id')
      .eq('user_id', ctx.userId)
      .is('price', null);

    const data = assertQuerySucceeds(result, 'missing prices');
    expect(Array.isArray(data)).toBe(true);
    // All 5 seeded products have no price set
    expect(data.length).toBe(5);
  });

  // -------------------------------------------------------------------
  // HomePage: products query — placeholders
  // Source: HomePage.tsx line 90-95
  //   .from('products').select('product_id').eq('user_id', userId).eq('is_placeholder', true)
  // -------------------------------------------------------------------
  it('products placeholders query succeeds (initially none)', async () => {
    const result = await chefbyte(ctx.client)
      .from('products')
      .select('product_id')
      .eq('user_id', ctx.userId)
      .eq('is_placeholder', true);

    const data = assertQuerySucceeds(result, 'placeholders');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);
  });

  // -------------------------------------------------------------------
  // HomePage: products with min_stock_amount > 0
  // Source: HomePage.tsx line 98-102
  //   .from('products').select('product_id, min_stock_amount')
  //     .eq('user_id', userId).gt('min_stock_amount', 0)
  // -------------------------------------------------------------------
  it('products below-min-stock query returns products with min_stock_amount > 0', async () => {
    const result = await chefbyte(ctx.client)
      .from('products')
      .select('product_id, min_stock_amount')
      .eq('user_id', ctx.userId)
      .gt('min_stock_amount', 0);

    const data = assertQuerySucceeds(result, 'below-min products');
    expect(Array.isArray(data)).toBe(true);
    // Chicken (2), Brown Rice (1), Eggs (1), Bananas (3) have min_stock_amount > 0
    expect(data.length).toBe(4);

    const first = data[0];
    expect(typeof first.product_id).toBe('string');
    expect(Number(first.min_stock_amount)).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------
  // HomePage: stock_lots query for a product (part of below-min check)
  // Source: HomePage.tsx line 106-109
  //   .from('stock_lots').select('qty_containers').eq('product_id', p.product_id)
  // -------------------------------------------------------------------
  it('stock_lots query by product_id returns qty_containers', async () => {
    const chickenId = seeds.productMap['Chicken Breast'];
    const result = await chefbyte(ctx.client).from('stock_lots').select('qty_containers').eq('product_id', chickenId);

    const data = assertQuerySucceeds(result, 'stock lots for product');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    // Chicken Breast seeded with 3.0 containers
    expect(Number(data[0].qty_containers)).toBeCloseTo(3.0, 1);
  });

  // -------------------------------------------------------------------
  // HomePage: shopping_list joined with products (cart value)
  // Source: HomePage.tsx line 116-119
  //   .from('shopping_list')
  //     .select('qty_containers, products:product_id(price)')
  //     .eq('user_id', userId)
  // -------------------------------------------------------------------
  it('shopping_list with product price join succeeds (initially empty)', async () => {
    const result = await chefbyte(ctx.client)
      .from('shopping_list')
      .select('qty_containers, products:product_id(price)')
      .eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'shopping list cart');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);
  });

  // -------------------------------------------------------------------
  // HomePage: shopping_list with product price join — after insert
  // -------------------------------------------------------------------
  it('shopping_list with product price join returns data after insert', async () => {
    // Add an item to shopping list
    const chickenId = seeds.productMap['Chicken Breast'];
    const insertResult = await chefbyte(ctx.client).from('shopping_list').insert({
      user_id: ctx.userId,
      product_id: chickenId,
      qty_containers: 2,
      purchased: false,
    });
    expect(insertResult.error).toBeNull();

    const result = await chefbyte(ctx.client)
      .from('shopping_list')
      .select('qty_containers, products:product_id(price)')
      .eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'shopping list with item');
    expect(data.length).toBe(1);
    expect(Number(data[0].qty_containers)).toBe(2);
    // Price is null since no price set on seeded products
    expect(data[0].products.price).toBeNull();

    // Cleanup: delete from shopping list using cart_item_id
    const { data: items } = await chefbyte(ctx.client)
      .from('shopping_list')
      .select('cart_item_id')
      .eq('user_id', ctx.userId);
    if (items?.length) {
      await chefbyte(ctx.client).from('shopping_list').delete().eq('cart_item_id', items[0].cart_item_id);
    }
  });

  // -------------------------------------------------------------------
  // HomePage: get_daily_macros RPC
  // Source: HomePage.tsx line 129-131
  //   .rpc('get_daily_macros', { p_logical_date: today })
  // -------------------------------------------------------------------
  it('get_daily_macros RPC returns macro breakdown for today', async () => {
    const today = todayDate();
    const result = await (chefbyte(ctx.client) as any).rpc('get_daily_macros', {
      p_logical_date: today,
    });

    const data = assertQuerySucceeds(result, 'get_daily_macros');
    // Verify macro structure with exact values
    expect(data.calories).not.toBeNull();
    expect(data.protein).not.toBeNull();
    expect(data.carbs).not.toBeNull();
    expect(data.fat).not.toBeNull();

    // Each macro should have consumed, goal, remaining
    expect(typeof Number(data.calories.consumed)).toBe('number');
    expect(typeof Number(data.calories.goal)).toBe('number');
    expect(typeof Number(data.calories.remaining)).toBe('number');

    // Goals should match what we seeded (2200 cal)
    expect(Number(data.calories.goal)).toBe(2200);
    expect(Number(data.protein.goal)).toBe(180);
    expect(Number(data.carbs.goal)).toBe(220);
    expect(Number(data.fat.goal)).toBe(73);
  });

  // -------------------------------------------------------------------
  // HomePage: meal_plan_entries query for today's meal prep
  // Source: HomePage.tsx line 153-159
  //   .from('meal_plan_entries')
  //     .select('meal_id, servings, recipes:recipe_id(name), products:product_id(name)')
  //     .eq('user_id', userId).eq('logical_date', today)
  //     .eq('meal_prep', true).is('completed_at', null)
  // -------------------------------------------------------------------
  it('meal_plan_entries meal-prep query with recipe/product joins succeeds', async () => {
    const today = todayDate();

    // Insert a meal prep entry for today
    const insertResult = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .insert({
        user_id: ctx.userId,
        recipe_id: seeds.recipeId,
        logical_date: today,
        servings: 2,
        meal_prep: true,
      })
      .select('meal_id')
      .single();
    expect(insertResult.error).toBeNull();

    const result = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select('meal_id, servings, recipes:recipe_id(name), products:product_id(name)')
      .eq('user_id', ctx.userId)
      .eq('logical_date', today)
      .eq('meal_prep', true)
      .is('completed_at', null);

    const data = assertQuerySucceeds(result, 'meal prep entries');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);

    const entry = data[0];
    expect(typeof entry.meal_id).toBe('string');
    expect(Number(entry.servings)).toBe(2);
    expect(entry.recipes).not.toBeNull();
    expect(entry.recipes.name).toBe('Chicken & Rice');
    expect(entry.recipes.name).toBe('Chicken & Rice');
  });

  // -------------------------------------------------------------------
  // HomePage: user_config upsert for macro goals
  // Source: HomePage.tsx line 193-195
  //   .from('user_config').upsert({ user_id, key, value }, { onConflict: 'user_id,key' })
  // -------------------------------------------------------------------
  it('user_config upsert for macro goals works', async () => {
    const result = await chefbyte(ctx.client)
      .from('user_config')
      .upsert({ user_id: ctx.userId, key: 'goal_protein', value: '200' }, { onConflict: 'user_id,key' });
    expect(result.error).toBeNull();

    // Verify the update
    const readResult = await chefbyte(ctx.client)
      .from('user_config')
      .select('value')
      .eq('user_id', ctx.userId)
      .eq('key', 'goal_protein')
      .single();

    const data = assertQuerySucceeds(readResult, 'goal_protein read');
    expect(data.value).toBe('200');
  });

  // -------------------------------------------------------------------
  // HomePage: user_config read for taste_profile
  // Source: HomePage.tsx line 206-211
  //   .from('user_config').select('value')
  //     .eq('user_id', user.id).eq('key', 'taste_profile').single()
  // -------------------------------------------------------------------
  it('user_config taste_profile read/write round-trip', async () => {
    // Write taste profile
    const writeResult = await chefbyte(ctx.client)
      .from('user_config')
      .upsert(
        { user_id: ctx.userId, key: 'taste_profile', value: 'No dairy, love spicy food' },
        { onConflict: 'user_id,key' },
      );
    expect(writeResult.error).toBeNull();

    // Read it back with EXACT query from HomePage
    const result = await chefbyte(ctx.client)
      .from('user_config')
      .select('value')
      .eq('user_id', ctx.userId)
      .eq('key', 'taste_profile')
      .single();

    const data = assertQuerySucceeds(result, 'taste_profile read');
    expect(data.value).toBe('No dairy, love spicy food');
  });

  // -------------------------------------------------------------------
  // HomePage: importShopping — locations query + stock lot insert + shopping delete
  // Source: HomePage.tsx line 232-261
  //   .from('locations').select('location_id').eq('user_id', user.id).order('created_at').limit(1)
  //   .from('shopping_list').select('*, products:product_id(is_placeholder)').eq('user_id', user.id).eq('purchased', false)
  //   .from('stock_lots').insert({...})
  //   .from('shopping_list').delete().eq('cart_item_id', item.cart_item_id)
  // -------------------------------------------------------------------
  it('importShopping flow: locations + shopping list + stock lot insert', async () => {
    // Get default location (EXACT query from HomePage)
    const locResult = await chefbyte(ctx.client)
      .from('locations')
      .select('location_id')
      .eq('user_id', ctx.userId)
      .order('created_at')
      .limit(1);

    const locations = assertQuerySucceeds(locResult, 'locations for import');
    expect(locations.length).toBeGreaterThanOrEqual(1);
    const locId = locations[0].location_id;

    // Add item to shopping list
    const riceId = seeds.productMap['Brown Rice'];
    await chefbyte(ctx.client).from('shopping_list').insert({
      user_id: ctx.userId,
      product_id: riceId,
      qty_containers: 3,
      purchased: false,
    });

    // Read shopping list with product join (EXACT query from HomePage)
    const shopResult = await chefbyte(ctx.client)
      .from('shopping_list')
      .select('*, products:product_id(is_placeholder)')
      .eq('user_id', ctx.userId)
      .eq('purchased', false);

    const shopData = assertQuerySucceeds(shopResult, 'shopping list for import');
    expect(shopData.length).toBeGreaterThanOrEqual(1);

    const item = shopData[0] as any;
    expect(item.products.is_placeholder).toBe(false);

    // Insert stock lot (EXACT pattern from HomePage)
    const stockResult = await chefbyte(ctx.client)
      .from('stock_lots')
      .insert({
        user_id: ctx.userId,
        product_id: item.product_id,
        qty_containers: Number(item.qty_containers),
        location_id: locId,
      });
    expect(stockResult.error).toBeNull();

    // Delete from shopping list (EXACT query from HomePage using cart_item_id)
    const deleteResult = await chefbyte(ctx.client)
      .from('shopping_list')
      .delete()
      .eq('cart_item_id', item.cart_item_id);
    expect(deleteResult.error).toBeNull();

    // Verify shopping list is now empty
    const verifyResult = await chefbyte(ctx.client)
      .from('shopping_list')
      .select('cart_item_id')
      .eq('user_id', ctx.userId);
    const verifyData = assertQuerySucceeds(verifyResult, 'shopping list after import');
    expect(verifyData.length).toBe(0);
  });
});
