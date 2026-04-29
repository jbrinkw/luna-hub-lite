import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPageTestContext, chefbyte, assertQuerySucceeds, todayDate, type PageTestContext } from './helpers';

/* Empty-fixture sibling for chef-macros.test.ts (L9 audit) */

describe('ChefByte MacrosPage queries — empty fixture', () => {
  let ctx: PageTestContext;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-macros-empty');
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('food_logs for today returns [] for a user with no consumed entries', async () => {
    const result = await chefbyte(ctx.client)
      .from('food_logs')
      .select('log_id,calories,protein,carbs,fat,logical_date')
      .eq('user_id', ctx.userId)
      .eq('logical_date', todayDate());

    const data = assertQuerySucceeds(result, 'food_logs');
    expect(data).toEqual([]);
  });

  it('temp_items for today returns [] for a fresh user', async () => {
    const result = await chefbyte(ctx.client)
      .from('temp_items')
      .select('temp_id,name,calories,protein,carbs,fat')
      .eq('user_id', ctx.userId)
      .eq('logical_date', todayDate());

    const data = assertQuerySucceeds(result, 'temp_items');
    expect(data).toEqual([]);
  });

  it('macro totals reduce to zero for empty food_logs + temp_items', async () => {
    const { data: logs } = await chefbyte(ctx.client)
      .from('food_logs')
      .select('calories,protein,carbs,fat')
      .eq('user_id', ctx.userId)
      .eq('logical_date', todayDate());
    const { data: temps } = await chefbyte(ctx.client)
      .from('temp_items')
      .select('calories,protein,carbs,fat')
      .eq('user_id', ctx.userId)
      .eq('logical_date', todayDate());

    const totals = [...(logs ?? []), ...(temps ?? [])].reduce(
      (acc: any, r: any) => ({
        calories: acc.calories + Number(r.calories ?? 0),
        protein: acc.protein + Number(r.protein ?? 0),
        carbs: acc.carbs + Number(r.carbs ?? 0),
        fat: acc.fat + Number(r.fat ?? 0),
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 },
    );
    expect(totals).toEqual({ calories: 0, protein: 0, carbs: 0, fat: 0 });
  });
});
