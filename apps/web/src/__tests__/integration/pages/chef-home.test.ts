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
    const chickenId = seeds.productMap['Great Value Boneless Skinless Chicken Breasts'];
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
    const chickenId = seeds.productMap['Great Value Boneless Skinless Chicken Breasts'];
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
  // HomePage: unmark_meal_done RPC (undo completed meal)
  // Source: HomePage.tsx unmarkMealDone()
  //   .rpc('unmark_meal_done', { p_meal_id: mealId })
  // -------------------------------------------------------------------
  it('unmark_meal_done RPC reverses a completed meal from dashboard', async () => {
    const today = todayDate();

    // Create a meal entry for today
    const { data: meal, error: mealErr } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .insert({
        user_id: ctx.userId,
        recipe_id: seeds.recipeId,
        logical_date: today,
        servings: 1,
        meal_prep: false,
      })
      .select('meal_id')
      .single();
    expect(mealErr).toBeNull();
    expect(meal).not.toBeNull();

    // Mark done first
    const { data: markResult } = await (chefbyte(ctx.client) as any).rpc('mark_meal_done', {
      p_meal_id: meal!.meal_id,
    });
    expect(markResult.success).toBe(true);

    // Verify food_logs were created by mark_meal_done (tagged with meal_id)
    const { data: logsAfterMark } = await chefbyte(ctx.client)
      .from('food_logs')
      .select('log_id, meal_id, calories, protein, carbs, fat')
      .eq('user_id', ctx.userId)
      .eq('meal_id', meal!.meal_id);
    expect(logsAfterMark).not.toBeNull();
    expect(logsAfterMark!.length).toBeGreaterThanOrEqual(1);
    const logCountBeforeUnmark = logsAfterMark!.length;

    // Exact RPC call from HomePage.tsx unmarkMealDone()
    const { data: undoResult, error: undoErr } = await (chefbyte(ctx.client) as any).rpc('unmark_meal_done', {
      p_meal_id: meal!.meal_id,
    });
    expect(undoErr).toBeNull();
    expect(undoResult).not.toBeNull();
    expect(undoResult.success).toBe(true);
    expect(typeof undoResult.deleted_logs).toBe('number');
    expect(undoResult.deleted_logs).toBe(logCountBeforeUnmark);
    expect(typeof undoResult.restored_stock).toBe('number');

    // Verify food_logs for this meal were actually deleted
    const { data: logsAfterUnmark } = await chefbyte(ctx.client)
      .from('food_logs')
      .select('log_id')
      .eq('user_id', ctx.userId)
      .eq('meal_id', meal!.meal_id);
    expect(logsAfterUnmark).toHaveLength(0);

    // Verify meal is uncompleted
    const { data: verify } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select('completed_at')
      .eq('meal_id', meal!.meal_id)
      .single();
    expect(verify!.completed_at).toBeNull();

    // Cleanup
    await chefbyte(ctx.client).from('food_logs').delete().eq('user_id', ctx.userId);
    await chefbyte(ctx.client).from('meal_plan_entries').delete().eq('meal_id', meal!.meal_id);
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
    const riceId = seeds.productMap['Great Value Long Grain Brown Rice'];
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

    // Insert stock lot (pattern from HomePage — unique expires_on to avoid merge_key conflict)
    const stockResult = await chefbyte(ctx.client)
      .from('stock_lots')
      .insert({
        user_id: ctx.userId,
        product_id: item.product_id,
        qty_containers: Number(item.qty_containers),
        location_id: locId,
        expires_on: '2099-06-15',
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

  // -------------------------------------------------------------------
  // HomePage: food_logs query for consumed items display (with meal grouping)
  // Source: HomePage.tsx loadData()
  //   .from('food_logs').select('log_id, qty_consumed, unit, calories, protein, carbs, fat, meal_id,
  //     products:product_id(name), meal_plan_entries:meal_id(recipes:recipe_id(name), products:product_id(name))')
  //     .eq('user_id', userId).eq('logical_date', today)
  // -------------------------------------------------------------------
  it('food_logs query returns consumed items with meal_id and meal info joins', async () => {
    const today = todayDate();
    const chickenId = seeds.productMap['Great Value Boneless Skinless Chicken Breasts'];

    // Consume a product directly (standalone — no meal_id)
    await (chefbyte(ctx.client) as any).rpc('consume_product', {
      p_product_id: chickenId,
      p_qty: 1,
      p_unit: 'container',
      p_log_macros: true,
      p_logical_date: today,
    });

    // Exact query from HomePage.tsx loadData() — consumed items section
    const result = await chefbyte(ctx.client)
      .from('food_logs')
      .select(
        'log_id, qty_consumed, unit, calories, protein, carbs, fat, meal_id, products:product_id(name), meal_plan_entries:meal_id(recipes:recipe_id(name), products:product_id(name))',
      )
      .eq('user_id', ctx.userId)
      .eq('logical_date', today);

    const data = assertQuerySucceeds(result, 'food_logs consumed items');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);

    const entry = data[0] as any;
    expect(typeof entry.log_id).toBe('string');
    expect(Number(entry.qty_consumed)).toBeGreaterThan(0);
    expect(entry.unit).toBe('container');
    expect(Number(entry.calories)).toBeGreaterThanOrEqual(0);
    expect(Number(entry.protein)).toBeGreaterThanOrEqual(0);
    expect(Number(entry.carbs)).toBeGreaterThanOrEqual(0);
    expect(Number(entry.fat)).toBeGreaterThanOrEqual(0);
    expect(entry.products).not.toBeNull();
    expect(entry.products.name).toBe('Great Value Boneless Skinless Chicken Breasts');
    // Standalone consume — no meal_id
    expect(entry.meal_id).toBeNull();
    expect(entry.meal_plan_entries).toBeNull();

    // Cleanup: delete food_logs and restore consumed stock
    await chefbyte(ctx.client).from('food_logs').delete().eq('user_id', ctx.userId);
    // Restore 1 container consumed by consume_product
    const { data: chickenLots } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('lot_id, qty_containers')
      .eq('product_id', chickenId)
      .eq('user_id', ctx.userId);
    if (chickenLots?.length) {
      await chefbyte(ctx.client)
        .from('stock_lots')
        .update({ qty_containers: Number((chickenLots[0] as any).qty_containers) + 1 })
        .eq('lot_id', (chickenLots[0] as any).lot_id);
    }
  });

  // -------------------------------------------------------------------
  // HomePage: food_logs query returns meal_id + meal name after mark_meal_done
  // Source: HomePage.tsx — meal grouping in consumed section
  // -------------------------------------------------------------------
  it('food_logs from mark_meal_done have meal_id and meal_plan_entries join data', async () => {
    const today = todayDate();

    // Create a regular meal entry for today
    const { data: meal, error: mealErr } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .insert({
        user_id: ctx.userId,
        recipe_id: seeds.recipeId,
        logical_date: today,
        servings: 1,
        meal_prep: false,
      })
      .select('meal_id')
      .single();
    expect(mealErr).toBeNull();
    expect(meal).not.toBeNull();

    // Mark meal done — creates food_logs tagged with meal_id
    const { data: markResult } = await (chefbyte(ctx.client) as any).rpc('mark_meal_done', {
      p_meal_id: meal!.meal_id,
    });
    expect(markResult.success).toBe(true);

    // Query with the exact select from HomePage.tsx
    const result = await chefbyte(ctx.client)
      .from('food_logs')
      .select(
        'log_id, qty_consumed, unit, calories, protein, carbs, fat, meal_id, products:product_id(name), meal_plan_entries:meal_id(recipes:recipe_id(name), products:product_id(name))',
      )
      .eq('user_id', ctx.userId)
      .eq('logical_date', today)
      .eq('meal_id', meal!.meal_id);

    const data = assertQuerySucceeds(result, 'food_logs with meal grouping');
    expect(data.length).toBeGreaterThanOrEqual(1);

    // All entries should have the meal_id set
    for (const entry of data as any[]) {
      expect(entry.meal_id).toBe(meal!.meal_id);
      expect(entry.meal_plan_entries).not.toBeNull();
      // Recipe-based meal — should have recipe name
      expect(entry.meal_plan_entries.recipes).not.toBeNull();
      expect(entry.meal_plan_entries.recipes.name).toBe('Chicken & Rice');
      // Not product-based, so products on meal_plan_entries should be null
      expect(entry.meal_plan_entries.products).toBeNull();
    }

    // Cleanup: unmark restores stock + deletes food_logs, then remove meal entry
    await (chefbyte(ctx.client) as any).rpc('unmark_meal_done', { p_meal_id: meal!.meal_id });
    await chefbyte(ctx.client).from('meal_plan_entries').delete().eq('meal_id', meal!.meal_id);
  });

  // -------------------------------------------------------------------
  // HomePage: delete all food_logs for a meal (deleteMealLogs)
  // Source: HomePage.tsx deleteMealLogs()
  //   .from('food_logs').delete().eq('meal_id', mealId)
  // -------------------------------------------------------------------
  it('delete food_logs by meal_id removes all logs for that meal', async () => {
    const today = todayDate();

    // Create and complete a meal to generate food_logs with meal_id
    const { data: meal } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .insert({
        user_id: ctx.userId,
        recipe_id: seeds.recipeId,
        logical_date: today,
        servings: 1,
        meal_prep: false,
      })
      .select('meal_id')
      .single();
    expect(meal).not.toBeNull();

    await (chefbyte(ctx.client) as any).rpc('mark_meal_done', {
      p_meal_id: meal!.meal_id,
    });

    // Verify food_logs exist for this meal
    const { data: logsBefore } = await chefbyte(ctx.client)
      .from('food_logs')
      .select('log_id')
      .eq('meal_id', meal!.meal_id);
    expect(logsBefore!.length).toBeGreaterThanOrEqual(1);

    // Exact delete from HomePage.tsx deleteMealLogs()
    const delResult = await chefbyte(ctx.client).from('food_logs').delete().eq('meal_id', meal!.meal_id);
    expect(delResult.error).toBeNull();

    // Verify all food_logs for this meal are deleted
    const { data: logsAfter } = await chefbyte(ctx.client)
      .from('food_logs')
      .select('log_id')
      .eq('meal_id', meal!.meal_id);
    expect(logsAfter).toHaveLength(0);

    // Cleanup: restore stock consumed by mark_meal_done
    // Recipe "Chicken & Rice" base_servings=2, meal servings=1, scale_factor=0.5
    // Chicken: 1 * 0.5 = 0.5 containers consumed, Rice: 0.5 * 0.5 = 0.25 containers consumed
    const chickenId = seeds.productMap['Great Value Boneless Skinless Chicken Breasts'];
    const riceId = seeds.productMap['Great Value Long Grain Brown Rice'];
    const { data: chickenLots } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('lot_id, qty_containers')
      .eq('product_id', chickenId)
      .eq('user_id', ctx.userId);
    if (chickenLots?.length) {
      await chefbyte(ctx.client)
        .from('stock_lots')
        .update({ qty_containers: Number((chickenLots[0] as any).qty_containers) + 0.5 })
        .eq('lot_id', (chickenLots[0] as any).lot_id);
    }
    const { data: riceLots } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('lot_id, qty_containers')
      .eq('product_id', riceId)
      .eq('user_id', ctx.userId);
    if (riceLots?.length) {
      await chefbyte(ctx.client)
        .from('stock_lots')
        .update({ qty_containers: Number((riceLots[0] as any).qty_containers) + 0.25 })
        .eq('lot_id', (riceLots[0] as any).lot_id);
    }
    await chefbyte(ctx.client).from('meal_plan_entries').delete().eq('meal_id', meal!.meal_id);
  });

  // -------------------------------------------------------------------
  // HomePage: temp_items query for quick-add items display
  // Source: HomePage.tsx line 262-266
  //   .from('temp_items').select('temp_id, name, calories, protein, carbs, fat')
  //     .eq('user_id', userId).eq('logical_date', today)
  // -------------------------------------------------------------------
  it('temp_items query returns quick-add items for logical_date', async () => {
    const today = todayDate();

    // Insert a temp item
    const insertResult = await chefbyte(ctx.client).from('temp_items').insert({
      user_id: ctx.userId,
      name: 'Test Quick Add',
      logical_date: today,
      calories: 250,
      protein: 15,
      carbs: 30,
      fat: 8,
    });
    expect(insertResult.error).toBeNull();

    // Exact query from HomePage.tsx loadData() — temp_items section
    const result = await chefbyte(ctx.client)
      .from('temp_items')
      .select('temp_id, name, calories, protein, carbs, fat')
      .eq('user_id', ctx.userId)
      .eq('logical_date', today);

    const data = assertQuerySucceeds(result, 'temp_items quick-add');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);

    const entry = data[0] as any;
    expect(typeof entry.temp_id).toBe('string');
    expect(entry.name).toBe('Test Quick Add');
    expect(Number(entry.calories)).toBe(250);
    expect(Number(entry.protein)).toBe(15);
    expect(Number(entry.carbs)).toBe(30);
    expect(Number(entry.fat)).toBe(8);

    // Cleanup
    await chefbyte(ctx.client).from('temp_items').delete().eq('temp_id', entry.temp_id);
  });

  // -------------------------------------------------------------------
  // HomePage: delete food_log (two-click delete)
  // Source: HomePage.tsx deleteFoodLog()
  //   .from('food_logs').delete().eq('log_id', logId)
  // -------------------------------------------------------------------
  it('delete food_log by log_id', async () => {
    const today = todayDate();
    const chickenId = seeds.productMap['Great Value Boneless Skinless Chicken Breasts'];

    // Create a food_log via consume
    await (chefbyte(ctx.client) as any).rpc('consume_product', {
      p_product_id: chickenId,
      p_qty: 1,
      p_unit: 'container',
      p_log_macros: true,
      p_logical_date: today,
    });

    // Get the log_id
    const { data: logs } = await chefbyte(ctx.client)
      .from('food_logs')
      .select('log_id')
      .eq('user_id', ctx.userId)
      .eq('logical_date', today);
    expect(logs).not.toBeNull();
    expect(logs!.length).toBeGreaterThanOrEqual(1);
    const logId = (logs![0] as any).log_id;

    // Exact delete from HomePage.tsx deleteFoodLog()
    const delResult = await chefbyte(ctx.client).from('food_logs').delete().eq('log_id', logId);
    expect(delResult.error).toBeNull();

    // Verify deleted
    const { data: verify } = await chefbyte(ctx.client).from('food_logs').select('log_id').eq('log_id', logId);
    expect(verify).toHaveLength(0);

    // Cleanup remaining food_logs and restore consumed stock
    await chefbyte(ctx.client).from('food_logs').delete().eq('user_id', ctx.userId);
    const { data: chickenLots2 } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('lot_id, qty_containers')
      .eq('product_id', chickenId)
      .eq('user_id', ctx.userId);
    if (chickenLots2?.length) {
      await chefbyte(ctx.client)
        .from('stock_lots')
        .update({ qty_containers: Number((chickenLots2[0] as any).qty_containers) + 1 })
        .eq('lot_id', (chickenLots2[0] as any).lot_id);
    }
  });

  // -------------------------------------------------------------------
  // HomePage: delete temp_item (two-click delete)
  // Source: HomePage.tsx deleteTempItem()
  //   .from('temp_items').delete().eq('temp_id', tempId)
  // -------------------------------------------------------------------
  it('delete temp_item by temp_id', async () => {
    const today = todayDate();

    // Insert a temp item
    const { data: inserted } = await chefbyte(ctx.client)
      .from('temp_items')
      .insert({
        user_id: ctx.userId,
        name: 'Temp to Delete',
        logical_date: today,
        calories: 100,
        protein: 5,
        carbs: 10,
        fat: 3,
      })
      .select('temp_id')
      .single();
    expect(inserted).not.toBeNull();
    const tempId = (inserted as any).temp_id;

    // Exact delete from HomePage.tsx deleteTempItem()
    const delResult = await chefbyte(ctx.client).from('temp_items').delete().eq('temp_id', tempId);
    expect(delResult.error).toBeNull();

    // Verify deleted
    const { data: verify } = await chefbyte(ctx.client).from('temp_items').select('temp_id').eq('temp_id', tempId);
    expect(verify).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // HomePage: delete meal_plan_entry (two-click delete)
  // Source: HomePage.tsx deleteMealEntry()
  //   .from('meal_plan_entries').delete().eq('meal_id', mealId)
  // -------------------------------------------------------------------
  it('delete meal_plan_entry by meal_id', async () => {
    const today = todayDate();

    // Insert a meal entry
    const { data: meal } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .insert({
        user_id: ctx.userId,
        recipe_id: seeds.recipeId,
        logical_date: today,
        servings: 1,
        meal_prep: false,
      })
      .select('meal_id')
      .single();
    expect(meal).not.toBeNull();
    const mealId = (meal as any).meal_id;

    // Exact delete from HomePage.tsx deleteMealEntry()
    const delResult = await chefbyte(ctx.client).from('meal_plan_entries').delete().eq('meal_id', mealId);
    expect(delResult.error).toBeNull();

    // Verify deleted
    const { data: verify } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select('meal_id')
      .eq('meal_id', mealId);
    expect(verify).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // HomePage: stock_lots query for stock availability badges
  // Source: HomePage.tsx line ~227-230
  //   .from('stock_lots').select('product_id, qty_containers').eq('user_id', userId)
  // -------------------------------------------------------------------
  it('stock_lots query for all user products returns qty_containers for badge computation', async () => {
    const result = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('product_id, qty_containers')
      .eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'stock lots for badges') as any[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(3); // At least Chicken, Rice, Eggs have stock

    // Verify we can build a stock map from the data
    const stockMap = new Map<string, number>();
    for (const lot of data) {
      const cur = stockMap.get(lot.product_id) ?? 0;
      stockMap.set(lot.product_id, cur + Number(lot.qty_containers));
    }
    expect(stockMap.size).toBeGreaterThanOrEqual(3);
    // Chicken has at least 3.0 containers from seed
    expect(stockMap.get(seeds.productMap['Great Value Boneless Skinless Chicken Breasts'])).toBeGreaterThanOrEqual(3.0);
  });
});
