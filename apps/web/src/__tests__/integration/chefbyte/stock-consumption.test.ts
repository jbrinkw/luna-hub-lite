import { describe, it, expect, afterEach } from 'vitest';
import { createTestUser, cleanupUser } from '../../test-helpers';

let userIds: string[] = [];

afterEach(async () => {
  for (const id of userIds) {
    await cleanupUser(id);
  }
  userIds = [];
});

describe('ChefByte stock consumption (consume_product RPC)', () => {
  /**
   * Shared setup: creates a location, one product (Chicken), and two stock lots.
   *
   * Product: Chicken — 4 servings/container, 165 cal, 31g protein, 0g carbs, 3.6g fat, min_stock 2
   * Lot 1: expires 2026-03-10, qty=2 containers (nearer expiry)
   * Lot 2: expires 2026-04-15, qty=3 containers (later expiry)
   * Total stock: 5 containers
   */
  async function setupProducts(client: any, userId: string) {
    const chef = client.schema('chefbyte') as any;

    // Insert location
    const { data: locData, error: locError } = await chef
      .from('locations')
      .insert({ user_id: userId, name: 'Fridge' })
      .select('location_id')
      .single();
    expect(locError).toBeNull();
    const locationId: string = locData.location_id;

    // Insert product
    const { data: prodData, error: prodError } = await chef
      .from('products')
      .insert({
        user_id: userId,
        name: 'Chicken',
        servings_per_container: 4,
        calories_per_serving: 165,
        protein_per_serving: 31,
        carbs_per_serving: 0,
        fat_per_serving: 3.6,
        min_stock_amount: 2,
      })
      .select('product_id')
      .single();
    expect(prodError).toBeNull();
    const productId: string = prodData.product_id;

    // Insert lot 1 — nearer expiry
    const { error: lot1Error } = await chef.from('stock_lots').insert({
      user_id: userId,
      product_id: productId,
      location_id: locationId,
      qty_containers: 2,
      expires_on: '2026-03-10',
    });
    expect(lot1Error).toBeNull();

    // Insert lot 2 — later expiry
    const { error: lot2Error } = await chef.from('stock_lots').insert({
      user_id: userId,
      product_id: productId,
      location_id: locationId,
      qty_containers: 3,
      expires_on: '2026-04-15',
    });
    expect(lot2Error).toBeNull();

    return { productId, locationId };
  }

  it('consume_product depletes nearest-expiry lot first (FIFO)', async () => {
    const { userId, client } = await createTestUser('stock-fifo');
    userIds.push(userId);
    const { productId } = await setupProducts(client, userId);

    const chef = client.schema('chefbyte') as any;

    // Consume 1.5 containers — should take from the nearer-expiry lot first
    const { data, error } = await chef.rpc('consume_product', {
      p_product_id: productId,
      p_qty: 1.5,
      p_unit: 'container',
      p_log_macros: true,
      p_logical_date: '2026-03-03',
    });
    expect(error).toBeNull();
    expect(data.success).toBe(true);

    // Verify stock remaining is 3.5 (5 - 1.5)
    expect(Number(data.stock_remaining)).toBeCloseTo(3.5, 1);

    // Query lots directly to verify FIFO depletion
    const { data: lots, error: lotsError } = await chef
      .from('stock_lots')
      .select('qty_containers, expires_on')
      .eq('product_id', productId)
      .order('expires_on', { ascending: true });
    expect(lotsError).toBeNull();

    // Lot 1 (2026-03-10) should have been partially consumed: 2 - 1.5 = 0.5
    // Lot 2 (2026-04-15) should be untouched at 3
    expect(lots).toHaveLength(2);
    expect(Number(lots![0].qty_containers)).toBeCloseTo(0.5, 1);
    expect(lots![0].expires_on).toBe('2026-03-10');
    expect(Number(lots![1].qty_containers)).toBeCloseTo(3, 1);
    expect(lots![1].expires_on).toBe('2026-04-15');
  });

  it('consume_product logs macros for full consumed amount', async () => {
    const { userId, client } = await createTestUser('stock-macros');
    userIds.push(userId);
    const { productId } = await setupProducts(client, userId);

    const chef = client.schema('chefbyte') as any;

    // Consume 2 servings with log_macros=true
    // 2 servings * 165 cal/serving = 330 cal
    // 2 servings * 31g protein/serving = 62g protein
    // 2 servings * 0g carbs/serving = 0g carbs
    // 2 servings * 3.6g fat/serving = 7.2g fat
    const { data, error } = await chef.rpc('consume_product', {
      p_product_id: productId,
      p_qty: 2,
      p_unit: 'serving',
      p_log_macros: true,
      p_logical_date: '2026-03-03',
    });
    expect(error).toBeNull();
    expect(data.success).toBe(true);

    // Verify macros in return value
    expect(Number(data.macros.calories)).toBeCloseTo(330, 1);
    expect(Number(data.macros.protein)).toBeCloseTo(62, 1);
    expect(Number(data.macros.carbs)).toBeCloseTo(0, 1);
    expect(Number(data.macros.fat)).toBeCloseTo(7.2, 1);

    // Verify food_logs entry was created
    const { data: logs, error: logsError } = await chef
      .from('food_logs')
      .select('qty_consumed, unit, calories, carbs, protein, fat')
      .eq('product_id', productId)
      .eq('user_id', userId);
    expect(logsError).toBeNull();

    expect(logs).toHaveLength(1);
    expect(Number(logs![0].qty_consumed)).toBeCloseTo(2, 1);
    expect(logs![0].unit).toBe('serving');
    expect(Number(logs![0].calories)).toBeCloseTo(330, 1);
    expect(Number(logs![0].protein)).toBeCloseTo(62, 1);
    expect(Number(logs![0].carbs)).toBeCloseTo(0, 1);
    expect(Number(logs![0].fat)).toBeCloseTo(7.2, 1);
  });

  it('consume_product with log_macros=false still depletes stock but creates no food_log', async () => {
    const { userId, client } = await createTestUser('stock-nolog');
    userIds.push(userId);
    const { productId } = await setupProducts(client, userId);

    const chef = client.schema('chefbyte') as any;

    // Consume 1 container with log_macros=false
    const { data, error } = await chef.rpc('consume_product', {
      p_product_id: productId,
      p_qty: 1,
      p_unit: 'container',
      p_log_macros: false,
      p_logical_date: '2026-03-03',
    });
    expect(error).toBeNull();
    expect(data.success).toBe(true);

    // Stock should go from 5 to 4 containers
    expect(Number(data.stock_remaining)).toBeCloseTo(4, 1);

    // Verify no food_logs entries were created
    const { data: logs, error: logsError } = await chef
      .from('food_logs')
      .select('log_id')
      .eq('product_id', productId)
      .eq('user_id', userId);
    expect(logsError).toBeNull();
    expect(logs).toHaveLength(0);
  });

  it('consume_product beyond available stock floors at 0 and logs macros for full amount', async () => {
    const { userId, client } = await createTestUser('stock-floor');
    userIds.push(userId);
    const { productId } = await setupProducts(client, userId);

    const chef = client.schema('chefbyte') as any;

    // Consume 10 containers when only 5 exist
    // Macros should be for full 10 containers: 10 * 4 spc * 165 cal = 6600 cal
    const { data, error } = await chef.rpc('consume_product', {
      p_product_id: productId,
      p_qty: 10,
      p_unit: 'container',
      p_log_macros: true,
      p_logical_date: '2026-03-03',
    });
    expect(error).toBeNull();
    expect(data.success).toBe(true);

    // Stock remaining should be 0 (all lots deleted)
    expect(Number(data.stock_remaining)).toBeCloseTo(0, 1);

    // Verify all lots are gone (fully consumed lots are deleted)
    const { data: lots, error: lotsError } = await chef
      .from('stock_lots')
      .select('lot_id')
      .eq('product_id', productId)
      .eq('user_id', userId);
    expect(lotsError).toBeNull();
    expect(lots).toHaveLength(0);

    // Verify macros logged for the FULL 10 containers, not just the 5 available
    // 10 containers * 4 servings/container = 40 servings
    // 40 * 165 cal = 6600 calories
    // 40 * 31g protein = 1240g protein
    // 40 * 0g carbs = 0g carbs
    // 40 * 3.6g fat = 144g fat
    expect(Number(data.macros.calories)).toBeCloseTo(6600, 1);
    expect(Number(data.macros.protein)).toBeCloseTo(1240, 1);
    expect(Number(data.macros.carbs)).toBeCloseTo(0, 1);
    expect(Number(data.macros.fat)).toBeCloseTo(144, 1);

    // Verify food_logs entry has the full amount
    const { data: logs, error: logsError2 } = await chef
      .from('food_logs')
      .select('qty_consumed, unit, calories, protein')
      .eq('product_id', productId)
      .eq('user_id', userId);
    expect(logsError2).toBeNull();

    expect(logs).toHaveLength(1);
    expect(Number(logs![0].qty_consumed)).toBeCloseTo(10, 1);
    expect(logs![0].unit).toBe('container');
    expect(Number(logs![0].calories)).toBeCloseTo(6600, 1);
    expect(Number(logs![0].protein)).toBeCloseTo(1240, 1);
  });
});
