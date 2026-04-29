import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPageTestContext, chefbyte, assertQuerySucceeds, todayDate, type PageTestContext } from './helpers';

/* Empty-fixture sibling for chef-scanner.test.ts (L9 audit) */

describe('ChefByte ScannerPage queries — empty fixture', () => {
  let ctx: PageTestContext;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-scanner-empty');
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('barcode lookup returns no rows for a user with no products', async () => {
    // ScannerPage queries products by barcode to decide between
    // existing-product (4 modes branch) and unknown-product (analyze) flow.
    // Empty must mean "unknown" — never leak another user's product.
    const result = await chefbyte(ctx.client)
      .from('products')
      .select('product_id,name,barcode')
      .eq('user_id', ctx.userId)
      .eq('barcode', '0123456789012');

    const data = assertQuerySucceeds(result, 'barcode lookup');
    expect(data).toEqual([]);
  });

  it('temp_items returns [] for a fresh user with no scan history', async () => {
    const result = await chefbyte(ctx.client)
      .from('temp_items')
      .select('temp_id,name,calories')
      .eq('user_id', ctx.userId)
      .eq('logical_date', todayDate());

    const data = assertQuerySucceeds(result, 'temp_items');
    expect(data).toEqual([]);
  });
});
