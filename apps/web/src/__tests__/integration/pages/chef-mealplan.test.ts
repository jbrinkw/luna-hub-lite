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
  /*  food_logs query for selected day                                 */
  /*  Exact from MealPlanPage.tsx loadMeals() — consumed items         */
  /*  line 167-172                                                     */
  /* ---------------------------------------------------------------- */
  it('food_logs query for selected day', async () => {
    const today = todayDate();
    const monday = getMonday(new Date());
    const startDate = toDateStr(monday);
    const endDate = toDateStr(new Date(monday.getTime() + 6 * 86400000));

    // Generate a food_log by consuming a product
    const chickenId = productMap['Chicken Breast'];
    await (chefbyte(ctx.client) as any).rpc('consume_product', {
      p_product_id: chickenId,
      p_qty: 1,
      p_unit: 'container',
      p_log_macros: true,
      p_logical_date: today,
    });

    // Exact query from MealPlanPage.tsx loadMeals()
    const result = await chefbyte(ctx.client)
      .from('food_logs')
      .select('log_id, logical_date, qty_consumed, unit, calories, protein, carbs, fat, products:product_id(name)')
      .eq('user_id', ctx.userId)
      .gte('logical_date', startDate)
      .lte('logical_date', endDate);

    const data = assertQuerySucceeds(result, 'food_logs for week');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);

    const entry = data[0] as any;
    expect(typeof entry.log_id).toBe('string');
    expect(entry.logical_date).toBe(today);
    expect(Number(entry.qty_consumed)).toBeGreaterThan(0);
    expect(entry.unit).toBe('container');
    expect(Number(entry.calories)).toBeGreaterThanOrEqual(0);
    expect(Number(entry.protein)).toBeGreaterThanOrEqual(0);
    expect(Number(entry.carbs)).toBeGreaterThanOrEqual(0);
    expect(Number(entry.fat)).toBeGreaterThanOrEqual(0);
    expect(entry.products).not.toBeNull();
    expect(entry.products.name).toBe('Chicken Breast');

    // Cleanup
    await chefbyte(ctx.client).from('food_logs').delete().eq('user_id', ctx.userId);
  });

  /* ---------------------------------------------------------------- */
  /*  temp_items query for selected day                                */
  /*  Exact from MealPlanPage.tsx loadMeals() — temp items             */
  /*  line 175-181                                                     */
  /* ---------------------------------------------------------------- */
  it('temp_items query for selected day', async () => {
    const today = todayDate();
    const monday = getMonday(new Date());
    const startDate = toDateStr(monday);
    const endDate = toDateStr(new Date(monday.getTime() + 6 * 86400000));

    // Insert a temp item
    const insertResult = await chefbyte(ctx.client).from('temp_items').insert({
      user_id: ctx.userId,
      name: 'MealPlan Temp Item',
      logical_date: today,
      calories: 300,
      protein: 20,
      carbs: 40,
      fat: 10,
    });
    expect(insertResult.error).toBeNull();

    // Exact query from MealPlanPage.tsx loadMeals()
    const result = await chefbyte(ctx.client)
      .from('temp_items')
      .select('temp_id, logical_date, name, calories, protein, carbs, fat')
      .eq('user_id', ctx.userId)
      .gte('logical_date', startDate)
      .lte('logical_date', endDate);

    const data = assertQuerySucceeds(result, 'temp_items for week');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);

    const entry = data[0] as any;
    expect(typeof entry.temp_id).toBe('string');
    expect(entry.logical_date).toBe(today);
    expect(entry.name).toBe('MealPlan Temp Item');
    expect(Number(entry.calories)).toBe(300);
    expect(Number(entry.protein)).toBe(20);
    expect(Number(entry.carbs)).toBe(40);
    expect(Number(entry.fat)).toBe(10);

    // Cleanup
    await chefbyte(ctx.client).from('temp_items').delete().eq('temp_id', entry.temp_id);
  });

  /* ---------------------------------------------------------------- */
  /*  Delete food_log from meal plan page (two-click delete)           */
  /*  Exact from MealPlanPage.tsx deleteFoodLog()                      */
  /*  line 370: .from('food_logs').delete().eq('log_id', logId)        */
  /* ---------------------------------------------------------------- */
  it('delete food_log from meal plan page', async () => {
    const today = todayDate();
    const chickenId = productMap['Chicken Breast'];

    // Generate a food_log
    await (chefbyte(ctx.client) as any).rpc('consume_product', {
      p_product_id: chickenId,
      p_qty: 1,
      p_unit: 'container',
      p_log_macros: true,
      p_logical_date: today,
    });

    // Get log_id
    const { data: logs } = await chefbyte(ctx.client)
      .from('food_logs')
      .select('log_id')
      .eq('user_id', ctx.userId)
      .eq('logical_date', today);
    expect(logs).not.toBeNull();
    expect(logs!.length).toBeGreaterThanOrEqual(1);
    const logId = (logs![0] as any).log_id;

    // Exact delete from MealPlanPage.tsx deleteFoodLog()
    const delResult = await chefbyte(ctx.client).from('food_logs').delete().eq('log_id', logId);
    expect(delResult.error).toBeNull();

    // Verify deleted
    const { data: verify } = await chefbyte(ctx.client).from('food_logs').select('log_id').eq('log_id', logId);
    expect(verify).toHaveLength(0);

    // Cleanup remaining
    await chefbyte(ctx.client).from('food_logs').delete().eq('user_id', ctx.userId);
  });

  /* ---------------------------------------------------------------- */
  /*  Delete temp_item from meal plan page (two-click delete)          */
  /*  Exact from MealPlanPage.tsx deleteTempItem()                     */
  /*  line 375: .from('temp_items').delete().eq('temp_id', tempId)     */
  /* ---------------------------------------------------------------- */
  it('delete temp_item from meal plan page', async () => {
    const today = todayDate();

    // Insert a temp item
    const { data: inserted } = await chefbyte(ctx.client)
      .from('temp_items')
      .insert({
        user_id: ctx.userId,
        name: 'Temp to Delete on MealPlan',
        logical_date: today,
        calories: 150,
        protein: 8,
        carbs: 18,
        fat: 5,
      })
      .select('temp_id')
      .single();
    expect(inserted).not.toBeNull();
    const tempId = (inserted as any).temp_id;

    // Exact delete from MealPlanPage.tsx deleteTempItem()
    const delResult = await chefbyte(ctx.client).from('temp_items').delete().eq('temp_id', tempId);
    expect(delResult.error).toBeNull();

    // Verify deleted
    const { data: verify } = await chefbyte(ctx.client).from('temp_items').select('temp_id').eq('temp_id', tempId);
    expect(verify).toHaveLength(0);
  });

  /* ---------------------------------------------------------------- */
  /*  Day total macros aggregation                                     */
  /*  Exact from MealPlanPage.tsx — dayTotals computation              */
  /*  line 503-515: selectedDayMeals.reduce(...)                       */
  /* ---------------------------------------------------------------- */
  it('day total macros aggregation', async () => {
    const today = todayDate();

    // Create two meal entries — one recipe, one product
    const { data: recipeMeal } = await chefbyte(ctx.client)
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
    expect(recipeMeal).not.toBeNull();

    const { data: productMeal } = await chefbyte(ctx.client)
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
    expect(productMeal).not.toBeNull();

    const monday = getMonday(new Date());
    const startDate = toDateStr(monday);
    const endDate = toDateStr(new Date(monday.getTime() + 6 * 86400000));

    // Exact query from MealPlanPage.tsx loadMeals() — with full macro joins
    const result = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select(
        '*, recipes:recipe_id(name, base_servings, recipe_ingredients(quantity, unit, products:product_id(calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))), products:product_id(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving)',
      )
      .eq('user_id', ctx.userId)
      .gte('logical_date', startDate)
      .lte('logical_date', endDate)
      .order('created_at');

    const meals = assertQuerySucceeds(result, 'meals for day totals') as any[];
    const todayMeals = meals.filter((m: any) => m.logical_date === today);
    expect(todayMeals.length).toBe(2);

    // Replicate dayTotals computation from MealPlanPage.tsx
    const dayTotals = todayMeals.reduce(
      (acc: any, meal: any) => {
        // Compute macros per entry
        if (meal.products) {
          const s = Number(meal.servings);
          acc.calories += Math.round(Number(meal.products.calories_per_serving) * s);
          acc.protein += Math.round(Number(meal.products.protein_per_serving) * s);
          acc.carbs += Math.round(Number(meal.products.carbs_per_serving) * s);
          acc.fat += Math.round(Number(meal.products.fat_per_serving) * s);
        } else if (meal.recipes?.recipe_ingredients?.length > 0) {
          const baseServings = Number(meal.recipes.base_servings) || 1;
          let totalCal = 0,
            totalP = 0,
            totalC = 0,
            totalF = 0;
          for (const ri of meal.recipes.recipe_ingredients) {
            if (!ri.products) continue;
            const qty = Number(ri.quantity);
            const spc = Number(ri.products.servings_per_container) || 1;
            const servingsUsed = ri.unit === 'container' ? qty * spc : qty;
            totalCal += Number(ri.products.calories_per_serving) * servingsUsed;
            totalP += Number(ri.products.protein_per_serving) * servingsUsed;
            totalC += Number(ri.products.carbs_per_serving) * servingsUsed;
            totalF += Number(ri.products.fat_per_serving) * servingsUsed;
          }
          const s = Number(meal.servings);
          acc.calories += Math.round((totalCal / baseServings) * s);
          acc.protein += Math.round((totalP / baseServings) * s);
          acc.carbs += Math.round((totalC / baseServings) * s);
          acc.fat += Math.round((totalF / baseServings) * s);
        }
        return acc;
      },
      { calories: 0, protein: 0, carbs: 0, fat: 0 },
    );

    // Verify aggregation produces non-zero values
    expect(dayTotals.calories).toBeGreaterThan(0);
    expect(dayTotals.protein).toBeGreaterThan(0);
    expect(dayTotals.carbs).toBeGreaterThanOrEqual(0);
    expect(dayTotals.fat).toBeGreaterThan(0);

    // Product meal (Protein Powder, 1 serving): 120 cal, 24 protein, 3 carbs, 1.5 fat
    // Recipe meal (Chicken & Rice, 2 servings): computed from ingredients
    // Total should include both
    expect(dayTotals.calories).toBeGreaterThanOrEqual(120); // At least the product meal

    // Cleanup
    await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .delete()
      .eq('meal_id', (recipeMeal as any).meal_id);
    await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .delete()
      .eq('meal_id', (productMeal as any).meal_id);
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

  /* ---------------------------------------------------------------- */
  /*  Toggle meal_prep flag on a meal plan entry                       */
  /*  Exact update from MealPlanPage.tsx toggle handler                */
  /* ---------------------------------------------------------------- */
  it('toggles meal_prep flag on a meal plan entry', async () => {
    const today = todayDate();

    // Insert a non-prep meal
    const { data: meal } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .insert({
        user_id: ctx.userId,
        recipe_id: recipeId,
        logical_date: today,
        servings: 1,
        meal_prep: false,
      })
      .select('meal_id, meal_prep')
      .single();
    expect(meal).not.toBeNull();
    expect(meal!.meal_prep).toBe(false);

    // Toggle meal_prep to true (EXACT pattern from MealPlanPage)
    const updateResult = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .update({ meal_prep: true })
      .eq('meal_id', meal!.meal_id);
    expect(updateResult.error).toBeNull();

    // Verify toggled
    const { data: after } = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select('meal_prep')
      .eq('meal_id', meal!.meal_id)
      .single();
    expect(after!.meal_prep).toBe(true);

    // Cleanup
    await chefbyte(ctx.client).from('meal_plan_entries').delete().eq('meal_id', meal!.meal_id);
  });
});
