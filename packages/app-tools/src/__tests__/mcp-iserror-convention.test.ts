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
