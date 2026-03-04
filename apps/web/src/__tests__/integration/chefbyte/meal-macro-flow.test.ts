import { describe, it, expect, afterEach } from 'vitest';
import { createTestUser, cleanupUser } from '../../test-helpers';

let userIds: string[] = [];

afterEach(async () => {
  for (const id of userIds) {
    await cleanupUser(id);
  }
  userIds = [];
});

/**
 * Helper: set up a full ChefByte meal scenario.
 *
 * Creates:
 * - A location (Fridge — seeded by activate_app)
 * - Two products: Chicken (4 spc, 165cal, 31p, 0c, 3.6f) and Rice (8 spc, 216cal, 5p, 45c, 1.8f)
 * - Stock lots: Chicken = 5 containers, Rice = 3 containers
 * - A recipe: "Chicken & Rice" base_servings=2, ingredients: 1 container chicken + 0.5 container rice
 * - A meal plan entry: today, recipe, servings=1, meal_prep=false
 * - Macro goals: 2000 cal / 150g protein / 200g carbs / 65g fat
 *
 * Returns IDs for all created entities.
 */
async function setupMealScenario(client: any, userId: string) {
  const chef = client.schema('chefbyte');
  const hub = client.schema('hub');

  // Activate chefbyte app (seeds default locations: Fridge, Pantry, Freezer)
  const { error: activateError } = await hub.rpc('activate_app', {
    p_app_name: 'chefbyte',
  });
  if (activateError) throw new Error(`activate_app failed: ${activateError.message}`);

  // Get the Fridge location
  const { data: locations, error: locError } = await chef
    .from('locations')
    .select('location_id, name')
    .eq('user_id', userId)
    .eq('name', 'Fridge');
  if (locError) throw new Error(`locations query failed: ${locError.message}`);
  if (!locations || locations.length === 0) throw new Error('No Fridge location found');
  const locationId = locations[0].location_id;

  // Create products
  const { data: chickenData, error: chickenErr } = await chef
    .from('products')
    .insert({
      user_id: userId,
      name: 'Chicken Breast',
      servings_per_container: 4,
      calories_per_serving: 165,
      protein_per_serving: 31,
      carbs_per_serving: 0,
      fat_per_serving: 3.6,
    })
    .select('product_id')
    .single();
  if (chickenErr) throw new Error(`chicken insert failed: ${chickenErr.message}`);
  const chickenId = chickenData!.product_id;

  const { data: riceData, error: riceErr } = await chef
    .from('products')
    .insert({
      user_id: userId,
      name: 'Brown Rice',
      servings_per_container: 8,
      calories_per_serving: 216,
      protein_per_serving: 5,
      carbs_per_serving: 45,
      fat_per_serving: 1.8,
    })
    .select('product_id')
    .single();
  if (riceErr) throw new Error(`rice insert failed: ${riceErr.message}`);
  const riceId = riceData!.product_id;

  // Create stock lots
  const { error: chickenStockErr } = await chef.from('stock_lots').insert({
    user_id: userId,
    product_id: chickenId,
    location_id: locationId,
    qty_containers: 5,
  });
  if (chickenStockErr) throw new Error(`chicken stock failed: ${chickenStockErr.message}`);

  const { error: riceStockErr } = await chef.from('stock_lots').insert({
    user_id: userId,
    product_id: riceId,
    location_id: locationId,
    qty_containers: 3,
  });
  if (riceStockErr) throw new Error(`rice stock failed: ${riceStockErr.message}`);

  // Create recipe
  const { data: recipeData, error: recipeErr } = await chef
    .from('recipes')
    .insert({
      user_id: userId,
      name: 'Chicken & Rice',
      base_servings: 2,
    })
    .select('recipe_id')
    .single();
  if (recipeErr) throw new Error(`recipe insert failed: ${recipeErr.message}`);
  const recipeId = recipeData!.recipe_id;

  // Create recipe ingredients
  const { error: ingErr } = await chef.from('recipe_ingredients').insert([
    {
      user_id: userId,
      recipe_id: recipeId,
      product_id: chickenId,
      quantity: 1,
      unit: 'container',
    },
    {
      user_id: userId,
      recipe_id: recipeId,
      product_id: riceId,
      quantity: 0.5,
      unit: 'container',
    },
  ]);
  if (ingErr) throw new Error(`ingredients insert failed: ${ingErr.message}`);

  // Create meal plan entry (today, regular, servings=1)
  const today = new Date().toISOString().split('T')[0];
  const { data: mealData, error: mealErr } = await chef
    .from('meal_plan_entries')
    .insert({
      user_id: userId,
      recipe_id: recipeId,
      logical_date: today,
      servings: 1,
      meal_prep: false,
    })
    .select('meal_id')
    .single();
  if (mealErr) throw new Error(`meal insert failed: ${mealErr.message}`);
  const mealId = mealData!.meal_id;

  // Set macro goals via user_config
  const goalEntries = [
    { user_id: userId, key: 'goal_calories', value: '2000' },
    { user_id: userId, key: 'goal_protein', value: '150' },
    { user_id: userId, key: 'goal_carbs', value: '200' },
    { user_id: userId, key: 'goal_fat', value: '65' },
  ];
  const { error: configErr } = await chef.from('user_config').insert(goalEntries);
  if (configErr) throw new Error(`user_config insert failed: ${configErr.message}`);

  return { chickenId, riceId, recipeId, mealId, locationId, today };
}

describe('ChefByte meal & macro flow', () => {
  it('mark_meal_done consumes ingredients and logs macros', async () => {
    const { userId, client } = await createTestUser('meal-done');
    userIds.push(userId);

    const { chickenId, riceId, mealId } = await setupMealScenario(client, userId);
    const chef = client.schema('chefbyte') as any;

    // Mark meal as done
    const { data: result, error: markError } = await chef.rpc('mark_meal_done', {
      p_meal_id: mealId,
    });
    expect(markError).toBeNull();
    expect(result).not.toBeNull();
    expect(result.success).toBe(true);
    expect(typeof result.completed_at).toBe('string');

    // Verify chicken stock: was 5, scale_factor=1/2=0.5, consumed 1*0.5=0.5 container
    const { data: chickenStock, error: csErr } = await chef
      .from('stock_lots')
      .select('qty_containers')
      .eq('user_id', userId)
      .eq('product_id', chickenId);
    expect(csErr).toBeNull();
    expect(chickenStock).toHaveLength(1);
    expect(Number(chickenStock![0].qty_containers)).toBeCloseTo(4.5, 1); // 5 - 0.5 = 4.5

    // Verify rice stock: was 3, consumed 0.5*0.5=0.25 container
    const { data: riceStock, error: rsErr } = await chef
      .from('stock_lots')
      .select('qty_containers')
      .eq('user_id', userId)
      .eq('product_id', riceId);
    expect(rsErr).toBeNull();
    expect(riceStock).toHaveLength(1);
    expect(Number(riceStock![0].qty_containers)).toBeCloseTo(2.75, 1); // 3 - 0.25 = 2.75

    // Verify food_logs were created (one per ingredient since it's a regular meal)
    const { data: logs, error: logErr } = await chef
      .from('food_logs')
      .select('product_id, qty_consumed, unit, calories, protein, carbs, fat')
      .eq('user_id', userId);
    expect(logErr).toBeNull();
    expect(logs).not.toBeNull();
    expect(logs!.length).toBe(2); // one for chicken, one for rice

    // Find the chicken food log — verify exact macro values
    const chickenLog = logs!.find((l: any) => l.product_id === chickenId);
    expect(chickenLog).toBeDefined();
    // 0.5 container * 4 spc * 165 cal/serving = 330 cal
    expect(Number(chickenLog!.calories)).toBeCloseTo(330, 0);
    // 0.5 container * 4 spc * 31 protein/serving = 62
    expect(Number(chickenLog!.protein)).toBeCloseTo(62, 0);
    // 0.5 container * 4 spc * 0 carbs/serving = 0
    expect(Number(chickenLog!.carbs)).toBeCloseTo(0, 0);
    // 0.5 container * 4 spc * 3.6 fat/serving = 7.2
    expect(Number(chickenLog!.fat)).toBeCloseTo(7.2, 1);
    expect(chickenLog!.unit).toBe('container');
    expect(Number(chickenLog!.qty_consumed)).toBeCloseTo(0.5, 1);

    // Find the rice food log — verify exact macro values
    const riceLog = logs!.find((l: any) => l.product_id === riceId);
    expect(riceLog).toBeDefined();
    // 0.25 container * 8 spc * 216 cal/serving = 432 cal
    expect(Number(riceLog!.calories)).toBeCloseTo(432, 0);
    // 0.25 container * 8 spc * 5 protein/serving = 10
    expect(Number(riceLog!.protein)).toBeCloseTo(10, 0);
    // 0.25 container * 8 spc * 45 carbs/serving = 90
    expect(Number(riceLog!.carbs)).toBeCloseTo(90, 0);
    // 0.25 container * 8 spc * 1.8 fat/serving = 3.6
    expect(Number(riceLog!.fat)).toBeCloseTo(3.6, 1);
    expect(riceLog!.unit).toBe('container');
    expect(Number(riceLog!.qty_consumed)).toBeCloseTo(0.25, 2);

    // Verify the meal plan entry is marked completed
    const { data: mealEntry, error: meErr } = await chef
      .from('meal_plan_entries')
      .select('completed_at')
      .eq('meal_id', mealId)
      .single();
    expect(meErr).toBeNull();
    expect(typeof mealEntry!.completed_at).toBe('string');
  });

  it('get_daily_macros aggregates food_logs + temp_items', async () => {
    const { userId, client } = await createTestUser('macros-agg');
    userIds.push(userId);

    const { chickenId, today } = await setupMealScenario(client, userId);
    const chef = client.schema('chefbyte') as any;

    // Manually insert a food_log: 1 serving of chicken = 165cal, 31p, 0c, 3.6f
    const { error: logErr } = await chef.from('food_logs').insert({
      user_id: userId,
      product_id: chickenId,
      logical_date: today,
      qty_consumed: 1,
      unit: 'serving',
      calories: 165,
      protein: 31,
      carbs: 0,
      fat: 3.6,
    });
    expect(logErr).toBeNull();

    // Insert a temp_item: Coffee = 50cal, 1c, 1p, 4f
    const { error: tempErr } = await chef.from('temp_items').insert({
      user_id: userId,
      name: 'Coffee',
      logical_date: today,
      calories: 50,
      carbs: 1,
      protein: 1,
      fat: 4,
    });
    expect(tempErr).toBeNull();

    // Call get_daily_macros
    const { data: macros, error: macroErr } = await chef.rpc('get_daily_macros', {
      p_logical_date: today,
    });
    expect(macroErr).toBeNull();
    expect(macros).not.toBeNull();

    // Verify consumed totals: 165 + 50 = 215 cal, 31 + 1 = 32 protein, 0 + 1 = 1 carbs, 3.6 + 4 = 7.6 fat
    expect(Number(macros.calories.consumed)).toBeCloseTo(215, 0);
    expect(Number(macros.protein.consumed)).toBeCloseTo(32, 0);
    expect(Number(macros.carbs.consumed)).toBeCloseTo(1, 0);
    expect(Number(macros.fat.consumed)).toBeCloseTo(7.6, 0);

    // Verify goals from user_config
    expect(Number(macros.calories.goal)).toBe(2000);
    expect(Number(macros.protein.goal)).toBe(150);
    expect(Number(macros.carbs.goal)).toBe(200);
    expect(Number(macros.fat.goal)).toBe(65);

    // Verify remaining = goal - consumed
    expect(Number(macros.calories.remaining)).toBeCloseTo(2000 - 215, 0);
    expect(Number(macros.protein.remaining)).toBeCloseTo(150 - 32, 0);
  });

  it('mark_meal_done with meal_prep creates [MEAL] product + stock lot', async () => {
    const { userId, client } = await createTestUser('meal-prep');
    userIds.push(userId);

    const { recipeId, chickenId, riceId, today } = await setupMealScenario(client, userId);
    const chef = client.schema('chefbyte') as any;

    // Create a meal_prep entry with servings=2
    const { data: prepMeal, error: prepErr } = await chef
      .from('meal_plan_entries')
      .insert({
        user_id: userId,
        recipe_id: recipeId,
        logical_date: today,
        servings: 2,
        meal_prep: true,
      })
      .select('meal_id')
      .single();
    expect(prepErr).toBeNull();
    const prepMealId = prepMeal!.meal_id;

    // Mark meal done (meal prep mode)
    const { data: result, error: markError } = await chef.rpc('mark_meal_done', {
      p_meal_id: prepMealId,
    });
    expect(markError).toBeNull();
    expect(result).not.toBeNull();
    expect(result.success).toBe(true);

    // Verify no food_logs were created for the prep itself (meal_prep skips macro logging)
    const { data: prepLogs, error: plErr } = await chef.from('food_logs').select('log_id').eq('user_id', userId);
    expect(plErr).toBeNull();
    expect(prepLogs).toHaveLength(0);

    // Verify a [MEAL] product was created
    const { data: mealProducts, error: mpErr } = await chef
      .from('products')
      .select('product_id, name, servings_per_container, calories_per_serving, protein_per_serving')
      .eq('user_id', userId)
      .like('name', '%[MEAL]%');
    expect(mpErr).toBeNull();
    expect(mealProducts).not.toBeNull();
    expect(mealProducts!.length).toBe(1);

    const mealProduct = mealProducts![0];
    expect(mealProduct.name).toContain('[MEAL]');
    expect(mealProduct.name).toContain('Chicken & Rice');

    // servings_per_container should equal the meal's servings (2)
    expect(Number(mealProduct.servings_per_container)).toBe(2);

    // Total macros: scale_factor = 2/2 = 1.0
    // Chicken: 1 container * 4 spc * 165 cal = 660, Rice: 0.5 container * 8 spc * 216 cal = 864
    // Total = 1524 cal, per serving (servings=2): 1524 / 2 = 762 cal/serving
    expect(Number(mealProduct.calories_per_serving)).toBeCloseTo(762, 0);

    // Verify a stock_lot was created for the [MEAL] product
    const { data: mealLots, error: mlErr } = await chef
      .from('stock_lots')
      .select('qty_containers, expires_on')
      .eq('user_id', userId)
      .eq('product_id', mealProduct.product_id);
    expect(mlErr).toBeNull();
    expect(mealLots).not.toBeNull();
    expect(mealLots!.length).toBe(1);
    expect(Number(mealLots![0].qty_containers)).toBe(1);

    // Verify stock was consumed: scale_factor=1.0, chicken went from 5 to 4 (consumed 1*1=1), rice from 3 to 2.5 (consumed 0.5*1=0.5)
    const { data: chickenStock, error: csErr } = await chef
      .from('stock_lots')
      .select('qty_containers')
      .eq('user_id', userId)
      .eq('product_id', chickenId);
    expect(csErr).toBeNull();
    expect(chickenStock).toHaveLength(1);
    expect(Number(chickenStock![0].qty_containers)).toBeCloseTo(4, 1); // 5 - 1 = 4

    const { data: riceStock, error: rsErr } = await chef
      .from('stock_lots')
      .select('qty_containers')
      .eq('user_id', userId)
      .eq('product_id', riceId);
    expect(rsErr).toBeNull();
    expect(riceStock).toHaveLength(1);
    expect(Number(riceStock![0].qty_containers)).toBeCloseTo(2.5, 1); // 3 - 0.5 = 2.5
  });
});
