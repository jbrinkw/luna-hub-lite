import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPageTestContext, chefbyte, assertQuerySucceeds, todayDate, type PageTestContext } from './helpers';

/* Empty-fixture sibling for chef-mealplan.test.ts (L9 audit) */

describe('ChefByte MealPlanPage queries — empty fixture', () => {
  let ctx: PageTestContext;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-mealplan-empty');
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('meal_plan_entries returns [] across a 7-day window for a fresh user', async () => {
    const today = todayDate();
    const end = new Date();
    end.setDate(end.getDate() + 6);
    const endStr = end.toISOString().split('T')[0];

    const result = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select('meal_id,product_id,recipe_id,logical_date,completed_at')
      .eq('user_id', ctx.userId)
      .gte('logical_date', today)
      .lte('logical_date', endStr);

    const data = assertQuerySucceeds(result, 'meal_plan_entries');
    expect(data).toEqual([]);
  });

  it('grouping by logical_date yields an empty Map for an empty plan', async () => {
    const { data } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select('meal_id,logical_date,product_id')
      .eq('user_id', ctx.userId);

    const byDate = new Map<string, any[]>();
    for (const row of data ?? []) {
      const list = byDate.get(row.logical_date) ?? [];
      list.push(row);
      byDate.set(row.logical_date, list);
    }
    expect(byDate.size).toBe(0);
  });
});
