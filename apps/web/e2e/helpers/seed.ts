import { type Page, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { admin, SUPABASE_URL, ANON_KEY } from './constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SeedUserResult {
  userId: string;
  email: string;
  password: string;
  cleanup: () => Promise<void>;
}

interface SeedFullResult extends SeedUserResult {
  client: SupabaseClient;
}

interface SeedChefByteDataResult {
  productMap: Record<string, string>; // name -> product_id
  locationId: string; // Fridge location_id
  recipeId: string;
}

interface SeedCoachByteDataResult {
  exerciseMap: Record<string, string>; // name -> exercise_id
}

// ---------------------------------------------------------------------------
// seedUser — create a test user via admin API
// ---------------------------------------------------------------------------

export async function seedUser(suffix: string): Promise<SeedUserResult> {
  const email = `e2e-${suffix}-${Date.now()}@test.com`;
  const password = 'testpass123';

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: `E2E ${suffix}` },
  });

  if (error || !data.user) {
    throw new Error(`Failed to create test user: ${error?.message ?? 'no user returned'}`);
  }

  const userId = data.user.id;

  return {
    userId,
    email,
    password,
    cleanup: async () => {
      await admin.auth.admin.deleteUser(userId);
    },
  };
}

// ---------------------------------------------------------------------------
// seedFullAndLogin — create user, activate modules, login via browser UI
// ---------------------------------------------------------------------------

interface SeedFullOptions {
  activateCoachByte?: boolean; // default true
  activateChefByte?: boolean; // default true
}

export async function seedFullAndLogin(page: Page, suffix: string, options?: SeedFullOptions): Promise<SeedFullResult> {
  const activateCoach = options?.activateCoachByte ?? true;
  const activateChef = options?.activateChefByte ?? true;

  // 1. Create user
  const { userId, email, password, cleanup } = await seedUser(suffix);

  // 2. Create an authenticated Supabase client for programmatic seeding
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await client.auth.signInWithPassword({ email, password });

  // 3. Activate modules via RPC (requires authenticated session)
  if (activateCoach) {
    const { error } = await (client as any).schema('hub').rpc('activate_app', {
      p_app_name: 'coachbyte',
    });
    if (error) throw new Error(`Failed to activate CoachByte: ${error.message}`);
  }

  if (activateChef) {
    const { error } = await (client as any).schema('hub').rpc('activate_app', {
      p_app_name: 'chefbyte',
    });
    if (error) throw new Error(`Failed to activate ChefByte: ${error.message}`);
  }

  // 4. Login via browser UI
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/hub/, { timeout: 10000 });

  return { userId, email, password, cleanup, client };
}

// ---------------------------------------------------------------------------
// seedChefByteData — seed locations, products, stock, recipe, macro goals
// ---------------------------------------------------------------------------

export async function seedChefByteData(client: SupabaseClient, userId: string): Promise<SeedChefByteDataResult> {
  const chef = (client as any).schema('chefbyte');

  // -- Locations (activation already seeds Fridge/Pantry/Freezer, fetch them) --
  const { data: locations, error: locErr } = await chef
    .from('locations')
    .select('location_id, name')
    .eq('user_id', userId);
  if (locErr) throw new Error(`Failed to fetch locations: ${locErr.message}`);

  const fridge = locations.find((l: any) => l.name === 'Fridge');
  const pantry = locations.find((l: any) => l.name === 'Pantry');
  if (!fridge || !pantry) throw new Error('Default locations (Fridge/Pantry) not found');

  const fridgeId: string = fridge.location_id;
  const pantryId: string = pantry.location_id;

  // -- Products --
  const products = [
    {
      user_id: userId,
      name: 'Chicken Breast',
      servings_per_container: 4,
      calories_per_serving: 165,
      protein_per_serving: 31,
      carbs_per_serving: 0,
      fat_per_serving: 3.6,
      min_stock_amount: 2,
    },
    {
      user_id: userId,
      name: 'Brown Rice',
      servings_per_container: 8,
      calories_per_serving: 216,
      protein_per_serving: 5,
      carbs_per_serving: 45,
      fat_per_serving: 1.8,
      min_stock_amount: 1,
    },
    {
      user_id: userId,
      name: 'Eggs',
      servings_per_container: 12,
      calories_per_serving: 72,
      protein_per_serving: 6.3,
      carbs_per_serving: 0.4,
      fat_per_serving: 4.8,
      min_stock_amount: 1,
    },
    {
      user_id: userId,
      name: 'Protein Powder',
      servings_per_container: 30,
      calories_per_serving: 120,
      protein_per_serving: 24,
      carbs_per_serving: 3,
      fat_per_serving: 1.5,
      min_stock_amount: 0.5,
    },
    {
      user_id: userId,
      name: 'Bananas',
      servings_per_container: 1,
      calories_per_serving: 105,
      protein_per_serving: 1.3,
      carbs_per_serving: 27,
      fat_per_serving: 0.4,
      min_stock_amount: 3,
    },
  ];

  const { data: insertedProducts, error: prodErr } = await chef
    .from('products')
    .insert(products)
    .select('product_id, name');
  if (prodErr) throw new Error(`Failed to insert products: ${prodErr.message}`);

  const productMap: Record<string, string> = {};
  for (const p of insertedProducts) {
    productMap[p.name] = p.product_id;
  }

  // -- Stock lots (varied quantities) --
  const stockLots = [
    {
      user_id: userId,
      product_id: productMap['Chicken Breast'],
      location_id: fridgeId,
      qty_containers: 3,
      expires_on: futureDate(5),
    },
    {
      user_id: userId,
      product_id: productMap['Brown Rice'],
      location_id: pantryId,
      qty_containers: 2,
      expires_on: futureDate(90),
    },
    {
      user_id: userId,
      product_id: productMap['Eggs'],
      location_id: fridgeId,
      qty_containers: 0.5,
      expires_on: futureDate(14),
    },
    {
      user_id: userId,
      product_id: productMap['Protein Powder'],
      location_id: pantryId,
      qty_containers: 0.5,
      expires_on: futureDate(180),
    },
    // Bananas: qty_containers = 0 (out of stock)
    {
      user_id: userId,
      product_id: productMap['Bananas'],
      location_id: fridgeId,
      qty_containers: 0,
      expires_on: futureDate(3),
    },
  ];

  const { error: stockErr } = await chef.from('stock_lots').insert(stockLots);
  if (stockErr) throw new Error(`Failed to insert stock lots: ${stockErr.message}`);

  // -- Recipe: Chicken & Rice (2 ingredients) --
  const { data: recipe, error: recipeErr } = await chef
    .from('recipes')
    .insert({
      user_id: userId,
      name: 'Chicken & Rice',
      description: 'Simple chicken and rice meal',
      base_servings: 2,
      active_time: 15,
      total_time: 30,
    })
    .select('recipe_id')
    .single();
  if (recipeErr) throw new Error(`Failed to insert recipe: ${recipeErr.message}`);

  const recipeId: string = recipe.recipe_id;

  const { error: ingredErr } = await chef.from('recipe_ingredients').insert([
    {
      recipe_id: recipeId,
      product_id: productMap['Chicken Breast'],
      user_id: userId,
      quantity: 0.5,
      unit: 'container',
    },
    {
      recipe_id: recipeId,
      product_id: productMap['Brown Rice'],
      user_id: userId,
      quantity: 0.25,
      unit: 'container',
    },
  ]);
  if (ingredErr) throw new Error(`Failed to insert recipe ingredients: ${ingredErr.message}`);

  // -- Macro goals (user_config key/value pairs) --
  // Keys must match what get_daily_macros reads: goal_calories, goal_protein, goal_carbs, goal_fats
  // Use upsert since activate_app may seed defaults
  const macroGoals = [
    { user_id: userId, key: 'goal_calories', value: '2200' },
    { user_id: userId, key: 'goal_protein', value: '180' },
    { user_id: userId, key: 'goal_carbs', value: '220' },
    { user_id: userId, key: 'goal_fats', value: '73' },
  ];

  const { error: configErr } = await chef.from('user_config').upsert(macroGoals, { onConflict: 'user_id,key' });
  if (configErr) throw new Error(`Failed to upsert macro goals: ${configErr.message}`);

  return { productMap, locationId: fridgeId, recipeId };
}

// ---------------------------------------------------------------------------
// seedCoachByteData — seed a split with planned sets for today
// ---------------------------------------------------------------------------

export async function seedCoachByteData(client: SupabaseClient, userId: string): Promise<SeedCoachByteDataResult> {
  const coach = (client as any).schema('coachbyte');

  // -- Fetch global exercises (Squat, Bench Press) --
  const { data: exercises, error: exErr } = await coach
    .from('exercises')
    .select('exercise_id, name')
    .is('user_id', null);
  if (exErr) throw new Error(`Failed to fetch exercises: ${exErr.message}`);

  const exerciseMap: Record<string, string> = {};
  for (const e of exercises) {
    exerciseMap[e.name] = e.exercise_id;
  }

  const squat = exerciseMap['Squat'];
  const bench = exerciseMap['Bench Press'];
  if (!squat || !bench) throw new Error('Global exercises Squat/Bench Press not found');

  // -- Create split for today's weekday --
  const today = new Date();
  const weekday = today.getDay(); // 0=Sun, 6=Sat

  const templateSets = [
    { exercise_id: squat, target_reps: 5, target_load: 225, order: 1 },
    { exercise_id: squat, target_reps: 5, target_load: 225, order: 2 },
    { exercise_id: bench, target_reps: 5, target_load: 185, order: 3 },
  ];

  const { error: splitErr } = await coach.from('splits').insert({
    user_id: userId,
    weekday,
    template_sets: templateSets,
    split_notes: 'E2E test split',
  });
  if (splitErr) throw new Error(`Failed to insert split: ${splitErr.message}`);

  return { exerciseMap };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns an ISO date string N days in the future */
function futureDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
