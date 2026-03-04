import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPageTestContext,
  chefbyte,
  seedAllChefByte,
  assertQuerySucceeds,
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
    expect(names).toEqual(['Bananas', 'Brown Rice', 'Chicken Breast', 'Eggs', 'Protein Powder']);

    // Verify shape of returned rows matches InventoryPage Product interface
    const first = data[0];
    expect(typeof first.product_id).toBe('string');
    expect(first.user_id).toBe(ctx.userId);
    expect(first.name).toBe('Bananas');
    expect(first.barcode).toBeNull();
    expect(Number(first.servings_per_container)).toBe(1);
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
    expect(Number(qtyByProduct.get(seeds.productMap['Chicken Breast']))).toBeCloseTo(3.0, 1);
    expect(Number(qtyByProduct.get(seeds.productMap['Brown Rice']))).toBeCloseTo(2.0, 1);
    expect(Number(qtyByProduct.get(seeds.productMap['Eggs']))).toBeCloseTo(0.5, 1);
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
    const chicken = grouped.find((g: any) => g.product.name === 'Chicken Breast');
    expect(chicken).toBeDefined();
    expect(chicken!.totalStock).toBeCloseTo(3.0, 1);
    expect(chicken!.lotCount).toBe(1);
    expect(typeof chicken!.nearestExpiry).toBe('string');

    const rice = grouped.find((g: any) => g.product.name === 'Brown Rice');
    expect(rice).toBeDefined();
    expect(rice!.totalStock).toBeCloseTo(2.0, 1);
    expect(rice!.lotCount).toBe(1);
    expect(typeof rice!.nearestExpiry).toBe('string');

    const eggs = grouped.find((g: any) => g.product.name === 'Eggs');
    expect(eggs).toBeDefined();
    expect(eggs!.totalStock).toBeCloseTo(0.5, 1);
    expect(eggs!.lotCount).toBe(1);
    expect(typeof eggs!.nearestExpiry).toBe('string');

    const bananas = grouped.find((g: any) => g.product.name === 'Bananas');
    expect(bananas).toBeDefined();
    expect(bananas!.totalStock).toBe(0);
    expect(bananas!.lotCount).toBe(0);
    expect(bananas!.nearestExpiry).toBeNull();

    // "Protein Powder" has no stock lots
    const protein = grouped.find((g: any) => g.product.name === 'Protein Powder');
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
  // Exact insert from InventoryPage.tsx addStock (line 163-171)
  // -----------------------------------------------------------------------
  it('addStock insert matches page pattern', async () => {
    const productId = seeds.productMap['Protein Powder'];
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
});
