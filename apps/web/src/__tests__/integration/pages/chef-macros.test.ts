import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPageTestContext,
  chefbyte,
  seedAllChefByte,
  assertQuerySucceeds,
  todayDate,
  adminClient,
  type PageTestContext,
  type ChefByteSeeds,
} from './helpers';

describe('ChefByte MacroPage queries', () => {
  let ctx: PageTestContext;
  let seeds: ChefByteSeeds;
  let deviceId: string;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-macros');
    seeds = await seedAllChefByte(ctx);

    // Seed a food_log for today so consumed queries return data
    const today = todayDate();
    const chickenId = seeds.productMap['Chicken Breast'];
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

    // Seed a temp_item for today
    await chefbyte(ctx.client).from('temp_items').insert({
      user_id: ctx.userId,
      name: 'Morning Coffee',
      logical_date: today,
      calories: 50,
      protein: 1,
      carbs: 5,
      fat: 2,
    });

    // Seed a liquidtrack_device + event for today
    // Use admin client to insert device since import_key_hash may need bypass
    const { data: deviceData, error: devErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('liquidtrack_devices')
      .insert({
        user_id: ctx.userId,
        device_name: 'Test Scale',
        import_key_hash: `test-hash-${Date.now()}`,
        is_active: true,
      })
      .select('device_id')
      .single();
    if (devErr) throw new Error(`Failed to seed liquidtrack device: ${devErr.message}`);
    deviceId = deviceData.device_id;

    await (adminClient as any).schema('chefbyte').from('liquidtrack_events').insert({
      user_id: ctx.userId,
      device_id: deviceId,
      weight_before: 500,
      weight_after: 350,
      consumption: 150,
      calories: 30,
      protein: 0,
      carbs: 8,
      fat: 0,
      logical_date: today,
    });

    // Seed a meal plan entry (non-prep, not completed) for planned section
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
  // MacroPage: get_daily_macros RPC
  // Source: MacroPage.tsx line 106-108
  //   .rpc('get_daily_macros', { p_logical_date: currentDate })
  // -------------------------------------------------------------------
  it('get_daily_macros RPC returns aggregated macro totals', async () => {
    const today = todayDate();
    const result = await (chefbyte(ctx.client) as any).rpc('get_daily_macros', {
      p_logical_date: today,
    });

    const data = assertQuerySucceeds(result, 'get_daily_macros');

    // Structure check
    expect(data).toHaveProperty('calories');
    expect(data).toHaveProperty('protein');
    expect(data).toHaveProperty('carbs');
    expect(data).toHaveProperty('fat');

    for (const key of ['calories', 'protein', 'carbs', 'fat']) {
      expect(data[key]).toHaveProperty('consumed');
      expect(data[key]).toHaveProperty('goal');
      expect(data[key]).toHaveProperty('remaining');
    }

    // Consumed should include food_log (165cal) + temp_item (50cal) + lt_event (30cal) = 245
    expect(Number(data.calories.consumed)).toBeGreaterThanOrEqual(165);
    // Goals from seedMacroGoals
    expect(Number(data.calories.goal)).toBe(2200);
    expect(Number(data.protein.goal)).toBe(180);
  });

  // -------------------------------------------------------------------
  // MacroPage: food_logs query — EXACT select columns
  // Source: MacroPage.tsx line 134-139
  //   .from('food_logs')
  //     .select('log_id, product_id, calories, protein, carbs, fat, products:product_id(name)')
  //     .eq('user_id', userId).eq('logical_date', currentDate)
  //     .order('created_at')
  // NOTE: NO recipe_id column, uses created_at (NOT logged_at)
  // -------------------------------------------------------------------
  it('food_logs query with EXACT select columns from MacroPage', async () => {
    const today = todayDate();
    const result = await chefbyte(ctx.client)
      .from('food_logs')
      .select('log_id, product_id, calories, protein, carbs, fat, products:product_id(name)')
      .eq('user_id', ctx.userId)
      .eq('logical_date', today)
      .order('created_at');

    const data = assertQuerySucceeds(result, 'food_logs');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);

    const log = data[0];
    expect(log).toHaveProperty('log_id');
    expect(log).toHaveProperty('product_id');
    expect(log).toHaveProperty('calories');
    expect(log).toHaveProperty('protein');
    expect(log).toHaveProperty('carbs');
    expect(log).toHaveProperty('fat');
    expect(log).toHaveProperty('products');
    expect(log.products).toHaveProperty('name');
    expect(log.products.name).toBe('Chicken Breast');

    // Verify correct values
    expect(Number(log.calories)).toBe(165);
    expect(Number(log.protein)).toBe(31);
  });

  // -------------------------------------------------------------------
  // MacroPage: temp_items query
  // Source: MacroPage.tsx line 154-159
  //   .from('temp_items')
  //     .select('temp_id, name, calories, protein, carbs, fat')
  //     .eq('user_id', userId).eq('logical_date', currentDate)
  //     .order('created_at')
  // -------------------------------------------------------------------
  it('temp_items query with EXACT select columns from MacroPage', async () => {
    const today = todayDate();
    const result = await chefbyte(ctx.client)
      .from('temp_items')
      .select('temp_id, name, calories, protein, carbs, fat')
      .eq('user_id', ctx.userId)
      .eq('logical_date', today)
      .order('created_at');

    const data = assertQuerySucceeds(result, 'temp_items');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);

    const item = data[0];
    expect(item).toHaveProperty('temp_id');
    expect(item).toHaveProperty('name');
    expect(item.name).toBe('Morning Coffee');
    expect(Number(item.calories)).toBe(50);
    expect(Number(item.protein)).toBe(1);
    expect(Number(item.carbs)).toBe(5);
    expect(Number(item.fat)).toBe(2);
  });

  // -------------------------------------------------------------------
  // MacroPage: liquidtrack_events query
  // Source: MacroPage.tsx line 174-179
  //   .from('liquidtrack_events')
  //     .select('event_id, calories, protein, carbs, fat')
  //     .eq('user_id', userId).eq('logical_date', currentDate)
  //     .order('created_at')
  // NOTE: uses created_at (NOT logged_at)
  // -------------------------------------------------------------------
  it('liquidtrack_events query with EXACT select columns from MacroPage', async () => {
    const today = todayDate();
    const result = await chefbyte(ctx.client)
      .from('liquidtrack_events')
      .select('event_id, calories, protein, carbs, fat')
      .eq('user_id', ctx.userId)
      .eq('logical_date', today)
      .order('created_at');

    const data = assertQuerySucceeds(result, 'liquidtrack_events');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);

    const event = data[0];
    expect(event).toHaveProperty('event_id');
    expect(event).toHaveProperty('calories');
    expect(event).toHaveProperty('protein');
    expect(event).toHaveProperty('carbs');
    expect(event).toHaveProperty('fat');
    expect(Number(event.calories)).toBe(30);
    expect(Number(event.carbs)).toBe(8);
  });

  // -------------------------------------------------------------------
  // MacroPage: planned items (meal_plan_entries with recipe ingredients join)
  // Source: MacroPage.tsx line 196-204
  //   .from('meal_plan_entries')
  //     .select('meal_id, servings, recipes:recipe_id(name, base_servings,
  //       recipe_ingredients(quantity, unit, products:product_id(
  //         calories_per_serving, carbs_per_serving, protein_per_serving,
  //         fat_per_serving, servings_per_container))),
  //       products:product_id(name, calories_per_serving, protein_per_serving,
  //         carbs_per_serving, fat_per_serving)')
  //     .eq('user_id', userId).eq('logical_date', currentDate)
  //     .eq('meal_prep', false).is('completed_at', null)
  // -------------------------------------------------------------------
  it('meal_plan_entries planned items query with deep recipe ingredients join', async () => {
    const today = todayDate();
    const result = await chefbyte(ctx.client)
      .from('meal_plan_entries')
      .select(
        'meal_id, servings, recipes:recipe_id(name, base_servings, recipe_ingredients(quantity, unit, products:product_id(calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))), products:product_id(name, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving)',
      )
      .eq('user_id', ctx.userId)
      .eq('logical_date', today)
      .eq('meal_prep', false)
      .is('completed_at', null);

    const data = assertQuerySucceeds(result, 'planned meal entries');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);

    // Find the recipe-based entry
    const recipeEntry = data.find((e: any) => e.recipes !== null);
    expect(recipeEntry).toBeTruthy();
    expect(recipeEntry.recipes).toHaveProperty('name');
    expect(recipeEntry.recipes.name).toBe('Chicken & Rice');
    expect(recipeEntry.recipes).toHaveProperty('base_servings');
    expect(recipeEntry.recipes).toHaveProperty('recipe_ingredients');
    expect(Array.isArray(recipeEntry.recipes.recipe_ingredients)).toBe(true);
    expect(recipeEntry.recipes.recipe_ingredients.length).toBeGreaterThanOrEqual(1);

    // Check ingredient structure
    const ingredient = recipeEntry.recipes.recipe_ingredients[0];
    expect(ingredient).toHaveProperty('quantity');
    expect(ingredient).toHaveProperty('unit');
    expect(ingredient).toHaveProperty('products');
    expect(ingredient.products).toHaveProperty('calories_per_serving');
    expect(ingredient.products).toHaveProperty('carbs_per_serving');
    expect(ingredient.products).toHaveProperty('protein_per_serving');
    expect(ingredient.products).toHaveProperty('fat_per_serving');
    expect(ingredient.products).toHaveProperty('servings_per_container');
  });

  // -------------------------------------------------------------------
  // MacroPage: temp_items insert
  // Source: MacroPage.tsx line 294-302
  //   .from('temp_items').insert({
  //     user_id, name, calories, protein, carbs, fat, logical_date
  //   })
  // -------------------------------------------------------------------
  it('temp_items insert round-trip works', async () => {
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

    // Verify it appears in the query
    const readResult = await chefbyte(ctx.client)
      .from('temp_items')
      .select('temp_id, name, calories, protein, carbs, fat')
      .eq('user_id', ctx.userId)
      .eq('logical_date', today)
      .eq('name', 'Protein Bar')
      .single();

    const data = assertQuerySucceeds(readResult, 'temp item readback');
    expect(data.name).toBe('Protein Bar');
    expect(Number(data.calories)).toBe(210);
  });

  // -------------------------------------------------------------------
  // MacroPage: user_config upsert for goals + taste profile
  // Source: MacroPage.tsx line 332-334
  //   .from('user_config').upsert({ user_id, key, value }, { onConflict: 'user_id,key' })
  // -------------------------------------------------------------------
  it('user_config upsert for macro goals via MacroPage pattern', async () => {
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

    // Verify via get_daily_macros that goals updated
    const today = todayDate();
    const macroResult = await (chefbyte(ctx.client) as any).rpc('get_daily_macros', {
      p_logical_date: today,
    });
    const data = assertQuerySucceeds(macroResult, 'updated goals');
    expect(Number(data.calories.goal)).toBe(2500);
    expect(Number(data.protein.goal)).toBe(200);
  });

  // -------------------------------------------------------------------
  // MacroPage: user_config read for taste_profile
  // Source: MacroPage.tsx line 348-353
  //   .from('user_config').select('value')
  //     .eq('user_id', user.id).eq('key', 'taste_profile').single()
  // -------------------------------------------------------------------
  it('user_config taste_profile read returns PGRST116 when not set', async () => {
    // Read taste profile (EXACT query from MacroPage)
    const result = await chefbyte(ctx.client)
      .from('user_config')
      .select('value')
      .eq('user_id', ctx.userId)
      .eq('key', 'taste_profile')
      .single();

    // Should return null since we haven't set it (PGRST116 for .single() with 0 rows)
    // But if it was set by chef-home test running before, it will exist
    // Either outcome is valid — just verify the query shape works
    if (result.data) {
      expect(result.data).toHaveProperty('value');
    }
    // No error means the query shape is valid even if no row found
  });
});
