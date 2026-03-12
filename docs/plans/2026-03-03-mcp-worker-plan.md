# Phase 9: MCP Worker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the MCP Worker (Cloudflare Workers + Durable Objects) with SSE transport, API key auth, 30 app tools (11 CoachByte + 19 ChefByte), and 11 extension tools.

**Architecture:** Tool handlers are pure async functions in `packages/app-tools/` — testable with vitest. The MCP Worker (`apps/mcp-worker/`) imports them and wires them into a JSON-RPC 2.0 over SSE protocol. Service-role Supabase client bypasses RLS; admin RPC wrappers pass explicit user_id to private functions.

**Tech Stack:** Cloudflare Workers, Durable Objects, `@supabase/supabase-js`, SSE (Server-Sent Events), JSON-RPC 2.0.

---

## Important: Service Role + auth.uid()

The MCP Worker authenticates via API key (not JWT). It uses a service-role Supabase client which bypasses RLS but makes `auth.uid()` return NULL. Existing public RPC wrappers (`chefbyte.consume_product`, etc.) use `auth.uid()` internally and would fail.

**Solution:** Create admin variants of the 5 key RPC functions that accept explicit `p_user_id`. These delegate to the same `private.*` functions. Granted only to `service_role`.

For simple CRUD: use service-role client with direct table queries + `.eq('user_id', userId)`.

---

### Task 1: DB Migration — Service-role RPC wrappers

**Files:**

- Create: `supabase/migrations/20260303050000_service_role_wrappers.sql`

**The migration:**

```sql
-- Service-role wrappers for MCP Worker
-- These accept explicit user_id (auth.uid() is NULL with service role key)
-- Granted only to service_role, not authenticated

-- CoachByte
CREATE OR REPLACE FUNCTION coachbyte.ensure_daily_plan_admin(
  p_user_id UUID,
  p_day DATE
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.ensure_daily_plan(p_user_id, p_day);
$$;
GRANT EXECUTE ON FUNCTION coachbyte.ensure_daily_plan_admin(UUID, DATE) TO service_role;

CREATE OR REPLACE FUNCTION coachbyte.complete_next_set_admin(
  p_user_id UUID,
  p_plan_id UUID,
  p_reps INTEGER,
  p_load NUMERIC
)
RETURNS TABLE(rest_seconds INTEGER)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM private.complete_next_set(p_user_id, p_plan_id, p_reps, p_load);
$$;
GRANT EXECUTE ON FUNCTION coachbyte.complete_next_set_admin(UUID, UUID, INTEGER, NUMERIC) TO service_role;

-- ChefByte
CREATE OR REPLACE FUNCTION chefbyte.consume_product_admin(
  p_user_id UUID,
  p_product_id UUID,
  p_qty NUMERIC,
  p_unit TEXT,
  p_log_macros BOOLEAN,
  p_logical_date DATE
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.consume_product(p_user_id, p_product_id, p_qty, p_unit, p_log_macros, p_logical_date);
$$;
GRANT EXECUTE ON FUNCTION chefbyte.consume_product_admin(UUID, UUID, NUMERIC, TEXT, BOOLEAN, DATE) TO service_role;

CREATE OR REPLACE FUNCTION chefbyte.mark_meal_done_admin(
  p_user_id UUID,
  p_meal_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.mark_meal_done(p_user_id, p_meal_id);
$$;
GRANT EXECUTE ON FUNCTION chefbyte.mark_meal_done_admin(UUID, UUID) TO service_role;

CREATE OR REPLACE FUNCTION chefbyte.get_daily_macros_admin(
  p_user_id UUID,
  p_logical_date DATE
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.get_daily_macros(p_user_id, p_logical_date);
$$;
GRANT EXECUTE ON FUNCTION chefbyte.get_daily_macros_admin(UUID, DATE) TO service_role;
```

**Verify:** `cd /tmp && npx -y supabase --workdir /home/jeremy/luna-hub-lite db push` then `supabase test db`

**Commit:** `feat(db): service-role RPC wrappers for MCP Worker`

---

### Task 2: Tool types and shared utilities

**Files:**

- Create: `packages/app-tools/src/types.ts`
- Create: `packages/app-tools/src/shared/index.ts`
- Modify: `packages/app-tools/src/index.ts`

**types.ts:**

```typescript
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  userId: string;
  supabase: any; // SupabaseClient with service role
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ExtensionToolDefinition extends ToolDefinition {
  extensionName: string;
}

export interface ExtensionToolContext extends ToolContext {
  credentials: Record<string, string>;
}
```

**shared/index.ts:**

```typescript
import type { ToolResult } from '../types';

export function toolSuccess(data: unknown): ToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

export function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Get today's logical date for a user (same logic as private.get_logical_date) */
export async function getLogicalDate(supabase: any, userId: string): Promise<string> {
  const { data: profile } = await supabase
    .schema('hub')
    .from('profiles')
    .select('timezone, day_start_hour')
    .eq('user_id', userId)
    .single();

  const tz = profile?.timezone || 'America/New_York';
  const dayStart = profile?.day_start_hour ?? 6;
  const now = new Date();
  const localDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  const localHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(now),
  );
  return localHour < dayStart
    ? new Date(new Date(localDateStr).getTime() - 86400000).toISOString().slice(0, 10)
    : localDateStr;
}
```

**index.ts (updated):**

```typescript
export type { ToolDefinition, ToolContext, ToolResult, ExtensionToolDefinition, ExtensionToolContext } from './types';
export { toolSuccess, toolError, getLogicalDate } from './shared';
export { coachbyteTools } from './coachbyte';
export { chefbyteTools } from './chefbyte';
```

---

### Task 3: CoachByte tool handlers (11 tools)

**Files:**

- Create: `packages/app-tools/src/coachbyte/get-today-plan.ts` (and 10 more)
- Modify: `packages/app-tools/src/coachbyte/index.ts`

Each tool follows this pattern:

```typescript
import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const COACHBYTE_tool_name: ToolDefinition = {
  name: 'COACHBYTE_tool_name',
  description: 'What it does',
  inputSchema: {
    type: 'object',
    properties: {
      /* JSON Schema */
    },
    required: ['...'],
  },
  handler: async (args, ctx) => {
    // Query ctx.supabase with .schema('coachbyte')
    // Use ctx.userId for user scoping
    // Return toolSuccess(data) or toolError(msg)
  },
};
```

**Full handler implementations for all 11 CoachByte tools:**

#### get-today-plan.ts

```typescript
import type { ToolDefinition } from '../types';
import { toolSuccess, toolError, getLogicalDate } from '../shared';

export const COACHBYTE_get_today_plan: ToolDefinition = {
  name: 'COACHBYTE_get_today_plan',
  description:
    "Get today's workout plan with all planned and completed sets. Creates plan from weekly split if none exists.",
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    const today = await getLogicalDate(ctx.supabase, ctx.userId);

    // Ensure plan exists (creates from split if needed)
    const { data: planResult, error: planError } = await ctx.supabase
      .schema('coachbyte')
      .rpc('ensure_daily_plan_admin', { p_user_id: ctx.userId, p_day: today });

    if (planError) return toolError(`Failed to ensure plan: ${planError.message}`);

    const planId = planResult?.plan_id;
    if (!planId) return toolSuccess({ plan_date: today, sets: [], summary: null });

    // Fetch plan with sets
    const { data: plan } = await ctx.supabase
      .schema('coachbyte')
      .from('daily_plans')
      .select('plan_id, plan_date, summary')
      .eq('plan_id', planId)
      .single();

    const { data: planned } = await ctx.supabase
      .schema('coachbyte')
      .from('planned_sets')
      .select('planned_set_id, exercise_id, target_reps, target_load, rest_seconds, "order", exercises(name)')
      .eq('plan_id', planId)
      .order('"order"', { ascending: true });

    const { data: completed } = await ctx.supabase
      .schema('coachbyte')
      .from('completed_sets')
      .select('completed_set_id, planned_set_id, exercise_id, actual_reps, actual_load, completed_at, exercises(name)')
      .eq('plan_id', planId)
      .order('completed_at', { ascending: true });

    const completedSetIds = new Set((completed || []).map((c: any) => c.planned_set_id));

    const sets = (planned || []).map((ps: any) => ({
      planned_set_id: ps.planned_set_id,
      exercise: ps.exercises?.name,
      exercise_id: ps.exercise_id,
      target_reps: ps.target_reps,
      target_load: ps.target_load,
      rest_seconds: ps.rest_seconds,
      order: ps.order,
      completed: completedSetIds.has(ps.planned_set_id),
      actual: (completed || []).find((c: any) => c.planned_set_id === ps.planned_set_id) || null,
    }));

    return toolSuccess({
      plan_id: plan?.plan_id,
      plan_date: plan?.plan_date,
      summary: plan?.summary,
      sets,
      total_sets: sets.length,
      completed_sets: sets.filter((s: any) => s.completed).length,
    });
  },
};
```

#### complete-next-set.ts

```typescript
import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const COACHBYTE_complete_next_set: ToolDefinition = {
  name: 'COACHBYTE_complete_next_set',
  description: "Complete the next incomplete set in today's plan. Returns rest time for next set.",
  inputSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: 'Plan UUID (from get_today_plan)' },
      reps: { type: 'integer', description: 'Actual reps performed' },
      load: { type: 'number', description: 'Actual load in lbs' },
    },
    required: ['plan_id', 'reps', 'load'],
  },
  handler: async (args, ctx) => {
    const { data, error } = await ctx.supabase.schema('coachbyte').rpc('complete_next_set_admin', {
      p_user_id: ctx.userId,
      p_plan_id: args.plan_id,
      p_reps: args.reps,
      p_load: args.load,
    });

    if (error) return toolError(`Failed to complete set: ${error.message}`);
    if (!data || data.length === 0) return toolError("No remaining sets in today's plan");

    const restSeconds = data[0]?.rest_seconds;
    return toolSuccess({
      completed: true,
      rest_seconds: restSeconds,
      message:
        restSeconds != null
          ? `Set completed. Rest ${restSeconds}s before next set.`
          : 'Set completed. No more sets in plan.',
    });
  },
};
```

#### log-set.ts

```typescript
import type { ToolDefinition } from '../types';
import { toolSuccess, toolError, getLogicalDate } from '../shared';

export const COACHBYTE_log_set: ToolDefinition = {
  name: 'COACHBYTE_log_set',
  description: "Log an ad-hoc completed set (not part of today's plan).",
  inputSchema: {
    type: 'object',
    properties: {
      exercise_id: { type: 'string', description: 'Exercise UUID' },
      reps: { type: 'integer', description: 'Reps performed' },
      load: { type: 'number', description: 'Load in lbs' },
    },
    required: ['exercise_id', 'reps', 'load'],
  },
  handler: async (args, ctx) => {
    const today = await getLogicalDate(ctx.supabase, ctx.userId);

    // Ensure a plan exists for today (needed for plan_id FK)
    const { data: planResult } = await ctx.supabase
      .schema('coachbyte')
      .rpc('ensure_daily_plan_admin', { p_user_id: ctx.userId, p_day: today });

    const planId = planResult?.plan_id;
    if (!planId) return toolError('Could not create plan for today');

    const { error } = await ctx.supabase.schema('coachbyte').from('completed_sets').insert({
      plan_id: planId,
      user_id: ctx.userId,
      exercise_id: args.exercise_id,
      actual_reps: args.reps,
      actual_load: args.load,
      logical_date: today,
    });

    if (error) return toolError(`Failed to log set: ${error.message}`);
    return toolSuccess({ logged: true, exercise_id: args.exercise_id, reps: args.reps, load: args.load });
  },
};
```

#### Remaining CoachByte tools (brief — follow same pattern)

**update-plan.ts** — Insert/update `planned_sets` for a plan_id. Args: `plan_id`, `sets: [{exercise_id, target_reps, target_load, rest_seconds, order}]`. Deletes existing planned_sets, inserts new ones.

**update-summary.ts** — Update `daily_plans.summary`. Args: `plan_id`, `summary: string`. Simple `.update({summary}).eq('plan_id', planId).eq('user_id', userId)`.

**get-history.ts** — Query `daily_plans` + `completed_sets` for last N days. Args: `days: integer` (default 7). Join exercises for names.

**get-split.ts** — Query `splits` for all weekdays. Args: none or `weekday: integer`. Return template_sets with exercise names resolved.

**update-split.ts** — Replace `splits.template_sets` for a weekday. Args: `weekday: integer`, `sets: [{exercise_id, target_reps, target_load, target_load_percentage, rest_seconds}]`. Upsert on (user_id, weekday).

**set-timer.ts** — Upsert `timers`. Args: `duration_seconds: integer`. Set state='running', end_time=now()+duration.

**get-timer.ts** — Query `timers` for user. Compute remaining seconds from end_time vs now. Return {state, remaining_seconds, duration_seconds}.

**get-prs.ts** — Query `completed_sets` grouped by exercise. For each exercise, compute Epley 1RM from each set: `load * (1 + reps/30)`. Return top 1RM per exercise, plus derived 1RM-10RM table.

**coachbyte/index.ts (updated):**

```typescript
import type { ToolDefinition } from '../types';
import { COACHBYTE_get_today_plan } from './get-today-plan';
import { COACHBYTE_complete_next_set } from './complete-next-set';
import { COACHBYTE_log_set } from './log-set';
import { COACHBYTE_update_plan } from './update-plan';
import { COACHBYTE_update_summary } from './update-summary';
import { COACHBYTE_get_history } from './get-history';
import { COACHBYTE_get_split } from './get-split';
import { COACHBYTE_update_split } from './update-split';
import { COACHBYTE_set_timer } from './set-timer';
import { COACHBYTE_get_timer } from './get-timer';
import { COACHBYTE_get_prs } from './get-prs';

export const coachbyteTools: Record<string, ToolDefinition> = {
  COACHBYTE_get_today_plan,
  COACHBYTE_complete_next_set,
  COACHBYTE_log_set,
  COACHBYTE_update_plan,
  COACHBYTE_update_summary,
  COACHBYTE_get_history,
  COACHBYTE_get_split,
  COACHBYTE_update_split,
  COACHBYTE_set_timer,
  COACHBYTE_get_timer,
  COACHBYTE_get_prs,
};
```

---

### Task 4: CoachByte tool tests

**Files:**

- Create: `packages/app-tools/src/__tests__/coachbyte.test.ts`

Test each handler with a mocked Supabase client. Verify correct schema/table/RPC calls, correct args passed, correct response format (toolSuccess/toolError). ~2-3 tests per tool.

**Test pattern:**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { COACHBYTE_get_today_plan } from '../coachbyte/get-today-plan';

// Mock supabase chain (same pattern as web app tests)
const mockChain: any = {};
const chainMethods = [
  'select',
  'eq',
  'neq',
  'order',
  'single',
  'insert',
  'update',
  'delete',
  'upsert',
  'in',
  'is',
  'limit',
  'gte',
  'lte',
];
chainMethods.forEach((m) => {
  mockChain[m] = vi.fn(() => mockChain);
});

const mockRpc = vi.fn();
const mockFrom = vi.fn(() => mockChain);
const mockSchema = vi.fn(() => ({ from: mockFrom, rpc: mockRpc }));
const mockSupabase = { schema: mockSchema };

const ctx = { userId: 'user-1', supabase: mockSupabase };
```

---

### Task 5: ChefByte tool handlers (19 tools)

**Files:**

- Create: `packages/app-tools/src/chefbyte/*.ts` (19 files)
- Modify: `packages/app-tools/src/chefbyte/index.ts`

Same pattern as CoachByte. Key handlers:

#### get-inventory.ts (representative)

```typescript
import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const CHEFBYTE_get_inventory: ToolDefinition = {
  name: 'CHEFBYTE_get_inventory',
  description: 'Get current inventory grouped by product with total stock, nearest expiry, and lot count.',
  inputSchema: {
    type: 'object',
    properties: {
      include_lots: { type: 'boolean', description: 'Include individual lot details (default false)' },
    },
  },
  handler: async (args, ctx) => {
    const { data: lots, error } = await ctx.supabase
      .schema('chefbyte')
      .from('stock_lots')
      .select(
        'lot_id, product_id, location_id, qty_containers, expires_on, products(name, servings_per_container), locations(name)',
      )
      .eq('user_id', ctx.userId)
      .order('expires_on', { ascending: true, nullsFirst: false });

    if (error) return toolError(`Failed to fetch inventory: ${error.message}`);

    // Group by product
    const grouped: Record<string, any> = {};
    for (const lot of lots || []) {
      const pid = lot.product_id;
      if (!grouped[pid]) {
        grouped[pid] = {
          product_id: pid,
          name: lot.products?.name,
          total_containers: 0,
          nearest_expiry: null,
          lot_count: 0,
          lots: [],
        };
      }
      grouped[pid].total_containers += lot.qty_containers;
      grouped[pid].lot_count += 1;
      if (lot.expires_on && (!grouped[pid].nearest_expiry || lot.expires_on < grouped[pid].nearest_expiry)) {
        grouped[pid].nearest_expiry = lot.expires_on;
      }
      if (args.include_lots) {
        grouped[pid].lots.push({
          lot_id: lot.lot_id,
          location: lot.locations?.name,
          qty_containers: lot.qty_containers,
          expires_on: lot.expires_on,
        });
      }
    }

    const inventory = Object.values(grouped);
    if (!args.include_lots) inventory.forEach((p: any) => delete p.lots);

    return toolSuccess({ count: inventory.length, products: inventory });
  },
};
```

#### consume.ts (uses admin RPC)

```typescript
import type { ToolDefinition } from '../types';
import { toolSuccess, toolError, getLogicalDate } from '../shared';

export const CHEFBYTE_consume: ToolDefinition = {
  name: 'CHEFBYTE_consume',
  description: 'Consume product stock (nearest-expiration-first depletion). Optionally log macros.',
  inputSchema: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'Product UUID' },
      qty: { type: 'number', description: 'Quantity to consume' },
      unit: { type: 'string', enum: ['container', 'serving'], description: 'Unit of quantity' },
      log_macros: { type: 'boolean', description: 'Log macros for this consumption (default true)' },
    },
    required: ['product_id', 'qty', 'unit'],
  },
  handler: async (args, ctx) => {
    const logicalDate = await getLogicalDate(ctx.supabase, ctx.userId);
    const { data, error } = await ctx.supabase.schema('chefbyte').rpc('consume_product_admin', {
      p_user_id: ctx.userId,
      p_product_id: args.product_id,
      p_qty: args.qty,
      p_unit: args.unit,
      p_log_macros: args.log_macros ?? true,
      p_logical_date: logicalDate,
    });

    if (error) return toolError(`Consume failed: ${error.message}`);
    return toolSuccess(data);
  },
};
```

#### Remaining ChefByte tools (brief — each is a simple query or RPC call)

| Tool                | Logic                                                                             |
| ------------------- | --------------------------------------------------------------------------------- |
| `get_product_lots`  | `stock_lots.select(...).eq('product_id', args.product_id).eq('user_id', userId)`  |
| `add_stock`         | Upsert `stock_lots` on merge key (user+product+location+expiry)                   |
| `get_products`      | `products.select(*).eq('user_id', userId)` with optional `.ilike('name', search)` |
| `create_product`    | Insert into `products` with all fields from args                                  |
| `get_shopping_list` | `shopping_list.select(*, products(name, price))`                                  |
| `add_to_shopping`   | Upsert `shopping_list` on (user_id, product_id)                                   |
| `clear_shopping`    | `shopping_list.delete().eq('user_id', userId)`                                    |
| `below_min_stock`   | Query products + stock sums, compare, auto-add deficit                            |
| `get_meal_plan`     | `meal_plan_entries.select(*, recipes(name), products(name))` for date range       |
| `add_meal`          | Insert `meal_plan_entries`                                                        |
| `mark_done`         | `rpc('mark_meal_done_admin', {p_user_id, p_meal_id})`                             |
| `get_recipes`       | `recipes.select(*, recipe_ingredients(*, products(name)))`                        |
| `get_cookable`      | Compare recipe ingredients vs stock sums                                          |
| `create_recipe`     | Insert `recipes` + `recipe_ingredients` in sequence                               |
| `get_macros`        | `rpc('get_daily_macros_admin', {p_user_id, p_logical_date})`                      |
| `log_temp_item`     | Insert into `temp_items`                                                          |
| `set_price`         | `products.update({price}).eq('product_id', productId)`                            |

---

### Task 6: ChefByte tool tests

**Files:**

- Create: `packages/app-tools/src/__tests__/chefbyte.test.ts`

Same mock pattern as CoachByte tests. Test representative tools: get_inventory, consume, get_macros, create_product, add_stock.

---

### Task 7: MCP Worker — Protocol, Auth, SSE

**Files:**

- Modify: `apps/mcp-worker/src/index.ts`
- Create: `apps/mcp-worker/src/protocol.ts`
- Create: `apps/mcp-worker/src/auth.ts`
- Create: `apps/mcp-worker/src/session.ts`
- Create: `apps/mcp-worker/src/registry.ts`
- Create: `apps/mcp-worker/src/supabase.ts`

#### protocol.ts

```typescript
// JSON-RPC 2.0 types for MCP protocol
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function jsonRpcSuccess(id: string | number | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function jsonRpcError(id: string | number | undefined, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
```

#### auth.ts

```typescript
export async function authenticateApiKey(supabase: any, apiKey: string): Promise<string | null> {
  // SHA-256 hash the key
  const data = new TextEncoder().encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const keyHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  // Look up in hub.api_keys
  const { data: keyRow, error } = await supabase
    .schema('hub')
    .from('api_keys')
    .select('user_id')
    .eq('api_key_hash', keyHash)
    .is('revoked_at', null)
    .single();

  if (error || !keyRow) return null;
  return keyRow.user_id;
}
```

#### supabase.ts

```typescript
import { createClient } from '@supabase/supabase-js';

export function createServiceClient(env: { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}
```

#### registry.ts

```typescript
import type { ToolDefinition } from '@luna-hub/app-tools';
import { coachbyteTools, chefbyteTools } from '@luna-hub/app-tools';

const allTools: Record<string, ToolDefinition> = {
  ...coachbyteTools,
  ...chefbyteTools,
};

/** Build per-user tool set based on active modules and tool config */
export async function buildUserTools(supabase: any, userId: string): Promise<Record<string, ToolDefinition>> {
  // 1. Get active app modules
  const { data: activations } = await supabase
    .schema('hub')
    .from('app_activations')
    .select('app_name')
    .eq('user_id', userId);

  const activeApps = new Set((activations || []).map((a: any) => a.app_name));

  // 2. Get disabled tools
  const { data: toolConfig } = await supabase
    .schema('hub')
    .from('user_tool_config')
    .select('tool_name, enabled')
    .eq('user_id', userId)
    .eq('enabled', false);

  const disabledTools = new Set((toolConfig || []).map((t: any) => t.tool_name));

  // 3. Filter tools
  const userTools: Record<string, ToolDefinition> = {};
  for (const [name, tool] of Object.entries(allTools)) {
    // Check module is active
    const module = name.startsWith('COACHBYTE_') ? 'coachbyte' : name.startsWith('CHEFBYTE_') ? 'chefbyte' : null;
    if (module && !activeApps.has(module)) continue;

    // Check tool not disabled
    if (disabledTools.has(name)) continue;

    userTools[name] = tool;
  }

  return userTools;
}
```

#### session.ts (Durable Object)

```typescript
import type { ToolDefinition, ToolContext } from '@luna-hub/app-tools';
import { JsonRpcRequest, jsonRpcSuccess, jsonRpcError, sseEvent, McpToolSchema } from './protocol';
import { buildUserTools } from './registry';

interface Env {
  MCP_SESSION: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export class McpSession implements DurableObject {
  private userId: string = '';
  private tools: Record<string, ToolDefinition> = {};
  private sseController: ReadableStreamDefaultController | null = null;
  private supabase: any = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/sse') {
      return this.handleSseConnect(request, url);
    }

    if (url.pathname === '/message' && request.method === 'POST') {
      return this.handleMessage(request);
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleSseConnect(request: Request, url: URL): Promise<Response> {
    this.userId = url.searchParams.get('userId') || '';
    this.supabase = (await import('./supabase')).createServiceClient(this.env);
    this.tools = await buildUserTools(this.supabase, this.userId);

    const sessionId = this.state.id.toString();

    const stream = new ReadableStream({
      start: (controller) => {
        this.sseController = controller;
        // Send endpoint message
        controller.enqueue(new TextEncoder().encode(sseEvent('endpoint', `/message?sessionId=${sessionId}`)));
      },
      cancel: () => {
        this.sseController = null;
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  private async handleMessage(request: Request): Promise<Response> {
    const rpc: JsonRpcRequest = await request.json();

    let response;
    switch (rpc.method) {
      case 'initialize':
        response = jsonRpcSuccess(rpc.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'luna-hub-mcp', version: '1.0.0' },
        });
        break;

      case 'notifications/initialized':
        return new Response('', { status: 202 }); // No response for notifications

      case 'tools/list':
        response = jsonRpcSuccess(rpc.id, {
          tools: Object.values(this.tools).map(
            (t): McpToolSchema => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            }),
          ),
        });
        break;

      case 'tools/call': {
        const toolName = (rpc.params as any)?.name;
        const toolArgs = (rpc.params as any)?.arguments || {};
        const tool = this.tools[toolName];

        if (!tool) {
          response = jsonRpcSuccess(rpc.id, {
            content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
            isError: true,
          });
        } else {
          const toolCtx: ToolContext = { userId: this.userId, supabase: this.supabase };
          try {
            const result = await tool.handler(toolArgs, toolCtx);
            response = jsonRpcSuccess(rpc.id, result);
          } catch (err: any) {
            response = jsonRpcSuccess(rpc.id, {
              content: [{ type: 'text', text: `Tool error: ${err.message}` }],
              isError: true,
            });
          }
        }
        break;
      }

      default:
        response = jsonRpcError(rpc.id, -32601, `Method not found: ${rpc.method}`);
    }

    // Send response via SSE stream
    if (this.sseController && response) {
      this.sseController.enqueue(new TextEncoder().encode(sseEvent('message', response)));
    }

    return new Response('', { status: 202 });
  }
}
```

#### index.ts (Worker entrypoint)

```typescript
import { authenticateApiKey } from './auth';
import { createServiceClient } from './supabase';

export { McpSession } from './session';

export interface Env {
  MCP_SESSION: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response('ok');
    }

    // SSE connection: GET /sse?apiKey=xxx
    if (url.pathname === '/sse' && request.method === 'GET') {
      const apiKey = url.searchParams.get('apiKey');
      if (!apiKey) {
        return new Response(JSON.stringify({ error: 'Missing apiKey parameter' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const supabase = createServiceClient(env);
      const userId = await authenticateApiKey(supabase, apiKey);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid API key' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Route to Durable Object
      const id = env.MCP_SESSION.newUniqueId();
      const stub = env.MCP_SESSION.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = '/sse';
      doUrl.searchParams.set('userId', userId);
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // Message endpoint: POST /message?sessionId=xxx
    if (url.pathname === '/message' && request.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        return new Response(JSON.stringify({ error: 'Missing sessionId' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const id = env.MCP_SESSION.idFromString(sessionId);
      const stub = env.MCP_SESSION.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = '/message';
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return new Response('Not found', { status: 404 });
  },
};
```

**Commit after Task 7:** `feat(mcp): worker infrastructure — SSE, auth, session, registry`

---

### Task 8: Extension tools (11 tools across 3 extensions)

**Files:**

- Create: `extensions/obsidian/config.json` + `extensions/obsidian/tools/*.ts`
- Create: `extensions/todoist/config.json` + `extensions/todoist/tools/*.ts`
- Create: `extensions/homeassistant/config.json` + `extensions/homeassistant/tools/*.ts`

Extension handlers follow the `ExtensionToolDefinition` pattern. Each gets credentials from Vault via the worker before handler is called.

**Credential retrieval pattern (in worker session.ts, add to tools/call):**

```typescript
// For extension tools: fetch credentials first
if ('extensionName' in tool) {
  const { data: creds } = await this.supabase
    .schema('hub')
    .from('extension_settings')
    .select('credentials_encrypted')
    .eq('user_id', this.userId)
    .eq('extension_name', (tool as any).extensionName)
    .eq('enabled', true)
    .single();

  if (!creds?.credentials_encrypted) {
    result = toolError(`Configure ${(tool as any).extensionName} credentials in Hub settings.`);
  } else {
    const credentials = JSON.parse(creds.credentials_encrypted);
    const extCtx = { ...toolCtx, credentials };
    result = await tool.handler(toolArgs, extCtx);
  }
}
```

**Representative extension tool (Obsidian search):**

```typescript
import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';

export const OBSIDIAN_search_notes: ExtensionToolDefinition = {
  name: 'OBSIDIAN_search_notes',
  extensionName: 'obsidian',
  description: 'Search notes in Obsidian vault by query string.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
  handler: async (args, ctx) => {
    const { obsidian_api_key, obsidian_url } = (ctx as ExtensionToolContext).credentials;
    if (!obsidian_api_key || !obsidian_url) {
      return toolError('Obsidian API key and URL required. Configure in Hub settings.');
    }

    const resp = await fetch(`${obsidian_url}/search/simple/?query=${encodeURIComponent(args.query)}`, {
      headers: { Authorization: `Bearer ${obsidian_api_key}`, Accept: 'application/json' },
    });

    if (!resp.ok) return toolError(`Obsidian API error: ${resp.status}`);
    const results = await resp.json();
    return toolSuccess(results);
  },
};
```

---

### Task 9: Extension tool tests

**Files:**

- Create: `packages/app-tools/src/__tests__/extensions.test.ts`

Mock fetch() globally, test credential injection and API call construction.

---

### Task 10: Wire extensions into registry, add vitest config for app-tools

**Files:**

- Modify: `apps/mcp-worker/src/registry.ts` — import extension tools
- Modify: `apps/mcp-worker/src/session.ts` — extension credential flow
- Create: `packages/app-tools/vitest.config.ts`
- Modify: `packages/app-tools/package.json` — add test script

**vitest.config.ts for app-tools:**

```typescript
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});
```

---

### Task 11: Verify everything, update docs, commit

**Step 1:** Run `pnpm test` (web tests should still pass, app-tools tests new)
**Step 2:** Run `pnpm typecheck` (all workspaces)
**Step 3:** Run pgTAP tests (`cd /tmp && npx -y supabase test db`)
**Step 4:** Update MEMORY.md, current-task.md
**Step 5:** Commit: `feat(mcp): MCP Worker with 41 tools — CoachByte, ChefByte, extensions`

---

## Summary

| Task | What                                | Files                        |
| ---- | ----------------------------------- | ---------------------------- |
| 1    | DB migration: service-role wrappers | 1 SQL migration              |
| 2    | Tool types + shared utilities       | 3 TS files                   |
| 3    | CoachByte handlers (11)             | 12 TS files                  |
| 4    | CoachByte tests                     | 1 test file                  |
| 5    | ChefByte handlers (19)              | 20 TS files                  |
| 6    | ChefByte tests                      | 1 test file                  |
| 7    | MCP Worker infrastructure           | 6 TS files                   |
| 8    | Extension tools (11)                | ~15 TS files + 3 config.json |
| 9    | Extension tests                     | 1 test file                  |
| 10   | Wire extensions + vitest config     | 3-4 files                    |
| 11   | Verify + commit                     | docs + memory                |
