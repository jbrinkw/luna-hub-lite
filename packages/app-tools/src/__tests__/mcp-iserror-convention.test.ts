/**
 * Spec-vs-implementation: MCP isError convention
 *
 * CLAUDE.md spec: "Tool errors: `isError: true` with descriptive message"
 *
 * This test exhaustively walks every tool's error path (using a
 * supabase mock that always returns an error) and asserts that:
 *   1. The handler returns isError: true (not throws)
 *   2. The content[0].text is a non-empty string
 *   3. There is NO data payload alongside isError (no mixed state)
 *
 * Additionally tests input-validation error paths (bad args → toolError
 * before any DB call).
 */

import { describe, it, expect, vi } from 'vitest';
import { chefbyteTools } from '../chefbyte/index';
import { coachbyteTools } from '../coachbyte/index';
import { toolError } from '../shared';
import type { ToolContext } from '../types';

// --------------------------------------------------------------------------
// A supabase context where every DB call returns an error
// --------------------------------------------------------------------------

function makeErrorCtx(userId = 'user-test'): ToolContext {
  const dbError = { message: 'simulated DB failure', code: '42P01' };

  const chainFails = () => {
    const t: any = {};
    for (const m of [
      'select',
      'eq',
      'is',
      'order',
      'limit',
      'update',
      'insert',
      'not',
      'ilike',
      'gt',
      'neq',
      'in',
      'lte',
      'gte',
      'delete',
      'or',
      'filter',
      'range',
      'returns',
    ]) {
      t[m] = vi.fn(() => t);
    }
    t.single = vi.fn(() => Promise.resolve({ data: null, error: dbError }));
    t.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: dbError }));
    t.then = (resolve: (v: any) => void) => resolve({ data: null, error: dbError });
    return t;
  };

  const supabase: any = {
    schema: vi.fn(() => ({
      from: vi.fn(() => chainFails()),
      rpc: vi.fn(() => Promise.resolve({ data: null, error: dbError })),
    })),
    from: vi.fn(() => chainFails()),
    rpc: vi.fn(() => Promise.resolve({ data: null, error: dbError })),
    // Chained schema access (some tools use ctx.supabase.schema('x').from())
    // already handled above via schema() returning an object with from/rpc.
  };

  return { userId, supabase };
}

// --------------------------------------------------------------------------
// A supabase context where every DB call SUCCEEDS.
//
// This is the counterpart to makeErrorCtx and is what makes the convention
// test real rather than tautological. makeErrorCtx forces every handler down
// its error branch, so the isError assertions there only prove "the error
// wrapper has the isError shape" — they would stay green even if a handler's
// entire body were `return toolError('boom')`. The positive cases below feed
// each handler a VALID call + a success-returning mock and assert it reaches
// its SUCCESS branch (isError falsy + expected data surfaced). The PAIR
// (success-on-valid + isError-on-failure) is the actual guard.
//
// rowData    — returned by every chain terminal (.single/.maybeSingle/await).
//              It is the UNION of fields the table-pattern handlers read off a
//              row, so one fixture serves them all.
// rpcData    — returned by .rpc(). Per-handler because the post-processing
//              differs (complete_next_set expects an array row with
//              completed=true; log_set's ensure_daily_plan_admin expects
//              { plan_id }; consume/mark_done pass the value straight through).
// --------------------------------------------------------------------------

const SUCCESS_ROW = {
  // add_stock (existing-lot lookup + merge update) / log_set insert
  lot_id: 'lot-1',
  qty_containers: 3,
  expires_on: null,
  location_id: 'loc-1',
  completed_set_id: 'cset-1',
  completed_at: '2026-06-14T12:00:00Z',
  // create_recipe / create_product / update_product / set_price
  recipe_id: 'rec-1',
  product_id: 'prod-1',
  name: 'Mock Row',
  barcode: null,
  base_servings: 2,
  active_time: null,
  total_time: null,
  instructions: null,
  price: 2.99,
  // add_meal
  meal_id: 'meal-1',
  logical_date: '2026-06-14',
  meal_prep: false,
  servings: 1,
  // update_summary
  plan_id: 'plan-1',
  summary: 'Good session',
};

function makeSuccessCtx(rpcData: unknown = SUCCESS_ROW, userId = 'user-test'): ToolContext {
  const chainOk = () => {
    const t: any = {};
    for (const m of [
      'select',
      'eq',
      'is',
      'order',
      'limit',
      'update',
      'insert',
      'not',
      'ilike',
      'gt',
      'neq',
      'in',
      'lte',
      'gte',
      'delete',
      'or',
      'filter',
      'range',
      'returns',
    ]) {
      t[m] = vi.fn(() => t);
    }
    t.single = vi.fn(() => Promise.resolve({ data: SUCCESS_ROW, error: null }));
    t.maybeSingle = vi.fn(() => Promise.resolve({ data: SUCCESS_ROW, error: null }));
    // Awaited-directly chains (e.g. recipe_ingredients.insert(...), .or(...))
    // resolve to a non-empty success list.
    t.then = (resolve: (v: any) => void) => resolve({ data: [SUCCESS_ROW], error: null });
    return t;
  };

  const supabase: any = {
    schema: vi.fn(() => ({
      from: vi.fn(() => chainOk()),
      rpc: vi.fn(() => Promise.resolve({ data: rpcData, error: null })),
    })),
    from: vi.fn(() => chainOk()),
    rpc: vi.fn(() => Promise.resolve({ data: rpcData, error: null })),
  };

  return { userId, supabase };
}

// --------------------------------------------------------------------------
// Minimal valid args for each tool (enough to pass input validation)
// --------------------------------------------------------------------------

const VALID_CHEF_ARGS: Record<string, unknown> = {
  CHEFBYTE_get_inventory: {},
  CHEFBYTE_get_product_lots: { product_id: 'prod-1' },
  CHEFBYTE_add_stock: { product_id: 'prod-1', qty_containers: 1, location_id: 'loc-1' },
  CHEFBYTE_consume: { product_id: 'prod-1', qty: 1, unit: 'container' },
  CHEFBYTE_get_products: {},
  CHEFBYTE_create_product: { name: 'Test Product', servings_per_container: 1 },
  CHEFBYTE_update_product: { product_id: 'prod-1' },
  CHEFBYTE_get_shopping_list: {},
  CHEFBYTE_add_to_shopping: { product_id: 'prod-1', qty_containers: 1 },
  CHEFBYTE_toggle_purchased: { item_id: 'item-1' },
  CHEFBYTE_delete_shopping_item: { item_id: 'item-1' },
  CHEFBYTE_clear_shopping: {},
  CHEFBYTE_import_shopping_to_inventory: { location_id: 'loc-1' },
  CHEFBYTE_below_min_stock: {},
  CHEFBYTE_get_meal_plan: {},
  CHEFBYTE_add_meal: { recipe_id: 'rec-1', servings: 1 },
  CHEFBYTE_delete_meal_entry: { meal_id: 'meal-1' },
  CHEFBYTE_mark_done: { meal_id: 'meal-1' },
  CHEFBYTE_get_recipes: {},
  CHEFBYTE_get_cookable: {},
  CHEFBYTE_create_recipe: {
    name: 'Test Recipe',
    base_servings: 2,
    ingredients: [{ product_id: 'prod-1', quantity: 1, unit: 'container' }],
  },
  CHEFBYTE_get_macros: {},
  CHEFBYTE_log_temp_item: { name: 'Coffee', calories: 5, carbs: 0, protein: 0, fat: 0 },
  CHEFBYTE_set_price: { product_id: 'prod-1', price: 2.99 },
  CHEFBYTE_delete_food_log: { log_id: 'log-1' },
  CHEFBYTE_delete_temp_item: { temp_id: 'tmp-1' },
  CHEFBYTE_delete_recipe: { recipe_id: 'rec-1' },
  CHEFBYTE_delete_product: { product_id: 'prod-1' },
};

const VALID_COACH_ARGS: Record<string, unknown> = {
  COACHBYTE_get_today_plan: {},
  COACHBYTE_complete_next_set: {},
  COACHBYTE_log_set: { exercise_id: 'ex-1', actual_reps: 5, actual_load: 185 },
  COACHBYTE_delete_completed_set: { set_id: 'set-1' },
  COACHBYTE_update_plan: { sets: [] },
  COACHBYTE_update_summary: { summary: 'Good session' },
  COACHBYTE_get_history: {},
  COACHBYTE_get_split: {},
  COACHBYTE_update_split: {
    weekday: 1,
    template_sets: [{ exercise_id: 'ex-1', target_reps: 5, load: 185, rest_seconds: 90 }],
  },
  COACHBYTE_set_timer: { duration_seconds: 90 },
  COACHBYTE_get_timer: {},
  COACHBYTE_pause_timer: {},
  COACHBYTE_resume_timer: {},
  COACHBYTE_reset_timer: {},
  COACHBYTE_get_prs: {},
  COACHBYTE_get_exercises: {},
};

// --------------------------------------------------------------------------
// Helper: assert isError shape
// --------------------------------------------------------------------------

function assertIsError(result: any, toolName: string) {
  expect(result, `${toolName}: handler must return a result`).toBeDefined();
  expect(result.isError, `${toolName}: error result must have isError=true (got isError=${result.isError})`).toBe(true);
  expect(Array.isArray(result.content), `${toolName}: result.content must be an array`).toBe(true);
  expect(result.content.length, `${toolName}: result.content must be non-empty`).toBeGreaterThan(0);
  const text = result.content[0]?.text;
  expect(
    typeof text === 'string' && text.length > 0,
    `${toolName}: content[0].text must be a non-empty string (got ${JSON.stringify(text)})`,
  ).toBe(true);
}

/**
 * Assert a SUCCESS shape: isError must be falsy (undefined per the toolSuccess
 * helper, never true) and content[0].text must contain every expected
 * substring. The substring check is what makes this catch a body swapped to
 * `return toolError('boom')`: a forced error would (a) set isError=true and
 * (b) put the error message in content[0].text, so the expected success
 * fragments would be absent — failing on both counts.
 */
function assertIsSuccess(result: any, toolName: string, expectedSubstrings: string[]) {
  expect(result, `${toolName}: handler must return a result`).toBeDefined();
  expect(
    result.isError,
    `${toolName}: valid call must NOT be an error (got isError=${result.isError}, text=${JSON.stringify(
      result?.content?.[0]?.text,
    )})`,
  ).not.toBe(true);
  expect(Array.isArray(result.content), `${toolName}: result.content must be an array`).toBe(true);
  const text = result.content[0]?.text;
  expect(typeof text === 'string' && text.length > 0, `${toolName}: content[0].text must be a non-empty string`).toBe(
    true,
  );
  for (const sub of expectedSubstrings) {
    expect(text.includes(sub), `${toolName}: success output must surface "${sub}" (got ${JSON.stringify(text)})`).toBe(
      true,
    );
  }
}

// =========================================================================
// ChefByte tool error paths
// =========================================================================

describe('spec: CHEFBYTE tools return isError:true on DB failure', () => {
  for (const [toolName, args] of Object.entries(VALID_CHEF_ARGS)) {
    it(`${toolName} → isError on DB error`, async () => {
      const tool = chefbyteTools[toolName];
      if (!tool) throw new Error(`Tool not found: ${toolName}`);
      const result = await tool.handler(args as any, makeErrorCtx());
      assertIsError(result, toolName);
    });
  }
});

// =========================================================================
// CoachByte tool error paths
// =========================================================================

describe('spec: COACHBYTE tools return isError:true on DB failure', () => {
  for (const [toolName, args] of Object.entries(VALID_COACH_ARGS)) {
    it(`${toolName} → isError on DB error`, async () => {
      const tool = coachbyteTools[toolName];
      if (!tool) throw new Error(`Tool not found: ${toolName}`);
      const result = await tool.handler(args as any, makeErrorCtx());
      assertIsError(result, toolName);
    });
  }
});

// =========================================================================
// Positive (success-path) assertions — the half that makes this test REAL.
//
// Each case feeds a VALID call + makeSuccessCtx (every DB call succeeds) and
// asserts the handler reaches its SUCCESS branch: isError falsy AND the
// expected payload surfaced. Without these, replacing any handler body with
// `return toolError('boom')` would leave the suite green (makeErrorCtx never
// reaches the success branch). With them, that swap fails here.
//
// Scope: a representative high-value subset — the mutations across BOTH query
// patterns (RPC-based: consume/mark_done/complete_next_set; table
// insert/update: add_stock/add_meal/create_recipe/create_product/
// update_product/update_summary/set_price/log_set). Read-only getters and the
// remaining delete/shopping handlers are intentionally out of scope here;
// their success paths are exercised by the live-DB integration suite
// (integration/chefbyte-tools.test.ts, coachbyte-tools.test.ts).
// =========================================================================

// A real UUID so resolveExerciseRef short-circuits (no name→id DB lookup).
const EX_UUID = '11111111-2222-3333-4444-555555555555';

describe('spec: CHEFBYTE mutations return SUCCESS on a valid call', () => {
  it('CHEFBYTE_consume → success surfaces RPC result', async () => {
    const ctx = makeSuccessCtx({ status: 'consumed', stock_remaining: 2 });
    const result = await chefbyteTools['CHEFBYTE_consume']!.handler(
      { product_id: 'prod-1', qty: 1, unit: 'container' } as any,
      ctx,
    );
    assertIsSuccess(result, 'CHEFBYTE_consume', ['consumed', 'stock_remaining']);
  });

  it('CHEFBYTE_add_stock → success surfaces added lot', async () => {
    const result = await chefbyteTools['CHEFBYTE_add_stock']!.handler(
      { product_id: 'prod-1', qty_containers: 1, location_id: 'loc-1' } as any,
      makeSuccessCtx(),
    );
    assertIsSuccess(result, 'CHEFBYTE_add_stock', ['Added 1 container(s)', 'lot-1']);
  });

  it('CHEFBYTE_add_meal → success surfaces created meal entry', async () => {
    const result = await chefbyteTools['CHEFBYTE_add_meal']!.handler(
      { recipe_id: 'rec-1', servings: 1, logical_date: '2026-06-14' } as any,
      makeSuccessCtx(),
    );
    assertIsSuccess(result, 'CHEFBYTE_add_meal', ['Meal plan entry added', 'meal-1']);
  });

  it('CHEFBYTE_create_recipe → success surfaces created recipe', async () => {
    const result = await chefbyteTools['CHEFBYTE_create_recipe']!.handler(
      {
        name: 'Test Recipe',
        base_servings: 2,
        ingredients: [{ product_id: 'prod-1', quantity: 1, unit: 'container' }],
      } as any,
      makeSuccessCtx(),
    );
    // Fragments avoid the embedded double-quote (JSON-escaped in the payload)
    // while still pinning the message + ingredient count.
    assertIsSuccess(result, 'CHEFBYTE_create_recipe', ['Test Recipe', 'created with 1 ingredient(s)']);
  });

  it('CHEFBYTE_create_product → success surfaces created product', async () => {
    const result = await chefbyteTools['CHEFBYTE_create_product']!.handler(
      { name: 'Test Product', servings_per_container: 1 } as any,
      makeSuccessCtx(),
    );
    assertIsSuccess(result, 'CHEFBYTE_create_product', ['Mock Row', 'created']);
  });

  it('CHEFBYTE_update_product → success surfaces updated product', async () => {
    const result = await chefbyteTools['CHEFBYTE_update_product']!.handler(
      { product_id: 'prod-1', name: 'Renamed' } as any,
      makeSuccessCtx(),
    );
    assertIsSuccess(result, 'CHEFBYTE_update_product', ['Mock Row', 'updated', 'fields_updated']);
  });

  it('CHEFBYTE_set_price → success surfaces new price', async () => {
    const result = await chefbyteTools['CHEFBYTE_set_price']!.handler(
      { product_id: 'prod-1', price: 2.99 } as any,
      makeSuccessCtx(),
    );
    assertIsSuccess(result, 'CHEFBYTE_set_price', ['set to $2.99']);
  });

  it('CHEFBYTE_mark_done → success surfaces RPC result', async () => {
    const ctx = makeSuccessCtx({ success: true, meal_id: 'meal-1', mode: 'regular', completed_at: 'now' });
    const result = await chefbyteTools['CHEFBYTE_mark_done']!.handler({ meal_id: 'meal-1' } as any, ctx);
    assertIsSuccess(result, 'CHEFBYTE_mark_done', ['regular', 'meal-1']);
  });
});

describe('spec: COACHBYTE mutations return SUCCESS on a valid call', () => {
  it('COACHBYTE_complete_next_set → success surfaces rest time', async () => {
    // RPC returns RETURNS TABLE(rest_seconds, completed) → row 0 with completed=true.
    const ctx = makeSuccessCtx([{ rest_seconds: 90, completed: true }]);
    const result = await coachbyteTools['COACHBYTE_complete_next_set']!.handler(
      { plan_id: 'plan-1', reps: 5, load: 185 } as any,
      ctx,
    );
    assertIsSuccess(result, 'COACHBYTE_complete_next_set', ['Set completed', '90']);
  });

  it('COACHBYTE_update_summary → success surfaces summary', async () => {
    const result = await coachbyteTools['COACHBYTE_update_summary']!.handler(
      { plan_id: 'plan-1', summary: 'Good session' } as any,
      makeSuccessCtx(),
    );
    assertIsSuccess(result, 'COACHBYTE_update_summary', ['Summary updated', 'Good session']);
  });

  it('COACHBYTE_log_set → success surfaces logged set', async () => {
    // ensure_daily_plan_admin RPC must return { plan_id }; the completed_sets
    // insert terminal returns SUCCESS_ROW (completed_set_id). exercise_id is a
    // UUID so resolveExerciseRef short-circuits without a name lookup.
    const ctx = makeSuccessCtx({ plan_id: 'plan-1' });
    const result = await coachbyteTools['COACHBYTE_log_set']!.handler(
      { exercise_id: EX_UUID, reps: 5, load: 185 } as any,
      ctx,
    );
    assertIsSuccess(result, 'COACHBYTE_log_set', ['Ad-hoc set logged', 'cset-1']);
  });
});

// =========================================================================
// Input-validation error paths (invalid args → isError before DB call)
// =========================================================================

describe('spec: isError on invalid input (no DB call needed)', () => {
  it('CHEFBYTE_consume: negative qty → isError', async () => {
    const tool = chefbyteTools['CHEFBYTE_consume']!;
    const result = await tool.handler({ product_id: 'p', qty: -1, unit: 'container' } as any, makeErrorCtx());
    assertIsError(result, 'CHEFBYTE_consume (negative qty)');
  });

  it('CHEFBYTE_consume: zero qty → isError', async () => {
    const tool = chefbyteTools['CHEFBYTE_consume']!;
    const result = await tool.handler({ product_id: 'p', qty: 0, unit: 'container' } as any, makeErrorCtx());
    assertIsError(result, 'CHEFBYTE_consume (zero qty)');
  });

  it('CHEFBYTE_consume: excessive qty → isError', async () => {
    const tool = chefbyteTools['CHEFBYTE_consume']!;
    const result = await tool.handler({ product_id: 'p', qty: 99999, unit: 'container' } as any, makeErrorCtx());
    assertIsError(result, 'CHEFBYTE_consume (excessive qty)');
  });

  it('CHEFBYTE_add_stock: non-positive qty_containers → isError', async () => {
    const tool = chefbyteTools['CHEFBYTE_add_stock']!;
    const result = await tool.handler(
      { product_id: 'p', qty_containers: 0, location_id: 'loc-1' } as any,
      makeErrorCtx(),
    );
    assertIsError(result, 'CHEFBYTE_add_stock (zero qty)');
  });
});

// =========================================================================
// isError shape invariant: no double-signaling
// =========================================================================

describe('spec: isError does not co-exist with success data', () => {
  it('toolError helper sets isError=true with no extra properties', () => {
    const result = toolError('something went wrong');
    expect(result.isError).toBe(true);
    expect(result.content).toBeDefined();
    expect(result.content[0].text).toBe('something went wrong');
    // There should be no 'data' field on an error result
    expect((result as any).data).toBeUndefined();
  });
});
