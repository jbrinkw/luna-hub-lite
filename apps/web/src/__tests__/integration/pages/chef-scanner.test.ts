import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPageTestContext,
  chefbyte,
  seedProducts,
  getDefaultLocation,
  seedMacroGoals,
  assertQuerySucceeds,
  todayDate,
  type PageTestContext,
} from './helpers';

describe('ChefByte ScannerPage queries', () => {
  let ctx: PageTestContext;
  let productMap: Record<string, string>;
  let locationId: string;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-scanner');
    productMap = await seedProducts(ctx);
    locationId = await getDefaultLocation(ctx);
    await seedMacroGoals(ctx);

    // Seed stock for consume_product to work
    const chickenId = productMap['Chicken Breast'];
    await chefbyte(ctx.client).from('stock_lots').insert({
      user_id: ctx.userId,
      product_id: chickenId,
      location_id: locationId,
      qty_containers: 5,
    });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // -------------------------------------------------------------------
  // ScannerPage: product lookup by barcode
  // Source: ScannerPage.tsx line 141-148
  //   .from('products')
  //     .select('product_id, name, barcode, is_placeholder, calories_per_serving,
  //       protein_per_serving, carbs_per_serving, fat_per_serving, servings_per_container')
  //     .eq('user_id', user.id).eq('barcode', barcode).single()
  // -------------------------------------------------------------------
  it('product lookup by barcode returns null for unknown barcode', async () => {
    const result = await chefbyte(ctx.client)
      .from('products')
      .select(
        'product_id, name, barcode, is_placeholder, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving, servings_per_container',
      )
      .eq('user_id', ctx.userId)
      .eq('barcode', '9999999999999')
      .single();

    // .single() returns error PGRST116 for no rows
    expect(result.data).toBeNull();
  });

  // -------------------------------------------------------------------
  // ScannerPage: product upsert — insert new placeholder by barcode
  // Source: ScannerPage.tsx line 186-195
  //   .from('products').insert({
  //     user_id, barcode, name: `Unknown (${barcode})`, is_placeholder: true
  //   }).select('product_id, name').single()
  // -------------------------------------------------------------------
  it('product insert as placeholder by barcode works', async () => {
    const barcode = `TEST-${Date.now()}`;
    const result = await chefbyte(ctx.client)
      .from('products')
      .insert({
        user_id: ctx.userId,
        barcode,
        name: `Unknown (${barcode})`,
        is_placeholder: true,
      })
      .select('product_id, name')
      .single();

    const data = assertQuerySucceeds(result, 'insert placeholder');
    expect(typeof data.product_id).toBe('string');
    expect(data.name).toBe(`Unknown (${barcode})`);

    // Verify it's now findable by barcode (EXACT query from ScannerPage)
    const lookupResult = await chefbyte(ctx.client)
      .from('products')
      .select(
        'product_id, name, barcode, is_placeholder, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving, servings_per_container',
      )
      .eq('user_id', ctx.userId)
      .eq('barcode', barcode)
      .single();

    const lookupData = assertQuerySucceeds(lookupResult, 'barcode lookup after insert');
    expect(lookupData.is_placeholder).toBe(true);
    expect(lookupData.barcode).toBe(barcode);
    // Placeholder products have 0 as default for nutrition values
    expect(Number(lookupData.calories_per_serving)).toBe(0);
    expect(Number(lookupData.protein_per_serving)).toBe(0);
    expect(Number(lookupData.carbs_per_serving)).toBe(0);
    expect(Number(lookupData.fat_per_serving)).toBe(0);
    expect(Number(lookupData.servings_per_container)).toBe(1);
  });

  // -------------------------------------------------------------------
  // ScannerPage: product nutrition update after purchase scan
  // Source: ScannerPage.tsx line 258-266
  //   .from('products').update({
  //     calories_per_serving, protein_per_serving, carbs_per_serving,
  //     fat_per_serving, servings_per_container
  //   }).eq('product_id', product.product_id)
  // -------------------------------------------------------------------
  it('product nutrition update by product_id works', async () => {
    const chickenId = productMap['Chicken Breast'];

    const result = await chefbyte(ctx.client)
      .from('products')
      .update({
        calories_per_serving: 170,
        protein_per_serving: 32,
        carbs_per_serving: 0,
        fat_per_serving: 3.8,
        servings_per_container: 4,
      })
      .eq('product_id', chickenId);
    expect(result.error).toBeNull();

    // Verify the update
    const readResult = await chefbyte(ctx.client)
      .from('products')
      .select('calories_per_serving, protein_per_serving')
      .eq('product_id', chickenId)
      .single();

    const data = assertQuerySucceeds(readResult, 'nutrition update verify');
    expect(Number(data.calories_per_serving)).toBe(170);
    expect(Number(data.protein_per_serving)).toBe(32);
  });

  // -------------------------------------------------------------------
  // ScannerPage: purchase mode — stock_lots insert with location_id
  // Source: ScannerPage.tsx line 250-255
  //   .from('stock_lots').insert({
  //     user_id, product_id, qty_containers, location_id
  //   })
  // NOTE: location_id is NOT NULL — must always provide
  // -------------------------------------------------------------------
  it('stock_lots insert with explicit location_id (purchase mode)', async () => {
    const eggsId = productMap['Eggs'];
    const result = await chefbyte(ctx.client).from('stock_lots').insert({
      user_id: ctx.userId,
      product_id: eggsId,
      qty_containers: 2,
      location_id: locationId,
    });
    expect(result.error).toBeNull();

    // Verify stock exists
    const readResult = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('qty_containers, location_id')
      .eq('user_id', ctx.userId)
      .eq('product_id', eggsId);

    const data = assertQuerySucceeds(readResult, 'stock lot readback');
    expect(data.length).toBe(1);
    expect(Number(data[0].qty_containers)).toBe(2);
    expect(data[0].location_id).toBe(locationId);
  });

  // -------------------------------------------------------------------
  // ScannerPage: locations query for default location
  // Source: ScannerPage.tsx line 240-245
  //   .from('locations').select('location_id')
  //     .eq('user_id', user.id).order('created_at').limit(1)
  // -------------------------------------------------------------------
  it('locations query for default location (EXACT from ScannerPage)', async () => {
    const result = await chefbyte(ctx.client)
      .from('locations')
      .select('location_id')
      .eq('user_id', ctx.userId)
      .order('created_at')
      .limit(1);

    const data = assertQuerySucceeds(result, 'default location');
    expect(data.length).toBe(1);
    expect(data[0]).toHaveProperty('location_id');
    expect(typeof data[0].location_id).toBe('string');
  });

  // -------------------------------------------------------------------
  // ScannerPage: consume_product RPC — consume_macros mode
  // Source: ScannerPage.tsx line 273-279
  //   .rpc('consume_product', {
  //     p_product_id, p_qty, p_unit: unitType,
  //     p_log_macros: true, p_logical_date: today
  //   })
  // NOTE: p_unit = 'serving' (singular, NOT 'servings')
  // -------------------------------------------------------------------
  it('consume_product RPC with p_unit=serving and p_log_macros=true', async () => {
    const chickenId = productMap['Chicken Breast'];
    const today = todayDate();

    const result = await (chefbyte(ctx.client) as any).rpc('consume_product', {
      p_product_id: chickenId,
      p_qty: 1,
      p_unit: 'serving',
      p_log_macros: true,
      p_logical_date: today,
    });

    const data = assertQuerySucceeds(result, 'consume_product macros');
    expect(data).toHaveProperty('success');
    expect(data.success).toBe(true);

    // Verify a food_log was created with exact macro values
    // 1 serving of Chicken Breast: 165 cal, 31g protein (after update: 170 cal, 32g protein)
    const logResult = await chefbyte(ctx.client)
      .from('food_logs')
      .select('log_id, calories, protein, carbs, fat')
      .eq('user_id', ctx.userId)
      .eq('product_id', chickenId)
      .eq('logical_date', today);

    const logs = assertQuerySucceeds(logResult, 'food log after consume');
    expect(logs.length).toBe(1);
    // Values reflect the update from the earlier test (170 cal, 32 pro, 0 carbs, 3.8 fat)
    expect(Number(logs[0].calories)).toBe(170);
    expect(Number(logs[0].protein)).toBe(32);
    expect(Number(logs[0].carbs)).toBe(0);
    expect(Number(logs[0].fat)).toBeCloseTo(3.8, 1);
  });

  // -------------------------------------------------------------------
  // ScannerPage: consume_product RPC — consume_no_macros mode
  // Source: ScannerPage.tsx line 283-289
  //   .rpc('consume_product', {
  //     p_product_id, p_qty, p_unit: unitType,
  //     p_log_macros: false, p_logical_date: today
  //   })
  // -------------------------------------------------------------------
  it('consume_product RPC with p_log_macros=false skips food_log', async () => {
    const riceId = productMap['Brown Rice'];
    const today = todayDate();

    // First add stock for rice
    await chefbyte(ctx.client).from('stock_lots').insert({
      user_id: ctx.userId,
      product_id: riceId,
      qty_containers: 3,
      location_id: locationId,
    });

    // Count food_logs before
    const beforeResult = await chefbyte(ctx.client)
      .from('food_logs')
      .select('log_id')
      .eq('user_id', ctx.userId)
      .eq('product_id', riceId)
      .eq('logical_date', today);
    const beforeCount = (beforeResult.data ?? []).length;

    const result = await (chefbyte(ctx.client) as any).rpc('consume_product', {
      p_product_id: riceId,
      p_qty: 1,
      p_unit: 'serving',
      p_log_macros: false,
      p_logical_date: today,
    });

    const data = assertQuerySucceeds(result, 'consume_product no macros');
    expect(data).toHaveProperty('success');
    expect(data.success).toBe(true);

    // Verify no NEW food_log was created
    const afterResult = await chefbyte(ctx.client)
      .from('food_logs')
      .select('log_id')
      .eq('user_id', ctx.userId)
      .eq('product_id', riceId)
      .eq('logical_date', today);
    const afterCount = (afterResult.data ?? []).length;
    expect(afterCount).toBe(beforeCount);
  });

  // -------------------------------------------------------------------
  // ScannerPage: shopping mode — shopping_list insert
  // Source: ScannerPage.tsx line 294-299
  //   .from('shopping_list').insert({
  //     user_id, product_id, qty_containers, purchased: false
  //   })
  // -------------------------------------------------------------------
  it('shopping_list insert for shopping mode works', async () => {
    const bananaId = productMap['Bananas'];

    const result = await chefbyte(ctx.client).from('shopping_list').insert({
      user_id: ctx.userId,
      product_id: bananaId,
      qty_containers: 5,
      purchased: false,
    });
    expect(result.error).toBeNull();

    // Verify it was added
    const readResult = await chefbyte(ctx.client)
      .from('shopping_list')
      .select('cart_item_id, qty_containers, purchased')
      .eq('user_id', ctx.userId)
      .eq('product_id', bananaId)
      .single();

    const data = assertQuerySucceeds(readResult, 'shopping list item');
    expect(typeof data.cart_item_id).toBe('string');
    expect(Number(data.qty_containers)).toBe(5);
    expect(data.purchased).toBe(false);
  });

  // -------------------------------------------------------------------
  // ScannerPage: consume_product with container unit
  // Source: ScannerPage.tsx line 273-279 (unitType can be 'container')
  // -------------------------------------------------------------------
  it('consume_product RPC with p_unit=container works', async () => {
    const eggsId = productMap['Eggs'];
    const today = todayDate();

    const result = await (chefbyte(ctx.client) as any).rpc('consume_product', {
      p_product_id: eggsId,
      p_qty: 1,
      p_unit: 'container',
      p_log_macros: true,
      p_logical_date: today,
    });

    const data = assertQuerySucceeds(result, 'consume_product container');
    expect(data).toHaveProperty('success');
    expect(data.success).toBe(true);
  });

  // -------------------------------------------------------------------
  // ScannerPage: undo purchase — delete stock lot
  // Source: ScannerPage.tsx undoScan (purchase mode)
  //   .from('stock_lots').delete().eq('lot_id', lotId)
  // -------------------------------------------------------------------
  it('undo purchase deletes the stock lot created during scan', async () => {
    const chickenId = productMap['Chicken Breast'];

    // Insert a stock lot with unique expires_on to avoid merge_key conflict
    const { data: lot } = await chefbyte(ctx.client)
      .from('stock_lots')
      .insert({
        user_id: ctx.userId,
        product_id: chickenId,
        qty_containers: 1,
        location_id: locationId,
        expires_on: '2099-12-31',
      })
      .select('lot_id')
      .single();
    expect(lot).not.toBeNull();

    // Undo: delete the stock lot (EXACT pattern from ScannerPage undoScan)
    const deleteResult = await chefbyte(ctx.client).from('stock_lots').delete().eq('lot_id', lot!.lot_id);
    expect(deleteResult.error).toBeNull();

    // Verify deleted
    const { data: after } = await chefbyte(ctx.client).from('stock_lots').select('lot_id').eq('lot_id', lot!.lot_id);
    expect(after!.length).toBe(0);
  });

  // -------------------------------------------------------------------
  // ScannerPage: undo consume — re-add stock lot + delete food_log
  // Source: ScannerPage.tsx undoScan (consume mode)
  // -------------------------------------------------------------------
  it('undo consume re-adds stock lot and deletes food_log', async () => {
    const chickenId = productMap['Chicken Breast'];
    const today = todayDate();

    // Consume product (simulating consume scan)
    await (chefbyte(ctx.client) as any).rpc('consume_product', {
      p_product_id: chickenId,
      p_qty: 1,
      p_unit: 'container',
      p_log_macros: true,
      p_logical_date: today,
    });

    // Find the food_log (EXACT pattern from ScannerPage for undo lookup)
    const { data: logs } = await chefbyte(ctx.client)
      .from('food_logs')
      .select('log_id')
      .eq('user_id', ctx.userId)
      .eq('product_id', chickenId)
      .eq('logical_date', today)
      .is('meal_id', null)
      .order('created_at', { ascending: false })
      .limit(1);
    expect(logs).not.toBeNull();
    expect(logs!.length).toBeGreaterThan(0);
    const logId = logs![0].log_id;

    // Undo: re-add stock lot with unique expires_on to avoid merge_key conflict
    const reAddResult = await chefbyte(ctx.client).from('stock_lots').insert({
      user_id: ctx.userId,
      product_id: chickenId,
      qty_containers: 1,
      location_id: locationId,
      expires_on: '2099-12-30',
    });
    expect(reAddResult.error).toBeNull();

    // Undo: delete food_log (EXACT pattern from ScannerPage undoScan)
    const deleteLogResult = await chefbyte(ctx.client).from('food_logs').delete().eq('log_id', logId);
    expect(deleteLogResult.error).toBeNull();

    // Verify food_log deleted
    const { data: afterLog } = await chefbyte(ctx.client).from('food_logs').select('log_id').eq('log_id', logId);
    expect(afterLog!.length).toBe(0);
  });

  // -------------------------------------------------------------------
  // ScannerPage: undo shopping add — delete shopping list item
  // Source: ScannerPage.tsx undoScan (shopping mode)
  //   .from('shopping_list').delete().eq('cart_item_id', cartItemId)
  // -------------------------------------------------------------------
  it('undo shopping add deletes the shopping list item', async () => {
    const chickenId = productMap['Chicken Breast'];

    // Add to shopping list (simulating shopping scan)
    const { data: item } = await chefbyte(ctx.client)
      .from('shopping_list')
      .insert({
        user_id: ctx.userId,
        product_id: chickenId,
        qty_containers: 1,
        purchased: false,
      })
      .select('cart_item_id')
      .single();
    expect(item).not.toBeNull();

    // Undo: delete shopping item (EXACT pattern from ScannerPage undoScan)
    const deleteResult = await chefbyte(ctx.client)
      .from('shopping_list')
      .delete()
      .eq('cart_item_id', item!.cart_item_id);
    expect(deleteResult.error).toBeNull();

    // Verify deleted
    const { data: after } = await chefbyte(ctx.client)
      .from('shopping_list')
      .select('cart_item_id')
      .eq('cart_item_id', item!.cart_item_id);
    expect(after!.length).toBe(0);
  });
});
