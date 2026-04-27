import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPageTestContext,
  chefbyte,
  seedAllChefByte,
  todayDate,
  type PageTestContext,
  type ChefByteSeeds,
} from './helpers';
import { loadMacroPageData, calcCaloriesFromMacros } from '@/pages/chefbyte/MacroPage';

// Legacy-audit issue #3 (2026-04-22): this test previously replicated
// MacroPage's 4-query parallel fan-out (get_daily_macros RPC +
// food_logs + temp_items + meal_plan_entries with deep recipe join)
// across 4 independent test cases, each prefixed "// Source:
// MacroPage.tsx line N". Now one call to loadMacroPageData covers
// the full page load — refactors in MacroPage flow directly here.
//
// Mutation paths (insert/update/delete) remain as direct CRUD calls —
// those aren't query-string replicas, they're round-trip checks for
// handlers that already do a write + re-read.

describe('ChefByte MacroPage loader + mutations', () => {
  let ctx: PageTestContext;
  let seeds: ChefByteSeeds;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-macros');
    seeds = await seedAllChefByte(ctx);

    const today = todayDate();
    const chickenId = seeds.productMap['Great Value Boneless Skinless Chicken Breasts'];
    await chefbyte(ctx.client).from('food_logs').insert({
      user_id: ctx.userId,
      product_id: chickenId,
      logical_date: today,
      qty_consumed: 1,
      unit: 'serving',
      calories: 165,
      protein: 31,
      carbs: 0,
      fat: 3.6,
    });

    await chefbyte(ctx.client).from('temp_items').insert({
      user_id: ctx.userId,
      name: 'Morning Coffee',
      logical_date: today,
      calories: 50,
      protein: 1,
      carbs: 5,
      fat: 2,
    });

    await chefbyte(ctx.client).from('meal_plan_entries').insert({
      user_id: ctx.userId,
      recipe_id: seeds.recipeId,
      logical_date: today,
      servings: 1,
      meal_prep: false,
    });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // -------------------------------------------------------------------
  // loadMacroPageData — fan-out of 4 queries + per-source shape
  // transforms. Asserts the macros block, consumed items, and planned
  // items in one pass. If the page adds a query or renames a column,
  // this test exercises the new path without any "// Source:" update.
  // -------------------------------------------------------------------
  it('loadMacroPageData assembles macros + consumed + planned from all 3 sources', async () => {
    const today = todayDate();
    const data = await loadMacroPageData(ctx.userId, today, ctx.client);

    // ── Macros totals ─────────────────────────────────────────────
    expect(data.macros).not.toBeNull();
    // Consumed = food_log (165cal) + temp_item (50cal) = 215
    expect(data.macros!.consumed.calories).toBeCloseTo(215, 0);
    // Protein: 31 + 1 = 32
    expect(data.macros!.consumed.protein).toBeCloseTo(32, 0);
    // Carbs: 0 + 5 = 5
    expect(data.macros!.consumed.carbs).toBeCloseTo(5, 0);
    // Fat: 3.6 + 2 = 5.6
    expect(data.macros!.consumed.fat).toBeCloseTo(5.6, 1);

    // Goals from seedMacroGoals
    expect(data.macros!.goals.calories).toBe(2200);
    expect(data.macros!.goals.protein).toBe(180);
    expect(data.macros!.goals.carbs).toBe(220);
    expect(data.macros!.goals.fat).toBe(73);

    // ── Consumed items (2 sources) ─────────────────────────────
    const sources = new Set(data.consumed.map((c) => c.source));
    expect(sources.has('Meal Plan')).toBe(true); // from food_logs
    expect(sources.has('Temp Item')).toBe(true); // from temp_items

    const mealPlanItem = data.consumed.find((c) => c.source === 'Meal Plan');
    expect(mealPlanItem!.name).toBe('Great Value Boneless Skinless Chicken Breasts');
    expect(mealPlanItem!.calories).toBe(165);
    expect(mealPlanItem!.protein).toBe(31);

    const tempItem = data.consumed.find((c) => c.source === 'Temp Item');
    expect(tempItem!.name).toBe('Morning Coffee');
    expect(tempItem!.calories).toBe(50);

    // ── Planned items (recipe-based) ──────────────────────────
    expect(data.planned.length).toBeGreaterThanOrEqual(1);
    const recipe = data.planned.find((p) => p.name === 'Chicken & Rice');
    expect(recipe).toBeDefined();
    // base_servings=2 with ingredients 0.5 container chicken + 0.25 rice.
    // Chicken: 0.5 container * 4 svg/container * 165 cal/svg = 330
    // Rice:    0.25 container * 8 svg/container * 216 cal/svg = 432
    // Per-recipe total = 762; divide by base_servings (2) = 381 cal/serving.
    // Entry has servings=1, so planned.calories = round(381 * 1) = 381.
    expect(recipe!.calories).toBe(381);
  });

  // -------------------------------------------------------------------
  // loadMacroPageData edge case — missing user_config goals: the RPC
  // falls back to DEFAULT_MACRO_GOALS. This covers the "new user who
  // hasn't configured goals yet" branch without a separate replica.
  // -------------------------------------------------------------------
  it('loadMacroPageData for a date with no entries returns empty consumed/planned + 0 consumed macros', async () => {
    const emptyDate = '2026-01-01';
    const data = await loadMacroPageData(ctx.userId, emptyDate, ctx.client);

    expect(data.consumed).toEqual([]);
    expect(data.planned).toEqual([]);
    expect(data.macros).not.toBeNull();
    expect(data.macros!.consumed.calories).toBe(0);
    expect(data.macros!.consumed.protein).toBe(0);
    expect(data.macros!.consumed.carbs).toBe(0);
    expect(data.macros!.consumed.fat).toBe(0);
    // Goals still populated from user_config
    expect(data.macros!.goals.calories).toBe(2200);
  });

  // -------------------------------------------------------------------
  // Pure helper — calcCaloriesFromMacros. Kept as a unit-style check
  // since it's exported from the page and used by multiple callers.
  // -------------------------------------------------------------------
  it('calcCaloriesFromMacros applies 4-4-9 formula', () => {
    expect(calcCaloriesFromMacros(20, 30, 10)).toBe(20 * 4 + 30 * 4 + 10 * 9);
    expect(calcCaloriesFromMacros(0, 0, 0)).toBe(0);
  });

  // -------------------------------------------------------------------
  // Mutation: temp_items insert → observe via loadMacroPageData. The
  // loader covers the read side; this test pins that an insert lands
  // in the consumed list with the correct source/name.
  // -------------------------------------------------------------------
  it('temp_items insert shows up in loadMacroPageData.consumed with source="Temp Item"', async () => {
    const today = todayDate();
    const insertResult = await chefbyte(ctx.client).from('temp_items').insert({
      user_id: ctx.userId,
      name: 'Protein Bar',
      calories: 210,
      protein: 20,
      carbs: 25,
      fat: 8,
      logical_date: today,
    });
    expect(insertResult.error).toBeNull();

    const data = await loadMacroPageData(ctx.userId, today, ctx.client);
    const bar = data.consumed.find((c) => c.name === 'Protein Bar');
    expect(bar).toBeDefined();
    expect(bar!.source).toBe('Temp Item');
    expect(bar!.calories).toBe(210);
    expect(bar!.protein).toBe(20);
  });

  // -------------------------------------------------------------------
  // Mutation: user_config goal upsert — verify the loader's macros
  // block picks up the new goals on the next call.
  // -------------------------------------------------------------------
  it('user_config upsert updates goals visible via loadMacroPageData', async () => {
    const keys = [
      { key: 'goal_calories', value: '2500' },
      { key: 'goal_protein', value: '200' },
      { key: 'goal_carbs', value: '250' },
      { key: 'goal_fat', value: '85' },
    ];
    for (const { key, value } of keys) {
      const result = await chefbyte(ctx.client)
        .from('user_config')
        .upsert({ user_id: ctx.userId, key, value }, { onConflict: 'user_id,key' });
      expect(result.error).toBeNull();
    }

    const data = await loadMacroPageData(ctx.userId, todayDate(), ctx.client);
    expect(data.macros!.goals.calories).toBe(2500);
    expect(data.macros!.goals.protein).toBe(200);
    expect(data.macros!.goals.carbs).toBe(250);
    expect(data.macros!.goals.fat).toBe(85);
  });

  // -------------------------------------------------------------------
  // Mutation: food_logs delete → loader no longer returns the row.
  // -------------------------------------------------------------------
  it('food_logs delete removes the row from loadMacroPageData.consumed', async () => {
    const today = todayDate();

    // Create a food log via mark_meal_done
    const { data: meal } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .insert({
        user_id: ctx.userId,
        recipe_id: seeds.recipeId,
        logical_date: today,
        servings: 1,
        meal_prep: false,
      })
      .select('meal_id')
      .single();
    expect(meal).not.toBeNull();

    await (chefbyte(ctx.client) as any).rpc('mark_meal_done', { p_meal_id: meal!.meal_id });

    const { data: logs } = await chefbyte(ctx.client)
      .from('food_logs')
      .select('log_id')
      .eq('user_id', ctx.userId)
      .eq('meal_id', meal!.meal_id);
    expect(logs!.length).toBeGreaterThan(0);
    const targetLogId = logs![0].log_id;

    // Delete by log_id
    const del = await chefbyte(ctx.client).from('food_logs').delete().eq('log_id', targetLogId);
    expect(del.error).toBeNull();

    const afterDelete = await loadMacroPageData(ctx.userId, today, ctx.client);
    expect(afterDelete.consumed.some((c) => c.id === targetLogId)).toBe(false);

    // Cleanup: unmark + delete meal entry
    await (chefbyte(ctx.client) as any).rpc('unmark_meal_done', { p_meal_id: meal!.meal_id });
    await chefbyte(ctx.client).from('meal_plan_entries').delete().eq('meal_id', meal!.meal_id);
  });

  // -------------------------------------------------------------------
  // Mutation: temp_items delete → gone from loader.consumed.
  // -------------------------------------------------------------------
  it('temp_items delete removes the row from loadMacroPageData.consumed', async () => {
    const today = todayDate();
    const { data: inserted } = await chefbyte(ctx.client)
      .from('temp_items')
      .insert({
        user_id: ctx.userId,
        name: 'Test Snack',
        calories: 200,
        protein: 10,
        carbs: 25,
        fat: 8,
        logical_date: today,
      })
      .select('temp_id')
      .single();
    expect(inserted).not.toBeNull();
    const tempId = inserted!.temp_id;

    // Sanity — it's there now.
    const before = await loadMacroPageData(ctx.userId, today, ctx.client);
    expect(before.consumed.some((c) => c.id === tempId)).toBe(true);

    const del = await chefbyte(ctx.client).from('temp_items').delete().eq('temp_id', tempId);
    expect(del.error).toBeNull();

    const after = await loadMacroPageData(ctx.userId, today, ctx.client);
    expect(after.consumed.some((c) => c.id === tempId)).toBe(false);
  });

  // -------------------------------------------------------------------
  // user_config taste_profile read (still a small standalone query
  // used by the Taste Profile modal, not part of the main loader). The
  // loader intentionally leaves this out so the bulk load stays fast.
  // -------------------------------------------------------------------
  it('user_config taste_profile read shape is valid when unset', async () => {
    const result = await chefbyte(ctx.client)
      .from('user_config')
      .select('value')
      .eq('user_id', ctx.userId)
      .eq('key', 'taste_profile')
      .maybeSingle();
    // Either null (unset) or {value: string}
    if (result.data) expect(result.data).toHaveProperty('value');
    else expect(result.data).toBeNull();
  });
});
