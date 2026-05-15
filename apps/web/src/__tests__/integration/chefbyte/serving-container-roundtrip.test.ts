/**
 * Integration test — serving ↔ container conversion round-trip.
 *
 * pgTAP already covers the `consume_product` conversion math at the DB layer
 * (`supabase/tests/chefbyte/consume_product.test.sql`). This spec pins the
 * **integration boundary**: the write-canonical (containers) / read-displayed
 * (servings or containers) contract that the inventory page + scanner +
 * chef UI rely on.
 *
 * Scenarios:
 *   1. Seed product: servings_per_container=6, 100 cal/serving.
 *   2. Write stock in CONTAINERS (canonical): +2 containers.
 *   3. Read via the exact InventoryPage query shape.
 *      Assert: 2 containers = 12 servings.
 *   4. Consume 3 SERVINGS (→ 0.5 containers via servings_per_container).
 *      Assert: 1.5 containers = 9 servings remain.
 *   5. Consume 10 SERVINGS — more than available.
 *      Assert: remaining floors at 0 containers / 0 servings (not negative).
 *   6. Assert food_logs captured the full 10 servings (not just the 9
 *      actually available) — spec-mandated behavior.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createTestUser, cleanupUser } from '../../test-helpers';

let userIds: string[] = [];

afterEach(async () => {
  for (const id of userIds) {
    await cleanupUser(id);
  }
  userIds = [];
});

describe('ChefByte serving ↔ container conversion round-trip (integration)', () => {
  it('writes in containers, reads both units, consumes in servings, floors at zero', async () => {
    const { userId, client } = await createTestUser('serving-rt');
    userIds.push(userId);
    const chef = client.schema('chefbyte') as any;

    // ------------------------------------------------------------
    // 1. Seed: location + product with servings_per_container=6
    // ------------------------------------------------------------
    const SPC = 6;
    const CAL = 100;
    const PRO = 10;
    const CAR = 20;
    const FAT = 5;

    const { data: locData, error: locErr } = await chef
      .from('locations')
      .insert({ user_id: userId, name: 'Fridge' })
      .select('location_id')
      .single();
    expect(locErr).toBeNull();
    const locationId: string = locData.location_id;

    const { data: prodData, error: prodErr } = await chef
      .from('products')
      .insert({
        user_id: userId,
        name: 'Test Product',
        servings_per_container: SPC,
        calories_per_serving: CAL,
        protein_per_serving: PRO,
        carbs_per_serving: CAR,
        fat_per_serving: FAT,
        min_stock_amount: 1,
      })
      .select('product_id')
      .single();
    expect(prodErr).toBeNull();
    const productId: string = prodData.product_id;

    // ------------------------------------------------------------
    // 2. Write stock in CONTAINERS (canonical unit): +2 containers.
    // ------------------------------------------------------------
    const { error: lotErr } = await chef.from('stock_lots').insert({
      user_id: userId,
      product_id: productId,
      location_id: locationId,
      qty_containers: 2,
      expires_on: '2026-06-01',
    });
    expect(lotErr).toBeNull();

    // ------------------------------------------------------------
    // 3. Read via the inventory page query shape. Assert 2 containers = 12 servings.
    //    Matches apps/web/src/pages/chefbyte/InventoryPage.tsx shape:
    //    products: product_id,user_id,name,barcode,servings_per_container,min_stock_amount
    //    stock_lots: lot_id,product_id,qty_containers,expires_on,locations:location_id(name)
    // ------------------------------------------------------------
    const readPostWrite = await readInventoryForProduct(chef, userId, productId);
    expect(readPostWrite.totalContainers).toBeCloseTo(2, 3);
    expect(readPostWrite.spc).toBe(SPC);
    expect(readPostWrite.totalServings).toBeCloseTo(12, 3); // 2 * 6

    // ------------------------------------------------------------
    // 4. Consume 3 SERVINGS via the public chefbyte.consume_product RPC.
    //    Conversion: 3 servings / 6 spc = 0.5 containers.
    //    Remaining stock: 2 - 0.5 = 1.5 containers = 9 servings.
    // ------------------------------------------------------------
    const { data: consume1, error: consume1Err } = await chef.rpc('consume_product', {
      p_product_id: productId,
      p_qty: 3,
      p_unit: 'serving',
      p_log_macros: true,
      p_logical_date: '2026-05-01',
    });
    expect(consume1Err).toBeNull();
    expect(consume1.success).toBe(true);
    expect(Number(consume1.stock_remaining)).toBeCloseTo(1.5, 3);

    // Macros logged match the 3 servings: 300 cal, 30g pro, 60g carbs, 15g fat
    expect(Number(consume1.macros.calories)).toBeCloseTo(300, 3);
    expect(Number(consume1.macros.protein)).toBeCloseTo(30, 3);
    expect(Number(consume1.macros.carbs)).toBeCloseTo(60, 3);
    expect(Number(consume1.macros.fat)).toBeCloseTo(15, 3);

    const readPostConsume1 = await readInventoryForProduct(chef, userId, productId);
    expect(readPostConsume1.totalContainers).toBeCloseTo(1.5, 3);
    expect(readPostConsume1.totalServings).toBeCloseTo(9, 3); // 1.5 * 6

    // ------------------------------------------------------------
    // 5. Consume 10 SERVINGS — more than available (9 servings / 1.5 containers).
    //    Stock floors at 0. 10 servings / 6 spc = 1.667 containers requested,
    //    but only 1.5 available; all lots deleted; no negative qty.
    // ------------------------------------------------------------
    const { data: consume2, error: consume2Err } = await chef.rpc('consume_product', {
      p_product_id: productId,
      p_qty: 10,
      p_unit: 'serving',
      p_log_macros: true,
      p_logical_date: '2026-05-01',
    });
    expect(consume2Err).toBeNull();
    expect(consume2.success).toBe(true);
    expect(Number(consume2.stock_remaining)).toBeCloseTo(0, 3);

    const readPostConsume2 = await readInventoryForProduct(chef, userId, productId);
    expect(readPostConsume2.totalContainers).toBeCloseTo(0, 3);
    expect(readPostConsume2.totalServings).toBeCloseTo(0, 3);
    // Stock MUST NOT be negative.
    expect(readPostConsume2.totalContainers).toBeGreaterThanOrEqual(0);
    expect(readPostConsume2.totalServings).toBeGreaterThanOrEqual(0);
    // All lot rows should have been fully consumed & deleted.
    expect(readPostConsume2.lotCount).toBe(0);

    // ------------------------------------------------------------
    // 6. Spec-mandated: macros logged for the FULL consumed amount
    //    (10 servings), not just the 9 actually available in stock.
    //    Full 10 servings: ~1000 cal, ~100g pro, ~200g carbs, ~50g fat.
    //    NOTE: precision 0 because consume_product internally converts
    //    10 servings → 1.667 containers (NUMERIC(10,3) rounding) then
    //    back to 1.667 * 6 = 10.002 servings → 1000.2 cal. Project
    //    convention: NUMERIC(10,3) storage, 1-decimal display.
    // ------------------------------------------------------------
    expect(Number(consume2.macros.calories)).toBeCloseTo(1000, 0);
    expect(Number(consume2.macros.protein)).toBeCloseTo(100, 0);
    expect(Number(consume2.macros.carbs)).toBeCloseTo(200, 0);
    expect(Number(consume2.macros.fat)).toBeCloseTo(50, 0);

    // Critically: the logged macros MUST exceed what was actually in stock
    // (9 servings = 900 cal). This is the spec guarantee — macros track
    // the requested consume, not the available stock.
    expect(Number(consume2.macros.calories)).toBeGreaterThan(900);

    // Verify the DB food_logs row for the floor-at-zero consume.
    const { data: logs, error: logsErr } = await chef
      .from('food_logs')
      .select('qty_consumed, unit, calories, protein, carbs, fat')
      .eq('product_id', productId)
      .eq('user_id', userId)
      .order('calories', { ascending: false });
    expect(logsErr).toBeNull();
    expect(logs).toHaveLength(2); // one per consume call
    const floorLog = logs![0]; // highest calories = the 10-serving call
    expect(Number(floorLog.qty_consumed)).toBeCloseTo(10, 3);
    expect(floorLog.unit).toBe('serving');
    expect(Number(floorLog.calories)).toBeCloseTo(1000, 0);
    expect(Number(floorLog.protein)).toBeCloseTo(100, 0);
    expect(Number(floorLog.carbs)).toBeCloseTo(200, 0);
    expect(Number(floorLog.fat)).toBeCloseTo(50, 0);
    // Same spec guarantee at the DB row level
    expect(Number(floorLog.calories)).toBeGreaterThan(900);
  });
});

/**
 * Replicate the InventoryPage read path exactly:
 *   products:    product_id,user_id,name,barcode,servings_per_container,min_stock_amount
 *   stock_lots:  lot_id,product_id,qty_containers,expires_on,locations:location_id(name)
 *
 * Then derive displayed-unit totals (servings = containers * servings_per_container)
 * the way the inventory UI does.
 */
async function readInventoryForProduct(chef: any, userId: string, productId: string) {
  const { data: products, error: pErr } = await chef
    .from('products')
    .select('product_id,user_id,name,barcode,servings_per_container,min_stock_amount')
    .eq('user_id', userId)
    .eq('product_id', productId);
  expect(pErr).toBeNull();
  expect(products).toHaveLength(1);
  const spc = Number(products![0].servings_per_container);

  // Mirror the production InventoryPage query — filter out soft-deleted
  // tombstones (G1 migration: stock_lots DELETE → UPDATE qty=0,
  // deleted_at=now()) so the test sees what the user sees.
  const { data: lots, error: lErr } = await chef
    .from('stock_lots')
    .select('lot_id,product_id,qty_containers,expires_on,locations:location_id(name)')
    .eq('user_id', userId)
    .eq('product_id', productId)
    .is('deleted_at', null);
  expect(lErr).toBeNull();

  const totalContainers = (lots ?? []).reduce((acc: number, l: any) => acc + Number(l.qty_containers), 0);

  return {
    spc,
    totalContainers,
    totalServings: totalContainers * spc,
    lotCount: (lots ?? []).length,
  };
}
