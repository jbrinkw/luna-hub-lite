import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@luna-hub/db-types';
import { adminClient, SUPABASE_URL, SUPABASE_ANON_KEY } from '../../setup.integration';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageTestContext {
  userId: string;
  email: string;
  client: SupabaseClient<Database>;
  cleanup: () => Promise<void>;
}

export interface ChefByteSeeds {
  productMap: Record<string, string>; // name -> product_id
  locationId: string;
  recipeId: string;
}

export interface CoachByteSeeds {
  exerciseMap: Record<string, string>; // name -> exercise_id
}

// ---------------------------------------------------------------------------
// Context creation
// ---------------------------------------------------------------------------

function isRateLimitError(error: any): boolean {
  const msg = error?.message ?? '';
  return msg.includes('rate limit') || msg.includes('Rate limit');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Create a test user, sign in, activate both apps. Retries on rate limits. */
export async function createPageTestContext(suffix: string): Promise<PageTestContext> {
  const email = `page-test-${suffix}-${Date.now()}@test.com`;
  const password = 'test-password-123';

  let created: any;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (!error) {
      created = data;
      break;
    }
    if (!isRateLimitError(error) || attempt === 4) {
      throw new Error(`Failed to create test user: ${error.message}`);
    }
    await sleep(1000 * Math.pow(2, attempt));
  }

  if (!created?.user) {
    throw new Error('Failed to create test user: no user returned');
  }

  const userId = created.user.id;

  const client = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  for (let attempt = 0; attempt < 5; attempt++) {
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (!error) break;
    if (!isRateLimitError(error) || attempt === 4) {
      throw new Error(`Failed to sign in: ${error.message}`);
    }
    await sleep(1000 * Math.pow(2, attempt));
  }

  // Activate both apps
  for (const app of ['coachbyte', 'chefbyte']) {
    const { error } = await (client as any).schema('hub').rpc('activate_app', {
      p_app_name: app,
    });
    if (error) throw new Error(`Failed to activate ${app}: ${error.message}`);
  }

  return {
    userId,
    email,
    client,
    cleanup: async () => {
      await adminClient.auth.admin.deleteUser(userId);
    },
  };
}

// ---------------------------------------------------------------------------
// Schema-scoped helpers
// ---------------------------------------------------------------------------

export function chefbyte(client: SupabaseClient<Database>) {
  return (client as any).schema('chefbyte');
}

export function coachbyte(client: SupabaseClient<Database>) {
  return (client as any).schema('coachbyte');
}

export function hub(client: SupabaseClient<Database>) {
  return (client as any).schema('hub');
}

// ---------------------------------------------------------------------------
// Seed functions
// ---------------------------------------------------------------------------

/** Seed 5 products, return name→product_id map */
export async function seedProducts(ctx: PageTestContext): Promise<Record<string, string>> {
  const chef = chefbyte(ctx.client);

  const products = [
    {
      user_id: ctx.userId,
      name: 'Great Value Boneless Skinless Chicken Breasts',
      servings_per_container: 4,
      calories_per_serving: 165,
      protein_per_serving: 31,
      carbs_per_serving: 0,
      fat_per_serving: 3.6,
      min_stock_amount: 2,
    },
    {
      user_id: ctx.userId,
      name: 'Great Value Long Grain Brown Rice',
      servings_per_container: 8,
      calories_per_serving: 216,
      protein_per_serving: 5,
      carbs_per_serving: 45,
      fat_per_serving: 1.8,
      min_stock_amount: 1,
    },
    {
      user_id: ctx.userId,
      name: 'Great Value Large White Eggs',
      servings_per_container: 12,
      calories_per_serving: 72,
      protein_per_serving: 6.3,
      carbs_per_serving: 0.4,
      fat_per_serving: 4.8,
      min_stock_amount: 1,
    },
    {
      user_id: ctx.userId,
      name: 'Birds Eye Sweet Peas',
      servings_per_container: 3.5,
      calories_per_serving: 60,
      protein_per_serving: 4,
      carbs_per_serving: 10,
      fat_per_serving: 0,
      min_stock_amount: 0,
    },
    {
      user_id: ctx.userId,
      name: 'Banquet Chicken Breast Patties',
      servings_per_container: 6,
      calories_per_serving: 190,
      protein_per_serving: 10,
      carbs_per_serving: 13,
      fat_per_serving: 11,
      min_stock_amount: 3,
    },
  ];

  const { data, error } = await chef.from('products').insert(products).select('product_id, name');
  if (error) throw new Error(`Failed to seed products: ${error.message}`);

  const map: Record<string, string> = {};
  for (const p of data) map[p.name] = p.product_id;
  return map;
}

/** Fetch default location (Fridge) for user */
export async function getDefaultLocation(ctx: PageTestContext): Promise<string> {
  const { data, error } = await chefbyte(ctx.client)
    .from('locations')
    .select('location_id, name')
    .eq('user_id', ctx.userId)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error || !data?.length) throw new Error('No locations found');
  return data[0].location_id;
}

/** Fetch all locations for user */
export async function getLocations(ctx: PageTestContext): Promise<Array<{ location_id: string; name: string }>> {
  const { data, error } = await chefbyte(ctx.client)
    .from('locations')
    .select('location_id, name')
    .eq('user_id', ctx.userId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Failed to fetch locations: ${error.message}`);
  return data;
}

/** Seed stock lots for given products, return lot IDs */
export async function seedStock(
  ctx: PageTestContext,
  productMap: Record<string, string>,
  locationId: string,
): Promise<void> {
  const lots = [
    {
      user_id: ctx.userId,
      product_id: productMap['Great Value Boneless Skinless Chicken Breasts'],
      location_id: locationId,
      qty_containers: 3,
      expires_on: futureDate(5),
    },
    {
      user_id: ctx.userId,
      product_id: productMap['Great Value Long Grain Brown Rice'],
      location_id: locationId,
      qty_containers: 2,
      expires_on: futureDate(90),
    },
    {
      user_id: ctx.userId,
      product_id: productMap['Great Value Large White Eggs'],
      location_id: locationId,
      qty_containers: 0.5,
      expires_on: futureDate(14),
    },
  ];

  const { error } = await chefbyte(ctx.client).from('stock_lots').insert(lots);
  if (error) throw new Error(`Failed to seed stock: ${error.message}`);
}

/** Seed a recipe with ingredients, return recipe_id */
export async function seedRecipe(ctx: PageTestContext, productMap: Record<string, string>): Promise<string> {
  const chef = chefbyte(ctx.client);

  const { data: recipe, error: recipeErr } = await chef
    .from('recipes')
    .insert({
      user_id: ctx.userId,
      name: 'Chicken & Rice',
      description: 'Simple chicken and rice meal',
      base_servings: 2,
      active_time: 15,
      total_time: 30,
    })
    .select('recipe_id')
    .single();
  if (recipeErr) throw new Error(`Failed to seed recipe: ${recipeErr.message}`);

  const { error: ingredErr } = await chef.from('recipe_ingredients').insert([
    {
      recipe_id: recipe.recipe_id,
      product_id: productMap['Great Value Boneless Skinless Chicken Breasts'],
      user_id: ctx.userId,
      quantity: 0.5,
      unit: 'container',
    },
    {
      recipe_id: recipe.recipe_id,
      product_id: productMap['Great Value Long Grain Brown Rice'],
      user_id: ctx.userId,
      quantity: 0.25,
      unit: 'container',
    },
  ]);
  if (ingredErr) throw new Error(`Failed to seed recipe ingredients: ${ingredErr.message}`);

  return recipe.recipe_id;
}

/** Seed macro goals */
export async function seedMacroGoals(ctx: PageTestContext): Promise<void> {
  const goals = [
    { user_id: ctx.userId, key: 'goal_calories', value: '2200' },
    { user_id: ctx.userId, key: 'goal_protein', value: '180' },
    { user_id: ctx.userId, key: 'goal_carbs', value: '220' },
    { user_id: ctx.userId, key: 'goal_fat', value: '73' },
  ];

  const { error } = await chefbyte(ctx.client).from('user_config').upsert(goals, { onConflict: 'user_id,key' });
  if (error) throw new Error(`Failed to seed macro goals: ${error.message}`);
}

/** Seed a CoachByte split for today's weekday */
export async function seedSplit(ctx: PageTestContext): Promise<CoachByteSeeds> {
  const coach = coachbyte(ctx.client);

  // Fetch global exercises
  const { data: exercises, error: exErr } = await coach
    .from('exercises')
    .select('exercise_id, name')
    .is('user_id', null);
  if (exErr) throw new Error(`Failed to fetch exercises: ${exErr.message}`);

  const exerciseMap: Record<string, string> = {};
  for (const e of exercises) exerciseMap[e.name] = e.exercise_id;

  const squat = exerciseMap['Squat'];
  const bench = exerciseMap['Bench Press'];
  if (!squat || !bench) throw new Error('Global exercises Squat/Bench Press not found');

  const weekday = new Date().getDay();
  const templateSets = [
    { exercise_id: squat, target_reps: 5, target_load: 225, order: 1 },
    { exercise_id: squat, target_reps: 5, target_load: 225, order: 2 },
    { exercise_id: bench, target_reps: 5, target_load: 185, order: 3 },
  ];

  const { error: splitErr } = await coach.from('splits').insert({
    user_id: ctx.userId,
    weekday,
    template_sets: templateSets,
    split_notes: 'Integration test split',
  });
  if (splitErr) throw new Error(`Failed to seed split: ${splitErr.message}`);

  return { exerciseMap };
}

/** Seed all ChefByte data (products + stock + recipe + macro goals) */
export async function seedAllChefByte(ctx: PageTestContext): Promise<ChefByteSeeds> {
  const productMap = await seedProducts(ctx);
  const locationId = await getDefaultLocation(ctx);
  await seedStock(ctx, productMap, locationId);
  const recipeId = await seedRecipe(ctx, productMap);
  await seedMacroGoals(ctx);
  return { productMap, locationId, recipeId };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/** Assert a Supabase query succeeded with data */
export function assertQuerySucceeds<T>(result: { data: T | null; error: any }, label?: string): T {
  const prefix = label ? `[${label}] ` : '';
  if (result.error) throw new Error(`${prefix}Query failed: ${result.error.message}`);
  if (result.data === null || result.data === undefined) throw new Error(`${prefix}Query returned null data`);
  return result.data;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function futureDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

export function todayDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export { adminClient, SUPABASE_URL, SUPABASE_ANON_KEY };
