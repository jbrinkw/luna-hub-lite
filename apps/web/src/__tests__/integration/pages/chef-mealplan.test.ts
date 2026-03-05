import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPageTestContext,
  chefbyte,
  seedProducts,
  seedRecipe,
  getDefaultLocation,
  seedStock,
  assertQuerySucceeds,
  todayDate,
  type PageTestContext,
} from './helpers';

/* ================================================================== */
/*  chef-mealplan page query integration tests                         */
/*                                                                     */
/*  Validates the EXACT Supabase queries used in MealPlanPage.tsx      */
/*  against a real local Supabase database.                            */
/* ================================================================== */

let ctx: PageTestContext;
let productMap: Record<string, string>;
let recipeId: string;
let locationId: string;

/** Helper: get Monday of the current week as YYYY-MM-DD */
function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  ctx = await createPageTestContext('chef-mealplan');
  productMap = await seedProducts(ctx);
  locationId = await getDefaultLocation(ctx);
  await seedStock(ctx, productMap, locationId);
  recipeId = await seedRecipe(ctx, productMap);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe('ChefByte MealPlanPage queries', () => {
  /* ---------------------------------------------------------------- */
  /*  Meal plan list query — exact from MealPlanPage.tsx loadMeals()   */
  /*  line 109-115                                                     */
  /* ---------------------------------------------------------------- */
  it('meal plan query with recipe + product joins and date range filter', async () => {
    const today = todayDate();
    const monday = getMonday(new Date());
    const startDate = toDateStr(monday);
    const endDate = toDateStr(new Date(monday.getTime() + 6 * 86400000));

    // Seed a meal plan entry for today
    const { data: meal, error: mealErr } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .insert({
        user_id: ctx.userId,
        recipe_id: recipeId,
        product_id: null,
        logical_date: today,
        servings: 2,
        meal_prep: false,
      })
      .select('meal_id')
      .single();
    expect(mealErr).toBeNull();
    expect(meal).not.toBeNull();
    expect(typeof meal!.meal_id).toBe('string');

    // Exact query from MealPlanPage.tsx loadMeals()
    const result = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select('*, recipes:recipe_id(name), products:product_id(name)')
      .eq('user_id', ctx.userId)
      .gte('logical_date', startDate)
      .lte('logical_date', endDate)
      .order('created_at');

    const meals = assertQuerySucceeds(result, 'meal plan list');
    expect(Array.isArray(meals)).toBe(true);
    expect(meals.length).toBeGreaterThanOrEqual(1);

    // Find our seeded entry
    const entry = meals.find((m: any) => m.meal_id === meal!.meal_id);
    expect(entry).toBeDefined();

    // Verify exact field values
    expect(entry.meal_id).toBe(meal!.meal_id);
    expect(entry.user_id).toBe(ctx.userId);
    expect(entry.recipe_id).toBe(recipeId);
    expect(entry.product_id).toBeNull();
    expect(entry.logical_date).toBe(today);
    expect(Number(entry.servings)).toBe(2);
    expect(entry.meal_prep).toBe(false);
    expect(entry.completed_at).toBeNull();
    expect(typeof entry.created_at).toBe('string');

    // Verify recipe join (recipe_id aliased as "recipes")
    expect(entry.recipes).not.toBeNull();
    expect(entry.recipes.name).toBe('Chicken & Rice');

    // Product join is null since this entry has recipe_id
    expect(entry.products).toBeNull();

    expect(entry.logical_date).toBe(today);
    expect(Number(entry.servings)).toBe(2);
    expect(entry.meal_prep).toBe(false);
    expect(entry.completed_at).toBeNull();

    // Cleanup
    await chefbyte(ctx.client).from('meal_plan_entries').delete().eq('meal_id', meal!.meal_id);
  });

  /* ---------------------------------------------------------------- */
  /*  Product-based meal entry                                         */
  /* ---------------------------------------------------------------- */
  it('product-based meal entry returns product join correctly', async () => {
    const today = todayDate();

    // Add a meal entry referencing a product instead of a recipe
    const { data: meal, error: mealErr } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .insert({
        user_id: ctx.userId,
        recipe_id: null,
        product_id: productMap['Protein Powder'],
        logical_date: today,
        servings: 1,
        meal_prep: false,
      })
      .select('meal_id')
      .single();
    expect(mealErr).toBeNull();

    const monday = getMonday(new Date());
    const startDate = toDateStr(monday);
    const endDate = toDateStr(new Date(monday.getTime() + 6 * 86400000));

    // Exact query from MealPlanPage.tsx loadMeals()
    const result = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select('*, recipes:recipe_id(name), products:product_id(name)')
      .eq('user_id', ctx.userId)
      .gte('logical_date', startDate)
      .lte('logical_date', endDate)
      .order('created_at');

    const meals = assertQuerySucceeds(result, 'product meal entry');
    const entry = meals.find((m: any) => m.meal_id === meal!.meal_id);
    expect(entry).toBeDefined();

    // Recipe join is null, product join has name
    expect(entry.recipes).toBeNull();
    expect(entry.products).not.toBeNull();
    expect(entry.products.name).toBe('Protein Powder');

    // Cleanup
    await chefbyte(ctx.client).from('meal_plan_entries').delete().eq('meal_id', meal!.meal_id);
  });

  /* ---------------------------------------------------------------- */
  /*  Add meal entry — exact from MealPlanPage.tsx addMeal()           */
  /*  line 265-272                                                     */
  /* ---------------------------------------------------------------- */
  it('inserts a new meal plan entry (recipe type)', async () => {
    const today = todayDate();

    // Exact insert query from MealPlanPage.tsx addMeal()
    const result = await chefbyte(ctx.client).from('meal_plan_entries').insert({
      user_id: ctx.userId,
      recipe_id: recipeId,
      product_id: null,
      logical_date: today,
      servings: 1,
      meal_prep: false,
    });
    expect(result.error).toBeNull();

    // Verify it exists
    const { data: verify } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select('*')
      .eq('user_id', ctx.userId)
      .eq('recipe_id', recipeId)
      .eq('logical_date', today)
      .eq('meal_prep', false);

    expect(verify).not.toBeNull();
    expect(verify!.length).toBe(1);

    // Cleanup
    for (const m of verify!) {
      await chefbyte(ctx.client)
        .from('meal_plan_entries')
        .delete()
        .eq('meal_id', (m as any).meal_id);
    }
  });

  it('inserts a new meal plan entry (product type, meal prep)', async () => {
    const today = todayDate();

    // Exact insert query from MealPlanPage.tsx addMeal() with product and meal_prep=true
    const result = await chefbyte(ctx.client).from('meal_plan_entries').insert({
      user_id: ctx.userId,
      recipe_id: null,
      product_id: productMap['Eggs'],
      logical_date: today,
      servings: 3,
      meal_prep: true,
    });
    expect(result.error).toBeNull();

    // Verify
    const { data: verify } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select('meal_id, servings, meal_prep')
      .eq('user_id', ctx.userId)
      .eq('product_id', productMap['Eggs'])
      .eq('logical_date', today)
      .eq('meal_prep', true);
    expect(verify).not.toBeNull();
    expect(verify!.length).toBe(1);
    expect(Number(verify![0].servings)).toBe(3);
    expect(verify![0].meal_prep).toBe(true);

    // Cleanup
    for (const m of verify!) {
      await chefbyte(ctx.client)
        .from('meal_plan_entries')
        .delete()
        .eq('meal_id', (m as any).meal_id);
    }
  });

  /* ---------------------------------------------------------------- */
  /*  Mark meal done — exact from MealPlanPage.tsx markDone()          */
  /*  line 182-184                                                     */
  /* ---------------------------------------------------------------- */
  it('marks a meal as done via RPC', async () => {
    const today = todayDate();

    // Create a meal entry
    const { data: meal } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .insert({
        user_id: ctx.userId,
        recipe_id: recipeId,
        product_id: null,
        logical_date: today,
        servings: 1,
        meal_prep: false,
      })
      .select('meal_id')
      .single();
    expect(meal).not.toBeNull();
    expect(typeof meal!.meal_id).toBe('string');

    // Exact RPC call from MealPlanPage.tsx markDone()
    const { data: result, error: rpcErr } = await (chefbyte(ctx.client) as any).rpc('mark_meal_done', {
      p_meal_id: meal!.meal_id,
    });
    expect(rpcErr).toBeNull();
    expect(result).not.toBeNull();
    expect(result.success).toBe(true);
    expect(typeof result.completed_at).toBe('string');

    // Verify completed_at is set
    const { data: verify } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select('completed_at')
      .eq('meal_id', meal!.meal_id)
      .single();
    expect(verify).not.toBeNull();
    expect(typeof verify!.completed_at).toBe('string');

    // Cleanup: meal entry stays but food_logs were created
    await chefbyte(ctx.client).from('food_logs').delete().eq('user_id', ctx.userId);
    await chefbyte(ctx.client).from('meal_plan_entries').delete().eq('meal_id', meal!.meal_id);
  });

  /* ---------------------------------------------------------------- */
  /*  Unmark meal done — exact from MealPlanPage.tsx unmarkDone()      */
  /*  line ~270                                                        */
  /* ---------------------------------------------------------------- */
  it('unmarks a done meal via RPC (reverses completion)', async () => {
    const today = todayDate();

    // Create and mark done
    const { data: meal } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .insert({
        user_id: ctx.userId,
        recipe_id: recipeId,
        product_id: null,
        logical_date: today,
        servings: 1,
        meal_prep: false,
      })
      .select('meal_id')
      .single();
    expect(meal).not.toBeNull();

    const { data: markResult } = await (chefbyte(ctx.client) as any).rpc('mark_meal_done', {
      p_meal_id: meal!.meal_id,
    });
    expect(markResult.success).toBe(true);

    // Verify completed
    const { data: before } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select('completed_at')
      .eq('meal_id', meal!.meal_id)
      .single();
    expect(before!.completed_at).not.toBeNull();

    // Exact RPC call from MealPlanPage.tsx unmarkDone()
    const { data: undoResult, error: rpcErr } = await (chefbyte(ctx.client) as any).rpc('unmark_meal_done', {
      p_meal_id: meal!.meal_id,
    });
    expect(rpcErr).toBeNull();
    expect(undoResult).not.toBeNull();
    expect(undoResult.success).toBe(true);

    // Verify completed_at is cleared
    const { data: after } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select('completed_at')
      .eq('meal_id', meal!.meal_id)
      .single();
    expect(after!.completed_at).toBeNull();

    // Verify food_logs cleaned up
    const { data: logs } = await chefbyte(ctx.client)
      .from('food_logs')
      .select('log_id')
      .eq('user_id', ctx.userId)
      .eq('meal_id', meal!.meal_id);
    expect(logs).toHaveLength(0);

    // Cleanup
    await chefbyte(ctx.client).from('food_logs').delete().eq('user_id', ctx.userId);
    await chefbyte(ctx.client).from('meal_plan_entries').delete().eq('meal_id', meal!.meal_id);
  });

  it('unmark_meal_done on uncompleted meal returns success=false', async () => {
    const today = todayDate();

    const { data: meal } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .insert({
        user_id: ctx.userId,
        recipe_id: recipeId,
        product_id: null,
        logical_date: today,
        servings: 1,
        meal_prep: false,
      })
      .select('meal_id')
      .single();
    expect(meal).not.toBeNull();

    // Try to unmark a meal that was never marked done
    const { data: result, error: rpcErr } = await (chefbyte(ctx.client) as any).rpc('unmark_meal_done', {
      p_meal_id: meal!.meal_id,
    });
    expect(rpcErr).toBeNull();
    expect(result.success).toBe(false);
    expect(result.error).toBe('Meal is not completed');

    // Cleanup
    await chefbyte(ctx.client).from('meal_plan_entries').delete().eq('meal_id', meal!.meal_id);
  });

  /* ---------------------------------------------------------------- */
  /*  Delete meal — exact from MealPlanPage.tsx deleteMeal()           */
  /*  line 188                                                         */
  /* ---------------------------------------------------------------- */
  it('deletes a meal plan entry', async () => {
    const today = todayDate();

    const { data: meal } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .insert({
        user_id: ctx.userId,
        recipe_id: recipeId,
        product_id: null,
        logical_date: today,
        servings: 1,
        meal_prep: false,
      })
      .select('meal_id')
      .single();
    expect(meal).not.toBeNull();
    expect(typeof meal!.meal_id).toBe('string');

    // Exact delete query from MealPlanPage.tsx deleteMeal()
    const delResult = await chefbyte(ctx.client).from('meal_plan_entries').delete().eq('meal_id', meal!.meal_id);
    expect(delResult.error).toBeNull();

    // Verify deleted
    const { data: verify } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select('meal_id')
      .eq('meal_id', meal!.meal_id);
    expect(verify).toHaveLength(0);
  });

  /* ---------------------------------------------------------------- */
  /*  Date range filtering excludes entries outside the week           */
  /* ---------------------------------------------------------------- */
  it('date range filter excludes meals from other weeks', async () => {
    const monday = getMonday(new Date());
    const startDate = toDateStr(monday);
    const endDate = toDateStr(new Date(monday.getTime() + 6 * 86400000));

    // Insert entry for last week
    const lastWeekDate = toDateStr(new Date(monday.getTime() - 3 * 86400000));
    const { data: oldMeal } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .insert({
        user_id: ctx.userId,
        recipe_id: recipeId,
        product_id: null,
        logical_date: lastWeekDate,
        servings: 1,
        meal_prep: false,
      })
      .select('meal_id')
      .single();
    expect(oldMeal).not.toBeNull();
    expect(typeof oldMeal!.meal_id).toBe('string');

    // Insert entry for this week
    const thisWeekDate = toDateStr(new Date(monday.getTime() + 2 * 86400000));
    const { data: currentMeal } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .insert({
        user_id: ctx.userId,
        recipe_id: recipeId,
        product_id: null,
        logical_date: thisWeekDate,
        servings: 1,
        meal_prep: false,
      })
      .select('meal_id')
      .single();
    expect(currentMeal).not.toBeNull();
    expect(typeof currentMeal!.meal_id).toBe('string');

    // Exact query from MealPlanPage.tsx loadMeals()
    const result = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select('*, recipes:recipe_id(name), products:product_id(name)')
      .eq('user_id', ctx.userId)
      .gte('logical_date', startDate)
      .lte('logical_date', endDate)
      .order('created_at');

    const meals = assertQuerySucceeds(result, 'date range filter');

    // Current week entry should be present
    const found = meals.find((m: any) => m.meal_id === currentMeal!.meal_id);
    expect(found).toBeDefined();
    expect(found.logical_date).toBe(thisWeekDate);

    // Last week entry should NOT be present
    const excluded = meals.find((m: any) => m.meal_id === oldMeal!.meal_id);
    expect(excluded).toBeUndefined();

    // Cleanup
    await chefbyte(ctx.client).from('meal_plan_entries').delete().eq('meal_id', oldMeal!.meal_id);
    await chefbyte(ctx.client).from('meal_plan_entries').delete().eq('meal_id', currentMeal!.meal_id);
  });

  /* ---------------------------------------------------------------- */
  /*  Search recipes query — exact from MealPlanPage.tsx searchItems() */
  /*  line 211-215                                                     */
  /* ---------------------------------------------------------------- */
  it('recipe search query for add meal dropdown', async () => {
    // Exact query from MealPlanPage.tsx searchItems()
    const result = await chefbyte(ctx.client)
      .from('recipes')
      .select('recipe_id, name')
      .eq('user_id', ctx.userId)
      .order('name');

    const recipes = assertQuerySucceeds(result, 'recipe search');
    expect(Array.isArray(recipes)).toBe(true);
    expect(recipes.length).toBe(1);

    const seeded = recipes.find((r: any) => r.recipe_id === recipeId);
    expect(seeded).toBeDefined();
    expect(seeded.name).toBe('Chicken & Rice');

    // Only recipe_id and name selected
    expect(Object.keys(seeded).sort()).toEqual(['name', 'recipe_id']);
  });

  /* ---------------------------------------------------------------- */
  /*  Search products query — exact from MealPlanPage.tsx searchItems()*/
  /*  line 217-219                                                     */
  /* ---------------------------------------------------------------- */
  it('product search query for add meal dropdown', async () => {
    // Exact query from MealPlanPage.tsx searchItems()
    const result = await chefbyte(ctx.client)
      .from('products')
      .select('product_id, name')
      .eq('user_id', ctx.userId)
      .order('name');

    const products = assertQuerySucceeds(result, 'product search');
    expect(Array.isArray(products)).toBe(true);
    expect(products.length).toBe(5); // seedProducts creates 5

    // Only product_id and name selected
    const first = products[0];
    expect(Object.keys(first).sort()).toEqual(['name', 'product_id']);

    // Verify ordering
    const names = products.map((p: any) => p.name);
    const sorted = [...names].sort((a: string, b: string) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });
});
