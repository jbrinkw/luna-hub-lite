import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPageTestContext, chefbyte, assertQuerySucceeds, todayDate, type PageTestContext } from './helpers';

/* Empty-fixture sibling for chef-home.test.ts (L9 audit) */

describe('ChefByte HomePage queries — empty fixture', () => {
  let ctx: PageTestContext;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-home-empty');
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('today meal_plan_entries query returns [] when user has no plan', async () => {
    const result = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select('meal_id,product_id,recipe_id,logical_date,completed_at')
      .eq('user_id', ctx.userId)
      .eq('logical_date', todayDate());

    const data = assertQuerySucceeds(result, 'meal_plan_entries');
    expect(data).toEqual([]);
  });

  it('today food_logs query returns [] when user has logged nothing', async () => {
    const result = await chefbyte(ctx.client)
      .from('food_logs')
      .select('log_id,calories,protein,carbs,fat')
      .eq('user_id', ctx.userId)
      .eq('logical_date', todayDate());

    const data = assertQuerySucceeds(result, 'food_logs');
    expect(data).toEqual([]);

    // Aggregating empty list must yield zeros (the page reduces over this)
    const totals = data.reduce(
      (acc: any, row: any) => ({
        calories: acc.calories + Number(row.calories ?? 0),
        protein: acc.protein + Number(row.protein ?? 0),
        carbs: acc.carbs + Number(row.carbs ?? 0),
        fat: acc.fat + Number(row.fat ?? 0),
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 },
    );
    expect(totals).toEqual({ calories: 0, protein: 0, carbs: 0, fat: 0 });
  });

  it('products query returns [] for a user with no products (drives below-min UI)', async () => {
    // HomePage's "Below minimum stock" panel filters products with
    // min_stock_amount > 0 — an empty product list must yield [].
    const { data, error } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id,name,min_stock_amount,servings_per_container')
      .eq('user_id', ctx.userId)
      .gt('min_stock_amount', 0);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
