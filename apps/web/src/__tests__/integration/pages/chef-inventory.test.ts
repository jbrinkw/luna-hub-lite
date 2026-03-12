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

describe('ChefByte InventoryPage queries', () => {
  let ctx: PageTestContext;
  let seeds: ChefByteSeeds;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-inventory');
    seeds = await seedAllChefByte(ctx);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // -----------------------------------------------------------------------
  // Exact query from InventoryPage.tsx line 73-77
  // -----------------------------------------------------------------------
  it('products query matches page pattern', async () => {
    const result = await chefbyte(ctx.client)
      .from('products')
      .select('product_id,user_id,name,barcode,servings_per_container,min_stock_amount')
      .eq('user_id', ctx.userId)
      .order('name');

    const data = assertQuerySucceeds(result, 'products');
    expect(data.length).toBe(5);

    // Verify exact seeded product names in alphabetical order
    const names = data.map((p: any) => p.name);
    expect(names).toEqual([
      'Banquet Chicken Breast Patties',
      'Birds Eye Sweet Peas',
      'Great Value Boneless Skinless Chicken Breasts',
      'Great Value Large White Eggs',
      'Great Value Long Grain Brown Rice',
    ]);

    // Verify shape of returned rows matches InventoryPage Product interface
    const first = data[0];
    expect(typeof first.product_id).toBe('string');
    expect(first.user_id).toBe(ctx.userId);
    expect(first.name).toBe('Banquet Chicken Breast Patties');
    expect(first.barcode).toBeNull();
    expect(Number(first.servings_per_container)).toBe(6);
    expect(Number(first.min_stock_amount)).toBe(3);
  });

  // -----------------------------------------------------------------------
  // Exact query from InventoryPage.tsx line 79-82
  // -----------------------------------------------------------------------
  it('stock_lots query with location join matches page pattern', async () => {
    const result = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('lot_id,product_id,qty_containers,expires_on,locations:location_id(name)')
      .eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'stock_lots');
    expect(data.length).toBe(3); // Chicken=3, Rice=2, Eggs=0.5

    // Verify shape matches InventoryPage StockLot interface
    const first = data[0];
    expect(typeof first.lot_id).toBe('string');
    expect(typeof first.product_id).toBe('string');
    expect(first.expires_on).not.toBeUndefined();

    // Verify the foreign-key join returns location name
    const withLocation = data.find((l: any) => l.locations !== null);
    expect(withLocation).toBeDefined();
    expect(withLocation.locations.name).toBe('Fridge');

    // Verify exact stock quantities from seed data
    const qtyByProduct = new Map<string, number>();
    for (const lot of data) {
      const existing = qtyByProduct.get(lot.product_id) ?? 0;
      qtyByProduct.set(lot.product_id, existing + Number(lot.qty_containers));
    }
    expect(Number(qtyByProduct.get(seeds.productMap['Great Value Boneless Skinless Chicken Breasts']))).toBeCloseTo(
      3.0,
      1,
    );
    expect(Number(qtyByProduct.get(seeds.productMap['Great Value Long Grain Brown Rice']))).toBeCloseTo(2.0, 1);
    expect(Number(qtyByProduct.get(seeds.productMap['Great Value Large White Eggs']))).toBeCloseTo(0.5, 1);
  });

  // -----------------------------------------------------------------------
  // Exact query from InventoryPage.tsx line 84-89 (first location)
  // -----------------------------------------------------------------------
  it('first location query matches page pattern', async () => {
    const result = await chefbyte(ctx.client)
      .from('locations')
      .select('location_id')
      .eq('user_id', ctx.userId)
      .order('created_at')
      .limit(1);

    const data = assertQuerySucceeds(result, 'first location');
    expect(data).toHaveLength(1);
    expect(data[0]).toHaveProperty('location_id');
    expect(typeof data[0].location_id).toBe('string');
  });

  // -----------------------------------------------------------------------
  // Verify stock lots can be grouped by product (JS aggregation in page)
  // -----------------------------------------------------------------------
  it('stock lots can be aggregated per product for grouped view', async () => {
    // Load both datasets using page queries
    const { data: prods } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id,user_id,name,barcode,servings_per_container,min_stock_amount')
      .eq('user_id', ctx.userId)
      .order('name');

    const { data: stockLots } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('lot_id,product_id,qty_containers,expires_on,locations:location_id(name)')
      .eq('user_id', ctx.userId);

    expect(prods).not.toBeNull();
    expect(prods!.length).toBe(5);
    expect(stockLots).not.toBeNull();
    expect(stockLots!.length).toBe(3);

    // Replicate page-side aggregation logic
    const lotsByProduct = new Map<string, any[]>();
    for (const lot of stockLots!) {
      const existing = lotsByProduct.get(lot.product_id) ?? [];
      existing.push(lot);
      lotsByProduct.set(lot.product_id, existing);
    }

    const grouped = prods!.map((product: any) => {
      const productLots = lotsByProduct.get(product.product_id) ?? [];
      const totalStock = productLots.reduce((sum: number, l: any) => sum + Number(l.qty_containers), 0);
      const expiries = productLots
        .map((l: any) => l.expires_on)
        .filter((e: any): e is string => e !== null)
        .sort();
      return {
        product,
        totalStock,
        nearestExpiry: expiries[0] ?? null,
        lotCount: productLots.length,
      };
    });

    // Verify exact stock values for each seeded product
    const chicken = grouped.find((g: any) => g.product.name === 'Great Value Boneless Skinless Chicken Breasts');
    expect(chicken).toBeDefined();
    expect(chicken!.totalStock).toBeCloseTo(3.0, 1);
    expect(chicken!.lotCount).toBe(1);
    expect(typeof chicken!.nearestExpiry).toBe('string');

    const rice = grouped.find((g: any) => g.product.name === 'Great Value Long Grain Brown Rice');
    expect(rice).toBeDefined();
    expect(rice!.totalStock).toBeCloseTo(2.0, 1);
    expect(rice!.lotCount).toBe(1);
    expect(typeof rice!.nearestExpiry).toBe('string');

    const eggs = grouped.find((g: any) => g.product.name === 'Great Value Large White Eggs');
    expect(eggs).toBeDefined();
    expect(eggs!.totalStock).toBeCloseTo(0.5, 1);
    expect(eggs!.lotCount).toBe(1);
    expect(typeof eggs!.nearestExpiry).toBe('string');

    const bananas = grouped.find((g: any) => g.product.name === 'Banquet Chicken Breast Patties');
    expect(bananas).toBeDefined();
    expect(bananas!.totalStock).toBe(0);
    expect(bananas!.lotCount).toBe(0);
    expect(bananas!.nearestExpiry).toBeNull();

    // "Protein Powder" has no stock lots
    const protein = grouped.find((g: any) => g.product.name === 'Birds Eye Sweet Peas');
    expect(protein).toBeDefined();
    expect(protein!.totalStock).toBe(0);
    expect(protein!.lotCount).toBe(0);
    expect(protein!.nearestExpiry).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Verify sorted lots view (expiry ASC NULLS LAST, then name)
  // -----------------------------------------------------------------------
  it('stock lots can be sorted for lots view', async () => {
    const { data: prods } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id,user_id,name,barcode,servings_per_container,min_stock_amount')
      .eq('user_id', ctx.userId)
      .order('name');

    const { data: lots } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('lot_id,product_id,qty_containers,expires_on,locations:location_id(name)')
      .eq('user_id', ctx.userId);

    const productMap = new Map(prods!.map((p: any) => [p.product_id, p]));

    const sortedLots = [...lots!]
      .map((lot: any) => ({
        ...lot,
        productName: productMap.get(lot.product_id)?.name ?? 'Unknown',
      }))
      .sort((a: any, b: any) => {
        if (!a.expires_on && !b.expires_on) return a.productName.localeCompare(b.productName);
        if (!a.expires_on) return 1;
        if (!b.expires_on) return -1;
        const dateCompare = a.expires_on.localeCompare(b.expires_on);
        if (dateCompare !== 0) return dateCompare;
        return a.productName.localeCompare(b.productName);
      });

    expect(sortedLots.length).toBe(3);

    // Verify sorting: all dated lots come before null-expiry lots
    let lastDate: string | null = null;
    let hitNull = false;
    for (const lot of sortedLots) {
      if (lot.expires_on === null) {
        hitNull = true;
      } else {
        // Once we've seen null, no more dated lots should appear
        expect(hitNull).toBe(false);
        // Dates should be ascending
        if (lastDate !== null) {
          expect(lot.expires_on >= lastDate).toBe(true);
        }
        lastDate = lot.expires_on;
      }
    }
  });

  // -----------------------------------------------------------------------
  // Grouped view filters out zero-stock products
  // Source: InventoryPage.tsx filteredGrouped — g.totalStock > 0
  // -----------------------------------------------------------------------
  it('grouped view filters out zero-stock products', async () => {
    // Load both datasets using page queries
    const { data: prods } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id,user_id,name,barcode,servings_per_container,min_stock_amount')
      .eq('user_id', ctx.userId)
      .order('name');

    const { data: stockLots } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('lot_id,product_id,qty_containers,expires_on,locations:location_id(name)')
      .eq('user_id', ctx.userId);

    expect(prods).not.toBeNull();
    expect(stockLots).not.toBeNull();

    // Replicate page-side aggregation logic
    const lotsByProduct = new Map<string, any[]>();
    for (const lot of stockLots!) {
      const existing = lotsByProduct.get(lot.product_id) ?? [];
      existing.push(lot);
      lotsByProduct.set(lot.product_id, existing);
    }

    const grouped = prods!.map((product: any) => {
      const productLots = lotsByProduct.get(product.product_id) ?? [];
      const totalStock = productLots.reduce((sum: number, l: any) => sum + Number(l.qty_containers), 0);
      return { product, totalStock };
    });

    // Apply the exact filter from InventoryPage.tsx filteredGrouped
    const filteredGrouped = grouped.filter((g: any) => g.totalStock > 0);

    // Bananas (0 stock) and Protein Powder (0 stock) should be excluded
    expect(filteredGrouped.length).toBe(3); // Chicken, Rice, Eggs only
    const names = filteredGrouped.map((g: any) => g.product.name).sort();
    expect(names).toEqual([
      'Great Value Boneless Skinless Chicken Breasts',
      'Great Value Large White Eggs',
      'Great Value Long Grain Brown Rice',
    ]);

    // All zero-stock products should NOT appear
    const zeroStockNames = grouped
      .filter((g: any) => g.totalStock <= 0)
      .map((g: any) => g.product.name)
      .sort();
    expect(zeroStockNames).toEqual(['Banquet Chicken Breast Patties', 'Birds Eye Sweet Peas']);

    // Verify none of the filtered items have zero stock
    for (const item of filteredGrouped) {
      expect(item.totalStock).toBeGreaterThan(0);
    }
  });

  // -----------------------------------------------------------------------
  // Consume by serving unit converts to containers
  // Source: InventoryPage.tsx consumeStock() — consume_product RPC with unit='serving'
  // The RPC internally converts: qty / servings_per_container
  // -----------------------------------------------------------------------
  it('consume by serving unit converts to containers', async () => {
    const eggsId = seeds.productMap['Great Value Large White Eggs']; // 12 servings_per_container, 0.5 containers
    const today = todayDate();

    // Get stock before
    const { data: before } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('qty_containers')
      .eq('product_id', eggsId);
    const totalBefore = before!.reduce((sum: number, l: any) => sum + Number(l.qty_containers), 0);
    expect(totalBefore).toBeCloseTo(0.5, 1);

    // Consume 1 serving (EXACT RPC from InventoryPage)
    const result = await (chefbyte(ctx.client) as any).rpc('consume_product', {
      p_product_id: eggsId,
      p_qty: 1,
      p_unit: 'serving',
      p_log_macros: true,
      p_logical_date: today,
    });
    expect(result.error).toBeNull();

    // Verify stock reduced by 1/12 containers (~0.083)
    const { data: after } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('qty_containers')
      .eq('product_id', eggsId);
    const totalAfter = after!.reduce((sum: number, l: any) => sum + Number(l.qty_containers), 0);

    // 0.5 - (1/12) = ~0.417
    const expectedReduction = 1 / 12;
    expect(totalAfter).toBeCloseTo(totalBefore - expectedReduction, 2);

    // Cleanup food_logs
    await chefbyte(ctx.client).from('food_logs').delete().eq('user_id', ctx.userId);
  });

  // -----------------------------------------------------------------------
  // Stock lot merge on same product/location/expiry
  // Source: InventoryPage.tsx addStock() — looks for existing lot then updates qty
  // -----------------------------------------------------------------------
  it('stock lot merge on same product/location/expiry', async () => {
    const chickenId = seeds.productMap['Great Value Boneless Skinless Chicken Breasts'];
    const locationId = seeds.locationId;

    // Get existing lot details
    const { data: lots } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('lot_id, qty_containers, expires_on')
      .eq('product_id', chickenId)
      .eq('user_id', ctx.userId);
    expect(lots!.length).toBe(1);
    const existingLot = lots![0] as any;
    const originalQty = Number(existingLot.qty_containers);

    // Replicate the merge logic from InventoryPage.tsx addStock():
    // 1. Find existing lot with same product/location/expiry
    let findQuery = chefbyte(ctx.client)
      .from('stock_lots')
      .select('lot_id, qty_containers')
      .eq('user_id', ctx.userId)
      .eq('product_id', chickenId)
      .eq('location_id', locationId);

    if (existingLot.expires_on) {
      findQuery = findQuery.eq('expires_on', existingLot.expires_on);
    } else {
      findQuery = findQuery.is('expires_on', null);
    }

    const { data: found } = await findQuery.limit(1).maybeSingle();
    expect(found).not.toBeNull();
    expect((found as any).lot_id).toBe(existingLot.lot_id);

    // 2. Merge: update qty_containers on existing lot (EXACT pattern from InventoryPage)
    const addQty = 2;
    const mergeResult = await chefbyte(ctx.client)
      .from('stock_lots')
      .update({ qty_containers: Number((found as any).qty_containers) + addQty })
      .eq('lot_id', (found as any).lot_id);
    expect(mergeResult.error).toBeNull();

    // 3. Verify merged — same lot_id, increased quantity, no new lot created
    const { data: afterLots } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('lot_id, qty_containers')
      .eq('product_id', chickenId)
      .eq('user_id', ctx.userId);
    expect(afterLots!.length).toBe(1); // Still one lot, not two
    expect(Number((afterLots![0] as any).qty_containers)).toBeCloseTo(originalQty + addQty, 1);

    // Restore original qty
    await chefbyte(ctx.client)
      .from('stock_lots')
      .update({ qty_containers: originalQty })
      .eq('lot_id', existingLot.lot_id);
  });

  // -----------------------------------------------------------------------
  // Exact insert from InventoryPage.tsx addStock (line 163-171)
  // -----------------------------------------------------------------------
  it('addStock insert matches page pattern', async () => {
    const productId = seeds.productMap['Birds Eye Sweet Peas'];
    const locationId = seeds.locationId;

    const result = await chefbyte(ctx.client).from('stock_lots').insert({
      user_id: ctx.userId,
      product_id: productId,
      location_id: locationId,
      qty_containers: 1,
      expires_on: null,
    });

    expect(result.error).toBeNull();

    // Verify the lot was created
    const { data: lots } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('lot_id,qty_containers')
      .eq('product_id', productId)
      .eq('user_id', ctx.userId);

    expect(lots).not.toBeNull();
    expect(lots!.length).toBe(1);
    expect(Number(lots![0].qty_containers)).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Exact update from InventoryPage.tsx addStock merge path
  // When product/location/expiry match an existing lot, update qty
  // -----------------------------------------------------------------------
  it('addStock merges into existing lot when product/location/expiry match', async () => {
    const chickenId = seeds.productMap['Great Value Boneless Skinless Chicken Breasts'];

    // Get existing lot
    const { data: lots } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('lot_id, qty_containers, expires_on')
      .eq('product_id', chickenId);
    expect(lots!.length).toBe(1);
    const existingLot = lots![0];
    const originalQty = Number(existingLot.qty_containers);

    // Merge: update qty_containers on existing lot (EXACT pattern from InventoryPage)
    const mergeResult = await chefbyte(ctx.client)
      .from('stock_lots')
      .update({ qty_containers: originalQty + 2 })
      .eq('lot_id', existingLot.lot_id);
    expect(mergeResult.error).toBeNull();

    // Verify merged
    const { data: after } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('qty_containers')
      .eq('lot_id', existingLot.lot_id)
      .single();
    expect(Number(after!.qty_containers)).toBeCloseTo(originalQty + 2, 1);

    // Restore original qty
    await chefbyte(ctx.client)
      .from('stock_lots')
      .update({ qty_containers: originalQty })
      .eq('lot_id', existingLot.lot_id);
  });

  // -----------------------------------------------------------------------
  // consume_product RPC from inventory page
  // -----------------------------------------------------------------------
  it('consume_product RPC depletes stock from inventory', async () => {
    const chickenId = seeds.productMap['Great Value Boneless Skinless Chicken Breasts'];
    const today = todayDate();

    // Get stock before
    const { data: before } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('qty_containers')
      .eq('product_id', chickenId);
    const totalBefore = before!.reduce((sum: number, l: any) => sum + Number(l.qty_containers), 0);

    // Consume 1 container (EXACT RPC from InventoryPage)
    const result = await (chefbyte(ctx.client) as any).rpc('consume_product', {
      p_product_id: chickenId,
      p_qty: 1,
      p_unit: 'container',
      p_log_macros: true,
      p_logical_date: today,
    });
    expect(result.error).toBeNull();

    // Verify stock reduced
    const { data: after } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('qty_containers')
      .eq('product_id', chickenId);
    const totalAfter = after!.reduce((sum: number, l: any) => sum + Number(l.qty_containers), 0);
    expect(totalAfter).toBeCloseTo(totalBefore - 1, 1);

    // Cleanup food_logs
    await chefbyte(ctx.client).from('food_logs').delete().eq('user_id', ctx.userId);
  });

  // -----------------------------------------------------------------------
  // #8: Consume all stock — depletes to zero
  // The UI calls consume_product with the full total stock qty.
  // This test verifies the RPC works when consuming the entire stock.
  // -----------------------------------------------------------------------
  it('consume all stock — depletes product to zero lots', async () => {
    // Get a product with stock
    const { data: products } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id')
      .eq('user_id', ctx.userId)
      .limit(1);
    const pid = (products as any)?.[0]?.product_id;
    expect(pid).toBeDefined();

    // Ensure there's stock
    const { data: lotsBefore } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('qty_containers')
      .eq('product_id', pid);
    const totalBefore2 = ((lotsBefore as any[]) ?? []).reduce((s: number, l: any) => s + Number(l.qty_containers), 0);

    if (totalBefore2 <= 0) return; // Skip if no stock

    const today = todayDate();
    const result = await (ctx.client.schema('chefbyte') as any).rpc('consume_product', {
      p_product_id: pid,
      p_qty: totalBefore2,
      p_unit: 'container',
      p_log_macros: false,
      p_logical_date: today,
    });
    expect(result.error).toBeNull();

    // Verify all lots consumed
    const { data: lotsAfter } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('qty_containers')
      .eq('product_id', pid);
    const totalAfter2 = ((lotsAfter as any[]) ?? []).reduce((s: number, l: any) => s + Number(l.qty_containers), 0);
    expect(totalAfter2).toBe(0);
  });
});
