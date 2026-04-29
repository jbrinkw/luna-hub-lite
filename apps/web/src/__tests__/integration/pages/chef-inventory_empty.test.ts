import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPageTestContext, chefbyte, assertQuerySucceeds, type PageTestContext } from './helpers';

/* ================================================================== */
/*  Empty-fixture sibling for chef-inventory.test.ts (L9 audit)        */
/*                                                                     */
/*  Closes the production-shape gap that hid the Pi `scale_pairings`   */
/*  empty-in-prod regression: every >0-row fixture test must have an   */
/*  empty-table sibling exercising the same code path.                 */
/* ================================================================== */

describe('ChefByte InventoryPage queries — empty fixture', () => {
  let ctx: PageTestContext;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-inventory-empty');
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('products query returns [] for a fresh user with no products', async () => {
    const result = await chefbyte(ctx.client)
      .from('products')
      .select('product_id,user_id,name,barcode,servings_per_container,min_stock_amount')
      .eq('user_id', ctx.userId)
      .order('name');

    const data = assertQuerySucceeds(result, 'products');
    expect(data).toEqual([]);
  });

  it('stock_lots query returns [] for a user with no stock', async () => {
    const result = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('lot_id,product_id,qty_containers,expires_on,locations:location_id(name)')
      .eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'stock_lots');
    expect(data).toEqual([]);
  });

  it('first location query still returns the auto-provisioned Fridge for a fresh user', async () => {
    // The activation trigger seeds default locations; the empty-product
    // case must NOT zero this out — InventoryPage uses the first location
    // as the default for new lots, and a missing location would crash the
    // add-stock flow.
    const result = await chefbyte(ctx.client)
      .from('locations')
      .select('location_id,name')
      .eq('user_id', ctx.userId)
      .order('created_at')
      .limit(1);

    const data = assertQuerySucceeds(result, 'first location');
    expect(data).toHaveLength(1);
    expect(typeof data[0].location_id).toBe('string');
    expect(data[0].name).toBe('Fridge');
  });

  it('grouped view aggregation produces [] when both products and stock_lots are empty', async () => {
    const { data: prods } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id,user_id,name,barcode,servings_per_container,min_stock_amount')
      .eq('user_id', ctx.userId)
      .order('name');
    const { data: stockLots } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('lot_id,product_id,qty_containers,expires_on,locations:location_id(name)')
      .eq('user_id', ctx.userId);

    expect(prods).toEqual([]);
    expect(stockLots).toEqual([]);

    // Replicate page-side aggregation
    const lotsByProduct = new Map<string, any[]>();
    for (const lot of stockLots!) {
      const existing = lotsByProduct.get(lot.product_id) ?? [];
      existing.push(lot);
      lotsByProduct.set(lot.product_id, existing);
    }
    const grouped = prods!.map((product: any) => {
      const productLots = lotsByProduct.get(product.product_id) ?? [];
      const totalStock = productLots.reduce((sum: number, l: any) => sum + Number(l.qty_containers), 0);
      return { product, totalStock, lotCount: productLots.length };
    });
    const filteredGrouped = grouped.filter((g: any) => g.totalStock > 0);

    expect(grouped).toEqual([]);
    expect(filteredGrouped).toEqual([]);
  });
});
