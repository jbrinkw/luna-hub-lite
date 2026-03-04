import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  seedUser,
  seedChefByteData,
  seedCoachByteData,
  seedMealEntry,
  seedCompletedSet,
  todayStr,
} from '../helpers/seed';
import { generateTestApiKey, McpE2EClient } from '../helpers/mcp-client';
import { SUPABASE_URL, ANON_KEY } from '../helpers/constants';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface TestContext {
  userId: string;
  email: string;
  password: string;
  cleanup: () => Promise<void>;
  client: SupabaseClient;
  mcp: McpE2EClient;
}

/**
 * Creates a test user with both modules activated, an authenticated Supabase
 * client, and an initialized MCP SSE connection. Callers must call
 * ctx.mcp.disconnect() and ctx.cleanup() in a finally block.
 */
async function setupMcpUser(suffix: string): Promise<TestContext> {
  const { userId, email, password, cleanup } = await seedUser(suffix);

  // Authenticated client for seeding / verification
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await client.auth.signInWithPassword({ email, password });

  // Activate both modules
  const { error: coachErr } = await (client as any).schema('hub').rpc('activate_app', { p_app_name: 'coachbyte' });
  if (coachErr) throw new Error(`Failed to activate CoachByte: ${coachErr.message}`);

  const { error: chefErr } = await (client as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
  if (chefErr) throw new Error(`Failed to activate ChefByte: ${chefErr.message}`);

  // Generate API key and connect MCP client
  const apiKey = await generateTestApiKey(userId);
  const mcp = new McpE2EClient();
  await mcp.connect(apiKey);
  await mcp.initialize();

  return { userId, email, password, cleanup, client, mcp };
}

/** Parse the first content text entry from an MCP tool result as JSON. */
function parseResult(result: any): any {
  return JSON.parse(result.content[0].text);
}

/** Assert an MCP result has isError: true and the text contains a substring. */
function expectError(result: any, substring?: string) {
  expect(result.isError).toBe(true);
  if (substring) {
    expect(result.content[0].text).toContain(substring);
  }
}

// ---------------------------------------------------------------------------
// ChefByte MCP tool tests
// ---------------------------------------------------------------------------

test.describe('MCP Tools — ChefByte', () => {
  test('CHEFBYTE_get_products returns all seeded products', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-products');
      await seedChefByteData(ctx.client, ctx.userId);

      const result = await ctx.mcp.callTool('CHEFBYTE_get_products', {});
      const data = parseResult(result);

      expect(data.total).toBe(5);
      const names = data.products.map((p: any) => p.name);
      expect(names).toContain('Chicken Breast');
      expect(names).toContain('Brown Rice');
      expect(names).toContain('Eggs');
      expect(names).toContain('Protein Powder');
      expect(names).toContain('Bananas');

      // Verify nutritional data is returned
      const chicken = data.products.find((p: any) => p.name === 'Chicken Breast');
      expect(chicken.calories_per_serving).toBe(165);
      expect(chicken.protein_per_serving).toBe(31);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_consume reduces stock and logs macros', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-consume');
      const { productMap } = await seedChefByteData(ctx.client, ctx.userId);

      const chickenId = productMap['Chicken Breast'];

      // Get stock before consuming
      const chef = (ctx.client as any).schema('chefbyte');
      const { data: lotsBefore } = await chef
        .from('stock_lots')
        .select('qty_containers')
        .eq('product_id', chickenId)
        .gt('qty_containers', 0);
      const stockBefore = lotsBefore.reduce((sum: number, l: any) => sum + Number(l.qty_containers), 0);

      // Consume 1 container via MCP
      const result = await ctx.mcp.callTool('CHEFBYTE_consume', {
        product_id: chickenId,
        qty: 1,
        unit: 'container',
      });
      const data = parseResult(result);
      expect(data).toBeTruthy();

      // Verify stock decreased
      const { data: lotsAfter } = await chef
        .from('stock_lots')
        .select('qty_containers')
        .eq('product_id', chickenId)
        .gte('qty_containers', 0);
      const stockAfter = lotsAfter.reduce((sum: number, l: any) => sum + Number(l.qty_containers), 0);
      expect(stockAfter).toBeLessThan(stockBefore);

      // Verify macro log was created
      const today = todayStr();
      const { data: logs } = await chef
        .from('food_logs')
        .select('product_id, qty_consumed, unit')
        .eq('user_id', ctx.userId)
        .eq('logical_date', today);
      expect(logs!.length).toBeGreaterThanOrEqual(1);
      const chickenLog = logs!.find((l: any) => l.product_id === chickenId);
      expect(chickenLog).toBeTruthy();
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_get_macros returns daily totals after consuming', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-macros');
      const { productMap } = await seedChefByteData(ctx.client, ctx.userId);

      // Consume 1 container of Chicken Breast (4 servings x 165 cal = 660 cal)
      await ctx.mcp.callTool('CHEFBYTE_consume', {
        product_id: productMap['Chicken Breast'],
        qty: 1,
        unit: 'container',
      });

      // Get macros for today
      const result = await ctx.mcp.callTool('CHEFBYTE_get_macros', {});
      const data = parseResult(result);

      // The RPC returns nested objects: { calories: { consumed, goal, remaining }, ... }
      expect(Number(data.calories.consumed)).toBeGreaterThan(0);
      expect(Number(data.protein.consumed)).toBeGreaterThan(0);
      // Goals should be set from the seed data
      expect(Number(data.calories.goal)).toBe(2200);
      expect(Number(data.protein.goal)).toBe(180);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_create_recipe with ingredients', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-recipe');
      const { productMap } = await seedChefByteData(ctx.client, ctx.userId);

      const result = await ctx.mcp.callTool('CHEFBYTE_create_recipe', {
        name: 'MCP Protein Bowl',
        description: 'High protein post-workout meal',
        base_servings: 1,
        ingredients: [
          { product_id: productMap['Chicken Breast'], quantity: 0.5, unit: 'container' },
          { product_id: productMap['Brown Rice'], quantity: 0.25, unit: 'container' },
          { product_id: productMap['Eggs'], quantity: 3, unit: 'serving' },
        ],
      });
      const data = parseResult(result);

      expect(data.message).toContain('MCP Protein Bowl');
      expect(data.message).toContain('3 ingredient');
      expect(data.recipe.recipe_id).toBeTruthy();
      expect(data.recipe.name).toBe('MCP Protein Bowl');

      // Verify in DB
      const chef = (ctx.client as any).schema('chefbyte');
      const { data: ingredients } = await chef
        .from('recipe_ingredients')
        .select('product_id, quantity, unit')
        .eq('recipe_id', data.recipe.recipe_id);
      expect(ingredients!.length).toBe(3);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_get_meal_plan returns week with seeded entries', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-mealplan');
      const { recipeId } = await seedChefByteData(ctx.client, ctx.userId);

      const today = todayStr();
      await seedMealEntry(ctx.client, ctx.userId, recipeId, today, {
        servings: 2,
        mealType: 'lunch',
      });

      // Query meal plan via MCP for the current week
      const result = await ctx.mcp.callTool('CHEFBYTE_get_meal_plan', {
        start_date: today,
        end_date: today,
      });
      const data = parseResult(result);

      expect(data.total).toBeGreaterThanOrEqual(1);
      const entry = data.entries.find((e: any) => e.recipe_name === 'Chicken & Rice');
      expect(entry).toBeTruthy();
      expect(Number(entry.servings)).toBe(2);
      expect(entry.logical_date).toBe(today);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_below_min_stock identifies low-stock products', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-minstock');
      await seedChefByteData(ctx.client, ctx.userId);

      // Bananas has qty=0 and min_stock=3, Eggs has qty=0.5 and min_stock=1,
      // Protein Powder has qty=0.5 and min_stock=0.5 (exactly at min)
      const result = await ctx.mcp.callTool('CHEFBYTE_below_min_stock', {});
      const data = parseResult(result);

      expect(data.total).toBeGreaterThanOrEqual(1);
      const names = data.below_min.map((item: any) => item.product_name);
      // Bananas: stock=0, min=3 -> definitely below
      expect(names).toContain('Bananas');
      // Eggs: stock=0.5, min=1 -> below
      expect(names).toContain('Eggs');

      // Each below-min item should have deficit info
      const bananas = data.below_min.find((item: any) => item.product_name === 'Bananas');
      expect(bananas.deficit).toBeGreaterThan(0);
      expect(bananas.current_stock).toBe(0);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_delete_meal_entry removes entry', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-delmeal');
      const { recipeId } = await seedChefByteData(ctx.client, ctx.userId);

      const today = todayStr();
      const mealId = await seedMealEntry(ctx.client, ctx.userId, recipeId, today);

      // Verify entry exists
      const chef = (ctx.client as any).schema('chefbyte');
      const { data: before } = await chef.from('meal_plan_entries').select('meal_id').eq('meal_id', mealId);
      expect(before!.length).toBe(1);

      // Delete via MCP
      const result = await ctx.mcp.callTool('CHEFBYTE_delete_meal_entry', {
        meal_id: mealId,
      });
      const data = parseResult(result);
      expect(data.message).toContain('deleted');
      expect(data.meal_id).toBe(mealId);

      // Verify deletion in DB
      const { data: after } = await chef.from('meal_plan_entries').select('meal_id').eq('meal_id', mealId);
      expect(after!.length).toBe(0);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('CHEFBYTE_update_product changes product fields', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-chef-update');
      const { productMap } = await seedChefByteData(ctx.client, ctx.userId);

      const riceId = productMap['Brown Rice'];

      const result = await ctx.mcp.callTool('CHEFBYTE_update_product', {
        product_id: riceId,
        name: 'White Rice',
        calories_per_serving: 200,
        price: 3.99,
      });
      const data = parseResult(result);

      expect(data.message).toContain('White Rice');
      expect(data.product.product_id).toBe(riceId);
      expect(data.product.name).toBe('White Rice');

      // Verify in DB
      const chef = (ctx.client as any).schema('chefbyte');
      const { data: updated } = await chef
        .from('products')
        .select('name, calories_per_serving, price')
        .eq('product_id', riceId)
        .single();
      expect(updated.name).toBe('White Rice');
      expect(Number(updated.calories_per_serving)).toBe(200);
      expect(Number(updated.price)).toBeCloseTo(3.99, 1);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// CoachByte MCP tool tests
// ---------------------------------------------------------------------------

test.describe('MCP Tools — CoachByte', () => {
  test('COACHBYTE_get_exercises returns exercise list', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-coach-exercises');
      await seedCoachByteData(ctx.client, ctx.userId);

      // The get_exercises tool filters by user_id = ctx.userId, so global
      // exercises (user_id IS NULL) are not returned. We need to create
      // a user-specific exercise to test this tool.
      const coach = (ctx.client as any).schema('coachbyte');
      await coach.from('exercises').insert({
        user_id: ctx.userId,
        name: 'MCP Custom Exercise',
      });

      const result = await ctx.mcp.callTool('COACHBYTE_get_exercises', {});
      const data = parseResult(result);

      expect(data.total).toBeGreaterThanOrEqual(1);
      const names = data.exercises.map((e: any) => e.name);
      expect(names).toContain('MCP Custom Exercise');
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('COACHBYTE_get_split returns weekly split', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-coach-split');
      await seedCoachByteData(ctx.client, ctx.userId);

      // seedCoachByteData creates a split for today's weekday
      const todayWeekday = new Date().getDay();

      const result = await ctx.mcp.callTool('COACHBYTE_get_split', {
        weekday: todayWeekday,
      });
      const data = parseResult(result);

      expect(data.splits.length).toBeGreaterThanOrEqual(1);
      const todaySplit = data.splits.find((s: any) => s.weekday === todayWeekday);
      expect(todaySplit).toBeTruthy();
      expect(todaySplit.template_sets.length).toBe(3); // 2 squat + 1 bench from seed

      // Verify exercise names were resolved
      const exerciseNames = todaySplit.template_sets.map((ts: any) => ts.exercise_name);
      expect(exerciseNames).toContain('Squat');
      expect(exerciseNames).toContain('Bench Press');
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('COACHBYTE timer lifecycle: set -> get -> pause -> resume -> reset', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-coach-timer');

      // 1. Get timer — should be idle (no timer exists)
      const idleResult = await ctx.mcp.callTool('COACHBYTE_get_timer', {});
      const idleData = parseResult(idleResult);
      expect(idleData.state).toBe('idle');

      // 2. Set timer for 120 seconds
      const setResult = await ctx.mcp.callTool('COACHBYTE_set_timer', {
        duration_seconds: 120,
      });
      const setData = parseResult(setResult);
      expect(setData.state).toBe('running');
      expect(setData.duration_seconds).toBe(120);
      expect(setData.timer_id).toBeTruthy();

      // 3. Get timer — should be running
      const runningResult = await ctx.mcp.callTool('COACHBYTE_get_timer', {});
      const runningData = parseResult(runningResult);
      expect(runningData.state).toBe('running');
      expect(runningData.remaining_seconds).toBeGreaterThan(0);
      expect(runningData.remaining_seconds).toBeLessThanOrEqual(120);

      // 4. Pause the timer
      const pauseResult = await ctx.mcp.callTool('COACHBYTE_pause_timer', {});
      const pauseData = parseResult(pauseResult);
      expect(pauseData.state).toBe('paused');
      expect(pauseData.remaining_seconds).toBeGreaterThan(0);

      // 5. Resume the timer
      const resumeResult = await ctx.mcp.callTool('COACHBYTE_resume_timer', {});
      const resumeData = parseResult(resumeResult);
      expect(resumeData.state).toBe('running');
      expect(resumeData.remaining_seconds).toBeGreaterThan(0);

      // 6. Reset the timer
      const resetResult = await ctx.mcp.callTool('COACHBYTE_reset_timer', {});
      const resetData = parseResult(resetResult);
      expect(resetData.state).toBe('idle');

      // 7. Verify timer is gone
      const finalResult = await ctx.mcp.callTool('COACHBYTE_get_timer', {});
      const finalData = parseResult(finalResult);
      expect(finalData.state).toBe('idle');
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('COACHBYTE_get_history returns completed sets', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-coach-history');
      await seedCoachByteData(ctx.client, ctx.userId);

      const today = todayStr();
      await seedCompletedSet(ctx.client, ctx.userId, today);

      const result = await ctx.mcp.callTool('COACHBYTE_get_history', { days: 7 });
      const data = parseResult(result);

      expect(data.days.length).toBeGreaterThanOrEqual(1);

      const todayPlan = data.days.find((d: any) => d.plan_date === today || d.logical_date === today);
      expect(todayPlan).toBeTruthy();
      expect(todayPlan.total_sets_completed).toBeGreaterThanOrEqual(1);
      expect(todayPlan.completed_sets.length).toBeGreaterThanOrEqual(1);

      // Verify set details
      const firstSet = todayPlan.completed_sets[0];
      expect(firstSet.actual_reps).toBe(5);
      expect(Number(firstSet.actual_load)).toBe(225);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('COACHBYTE_get_prs returns personal records', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-coach-prs');
      await seedCoachByteData(ctx.client, ctx.userId);

      const today = todayStr();
      await seedCompletedSet(ctx.client, ctx.userId, today);

      const result = await ctx.mcp.callTool('COACHBYTE_get_prs', {});
      const data = parseResult(result);

      expect(data.prs.length).toBeGreaterThanOrEqual(1);

      const pr = data.prs[0];
      expect(pr.exercise_id).toBeTruthy();
      expect(pr.estimated_1rm).toBeGreaterThan(0);
      expect(pr.best_set.reps).toBe(5);
      expect(Number(pr.best_set.load)).toBe(225);
      expect(pr.rm_table).toBeTruthy();
      expect(pr.rm_table['1RM']).toBeGreaterThan(0);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('COACHBYTE_update_summary persists text', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-coach-summary');
      await seedCoachByteData(ctx.client, ctx.userId);

      // Get today's plan to get a plan_id
      const planResult = await ctx.mcp.callTool('COACHBYTE_get_today_plan', {});
      const planData = parseResult(planResult);
      const planId = planData.plan_id;
      expect(planId).toBeTruthy();

      // Update the summary
      const summaryText = 'Great workout session! Hit all targets.';
      const result = await ctx.mcp.callTool('COACHBYTE_update_summary', {
        plan_id: planId,
        summary: summaryText,
      });
      const data = parseResult(result);
      expect(data.message).toContain('updated');
      expect(data.summary).toBe(summaryText);

      // Verify in DB
      const coach = (ctx.client as any).schema('coachbyte');
      const { data: plan } = await coach.from('daily_plans').select('summary').eq('plan_id', planId).single();
      expect(plan.summary).toBe(summaryText);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Error handling tests
// ---------------------------------------------------------------------------

test.describe('MCP Tools — Error Handling', () => {
  test('invalid tool name returns isError: true', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-err-unknown');

      const result = await ctx.mcp.callTool('NONEXISTENT_TOOL', {});
      expectError(result, 'Unknown tool');
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('missing required argument returns isError: true', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-err-missing');
      await seedChefByteData(ctx.client, ctx.userId);

      // CHEFBYTE_consume requires product_id, qty, unit — omit all
      const result = await ctx.mcp.callTool('CHEFBYTE_consume', {});
      expectError(result);
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });

  test('invalid UUID returns isError: true', async () => {
    let ctx: TestContext | null = null;
    try {
      ctx = await setupMcpUser('mcp-err-uuid');

      const result = await ctx.mcp.callTool('CHEFBYTE_delete_meal_entry', {
        meal_id: '00000000-0000-0000-0000-000000000000',
      });
      expectError(result, 'not found');
    } finally {
      await ctx?.mcp.disconnect();
      await ctx?.cleanup();
    }
  });
});
