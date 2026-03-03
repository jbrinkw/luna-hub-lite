import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPageTestContext,
  chefbyte,
  seedAllChefByte,
  assertQuerySucceeds,
  type PageTestContext,
  type ChefByteSeeds,
} from './helpers';

describe('ChefByte WalmartPage queries', () => {
  let ctx: PageTestContext;
  let seeds: ChefByteSeeds;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-walmart');
    seeds = await seedAllChefByte(ctx);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // -----------------------------------------------------------------------
  // Exact query from WalmartPage.tsx line 48-53 (missing walmart links)
  // -----------------------------------------------------------------------
  it('missing walmart links query matches page pattern', async () => {
    const result = await chefbyte(ctx.client)
      .from('products')
      .select('product_id, name, barcode')
      .eq('user_id', ctx.userId)
      .eq('is_placeholder', false)
      .is('walmart_link', null);

    const data = assertQuerySucceeds(result, 'missing walmart links');
    // All seeded products have walmart_link=null (default) and is_placeholder=false
    expect(data.length).toBeGreaterThanOrEqual(5);

    // Verify shape matches MissingLinkProduct (product_id, name, barcode)
    const first = data[0];
    expect(first).toHaveProperty('product_id');
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('barcode');
  });

  // -----------------------------------------------------------------------
  // Exact query from WalmartPage.tsx line 65-70 (missing prices)
  // -----------------------------------------------------------------------
  it('missing prices query matches page pattern', async () => {
    // Initially no products have walmart_link set, so this should return empty
    const result = await chefbyte(ctx.client)
      .from('products')
      .select('product_id, name, walmart_link, price')
      .eq('user_id', ctx.userId)
      .is('price', null)
      .neq('walmart_link', null);

    const data = assertQuerySucceeds(result, 'missing prices');
    expect(data).toHaveLength(0); // No products have walmart_link yet
  });

  // -----------------------------------------------------------------------
  // Exact update from WalmartPage.tsx line 94-97 (markNotOnWalmart)
  // -----------------------------------------------------------------------
  it('markNotOnWalmart update matches page pattern', async () => {
    const productId = seeds.productMap['Bananas'];

    const updateResult = await chefbyte(ctx.client)
      .from('products')
      .update({ walmart_link: 'NOT_ON_WALMART' })
      .eq('product_id', productId);

    expect(updateResult.error).toBeNull();

    // Verify the product now has walmart_link set
    const { data: product } = await chefbyte(ctx.client)
      .from('products')
      .select('walmart_link')
      .eq('product_id', productId)
      .single();

    expect(product!.walmart_link).toBe('NOT_ON_WALMART');

    // Product should NOT appear in missing-links query anymore
    const { data: noLinks } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id')
      .eq('user_id', ctx.userId)
      .eq('is_placeholder', false)
      .is('walmart_link', null);

    const ids = noLinks!.map((p: any) => p.product_id);
    expect(ids).not.toContain(productId);
  });

  // -----------------------------------------------------------------------
  // Set a walmart link, then test missing prices query returns it
  // -----------------------------------------------------------------------
  it('product with walmart_link but no price appears in missing prices', async () => {
    const productId = seeds.productMap['Chicken Breast'];

    // Set walmart_link (but NOT price)
    await chefbyte(ctx.client)
      .from('products')
      .update({ walmart_link: 'https://walmart.com/chicken' })
      .eq('product_id', productId);

    // Now the missing-prices query should return this product
    const result = await chefbyte(ctx.client)
      .from('products')
      .select('product_id, name, walmart_link, price')
      .eq('user_id', ctx.userId)
      .is('price', null)
      .neq('walmart_link', null);

    const data = assertQuerySucceeds(result, 'missing prices after link');
    const chicken = data.find((p: any) => p.product_id === productId);
    expect(chicken).toBeDefined();
    expect(chicken.name).toBe('Chicken Breast');
    expect(chicken.walmart_link).toBe('https://walmart.com/chicken');
    expect(chicken.price).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Exact update from WalmartPage.tsx line 105-108 (savePrice)
  // -----------------------------------------------------------------------
  it('savePrice update matches page pattern', async () => {
    const productId = seeds.productMap['Chicken Breast'];
    const price = 8.99;

    const updateResult = await chefbyte(ctx.client).from('products').update({ price }).eq('product_id', productId);

    expect(updateResult.error).toBeNull();

    // Verify price was saved
    const { data: product } = await chefbyte(ctx.client)
      .from('products')
      .select('price, walmart_link')
      .eq('product_id', productId)
      .single();

    expect(Number(product!.price)).toBeCloseTo(8.99, 2);

    // Product should no longer appear in missing-prices query
    const { data: noPrices } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id')
      .eq('user_id', ctx.userId)
      .is('price', null)
      .neq('walmart_link', null);

    const ids = noPrices!.map((p: any) => p.product_id);
    expect(ids).not.toContain(productId);
  });

  // -----------------------------------------------------------------------
  // Verify the full flow: link -> set price -> neither query returns it
  // -----------------------------------------------------------------------
  it('fully linked and priced product does not appear in either missing query', async () => {
    const productId = seeds.productMap['Brown Rice'];

    // Set walmart_link AND price
    await chefbyte(ctx.client)
      .from('products')
      .update({ walmart_link: 'https://walmart.com/rice', price: 3.49 })
      .eq('product_id', productId);

    // Should NOT appear in missing-links
    const { data: noLinks } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id')
      .eq('user_id', ctx.userId)
      .eq('is_placeholder', false)
      .is('walmart_link', null);

    expect(noLinks!.map((p: any) => p.product_id)).not.toContain(productId);

    // Should NOT appear in missing-prices
    const { data: noPrices } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id')
      .eq('user_id', ctx.userId)
      .is('price', null)
      .neq('walmart_link', null);

    expect(noPrices!.map((p: any) => p.product_id)).not.toContain(productId);
  });
});
