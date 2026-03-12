# Phase 9: MCP Worker Design

## Overview

Cloudflare Worker at `mcp.lunahub.dev` implementing the Model Context Protocol (MCP) over SSE transport. Durable Objects manage per-client sessions. Tool handlers live in `packages/app-tools/` (pure functions) and `extensions/` (external API callers). 41 tools total: 11 CoachByte + 19 ChefByte + 11 extension.

## Architecture

### Protocol: Manual JSON-RPC 2.0 over SSE

The MCP protocol is simple JSON-RPC 2.0. Instead of pulling in `@modelcontextprotocol/sdk` (Node.js deps, Zod, large bundle), we implement the protocol manually:

- Client GETs `/sse?apiKey=xxx` → Worker authenticates → routes to Durable Object → SSE stream
- DO sends `event: endpoint\ndata: /message?sessionId=xxx\n\n`
- Client POSTs JSON-RPC to `/message?sessionId=xxx`
- DO processes message, sends `event: message\ndata: {response}\n\n` over SSE stream

Supported JSON-RPC methods:

- `initialize` → returns server capabilities + info
- `notifications/initialized` → client ack (no response needed)
- `tools/list` → returns enabled tools for this user
- `tools/call` → dispatches to handler, returns result

### Component Layout

```
apps/mcp-worker/src/
├── index.ts              # Worker fetch handler, routes to DO
├── session.ts            # McpSession Durable Object (SSE + JSON-RPC)
├── auth.ts               # API key → user_id via SHA-256 + hub.api_keys
├── registry.ts           # Build per-user tool set from config
├── protocol.ts           # JSON-RPC types + SSE helpers
└── supabase.ts           # Create service-role Supabase client

packages/app-tools/src/
├── index.ts              # Re-exports coachbyteTools, chefbyteTools
├── types.ts              # ToolDefinition, ToolContext, ToolResult
├── shared/
│   └── index.ts          # toolError(), toolSuccess() helpers
├── coachbyte/
│   ├── index.ts          # Record<string, ToolDefinition> for all CB tools
│   ├── get-today-plan.ts
│   ├── complete-next-set.ts
│   ├── log-set.ts
│   ├── update-plan.ts
│   ├── update-summary.ts
│   ├── get-history.ts
│   ├── get-split.ts
│   ├── update-split.ts
│   ├── set-timer.ts
│   ├── get-timer.ts
│   └── get-prs.ts
└── chefbyte/
    ├── index.ts
    ├── get-inventory.ts
    ├── add-stock.ts
    ├── consume.ts
    ├── get-products.ts
    ├── create-product.ts
    ├── get-shopping-list.ts
    ├── add-to-shopping.ts
    ├── clear-shopping.ts
    ├── below-min-stock.ts
    ├── get-meal-plan.ts
    ├── add-meal.ts
    ├── mark-done.ts
    ├── get-recipes.ts
    ├── get-cookable.ts
    ├── create-recipe.ts
    ├── get-macros.ts
    ├── log-temp-item.ts
    ├── set-price.ts
    └── get-product-lots.ts

extensions/
├── obsidian/
│   ├── config.json
│   └── tools/
│       ├── index.ts
│       └── *.ts (4 tools)
├── todoist/
│   ├── config.json
│   └── tools/
│       ├── index.ts
│       └── *.ts (4 tools)
└── homeassistant/
    ├── config.json
    └── tools/
        ├── index.ts
        └── *.ts (3 tools)
```

### Tool Handler Pattern

All tool handlers are pure async functions — no CF Workers dependency. Testable with vitest.

```typescript
// packages/app-tools/src/types.ts
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema object
  handler: (args: any, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  userId: string;
  supabase: any; // SupabaseClient (service role)
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
```

Helper functions:

```typescript
export function toolSuccess(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function toolError(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
```

### Extension Tool Pattern

Extension handlers receive credentials from Vault:

```typescript
export interface ExtensionToolDefinition extends ToolDefinition {
  extensionName: string; // e.g., 'obsidian'
}

// Handler receives credentials injected by the Worker
export interface ExtensionToolContext extends ToolContext {
  credentials: Record<string, string>;
}
```

Credential flow:

1. Worker identifies tool's extension from registry
2. Worker calls `private.get_extension_credentials(user_id, extension_name)` via service role RPC
3. If no credentials → return `{isError: true, content: "Configure [Extension] credentials..."}`
4. Pass credentials to handler

### Auth Flow

1. Client includes API key in SSE connection: `GET /sse?apiKey=lh_xxx`
2. Worker hashes key with SHA-256
3. Lookups `hub.api_keys` where `key_hash = hash`
4. Returns `user_id` or rejects with 401

### Per-User Tool Filtering

On SSE connect:

1. Get user's active app modules from `hub.app_activations`
2. Get user's tool config from `hub.user_tool_config`
3. Build tool set: include tool if (a) its module is active AND (b) it's not explicitly disabled

Default: all tools enabled for active modules.

### Session Management (Durable Object)

```
McpSession {
  userId: string
  tools: Map<string, ToolDefinition>
  sseController: ReadableStreamDefaultController

  handleSseConnect(request) → SSE Response
  handleMessage(jsonRpc) → void (writes to SSE stream)
}
```

DO lifetime = SSE connection lifetime. When client disconnects, DO is garbage collected.

## Tool Implementation Summary

### CoachByte Tools (11)

| Tool                | Handler Logic                                                           |
| ------------------- | ----------------------------------------------------------------------- |
| `get_today_plan`    | Call `coachbyte.ensure_daily_plan` RPC, return today's plan with sets   |
| `complete_next_set` | Call `coachbyte.complete_next_set` RPC with optional rep/load overrides |
| `log_set`           | Insert into `coachbyte.completed_sets` (ad-hoc, no planned_set_id)      |
| `update_plan`       | Insert/update `coachbyte.planned_sets` for today's plan                 |
| `update_summary`    | Update `coachbyte.daily_plans.summary`                                  |
| `get_history`       | Query `coachbyte.daily_plans` with completed_sets for last N days       |
| `get_split`         | Query `coachbyte.splits` for all 7 weekdays                             |
| `update_split`      | Replace sets for a given weekday in `coachbyte.splits`                  |
| `set_timer`         | Upsert `coachbyte.timers` with duration and started_at                  |
| `get_timer`         | Query `coachbyte.timers`, compute remaining seconds                     |
| `get_prs`           | Query `coachbyte.completed_sets`, compute Epley 1RM-10RM per exercise   |

### ChefByte Tools (19)

| Tool                | Handler Logic                                                         |
| ------------------- | --------------------------------------------------------------------- |
| `get_inventory`     | Query `stock_lots` grouped by product, sum quantities, nearest expiry |
| `get_product_lots`  | Query `stock_lots` for specific product_id                            |
| `add_stock`         | Insert/upsert `stock_lots` (merge key: user+product+location+expiry)  |
| `consume`           | Call `chefbyte.consume_product` RPC                                   |
| `get_products`      | Query `products` with optional search filter                          |
| `create_product`    | Insert into `products`                                                |
| `get_shopping_list` | Query `shopping_list` joined with products                            |
| `add_to_shopping`   | Upsert `shopping_list` (merge on product_id)                          |
| `clear_shopping`    | Delete all from `shopping_list` for user                              |
| `below_min_stock`   | Compare stock vs min_stock_amount, auto-add deficit to shopping       |
| `get_meal_plan`     | Query `meal_plan_entries` for date range                              |
| `add_meal`          | Insert `meal_plan_entries`                                            |
| `mark_done`         | Call `chefbyte.mark_meal_done` RPC                                    |
| `get_recipes`       | Query `recipes` with ingredients                                      |
| `get_cookable`      | Compare recipe ingredients vs stock, return makeable recipes          |
| `create_recipe`     | Insert `recipes` + `recipe_ingredients`                               |
| `get_macros`        | Call `chefbyte.get_daily_macros` RPC                                  |
| `log_temp_item`     | Insert into `temp_items`                                              |
| `set_price`         | Update `products.price`                                               |

### Extension Tools (11)

| Tool                             | External API                             |
| -------------------------------- | ---------------------------------------- |
| `OBSIDIAN_search_notes`          | Obsidian Local REST API: GET /search     |
| `OBSIDIAN_create_note`           | PUT /vault/{path}                        |
| `OBSIDIAN_get_note`              | GET /vault/{path}                        |
| `OBSIDIAN_update_note`           | PUT /vault/{path} (overwrite)            |
| `TODOIST_get_tasks`              | Todoist REST API: GET /tasks             |
| `TODOIST_create_task`            | POST /tasks                              |
| `TODOIST_complete_task`          | POST /tasks/{id}/close                   |
| `TODOIST_get_projects`           | GET /projects                            |
| `HOMEASSISTANT_get_entity_state` | HA REST API: GET /api/states/{entity_id} |
| `HOMEASSISTANT_call_service`     | POST /api/services/{domain}/{service}    |
| `HOMEASSISTANT_get_entities`     | GET /api/states                          |

## Testing Strategy

### Unit Tests (vitest, packages/app-tools/)

- Test each tool handler as a pure function
- Mock Supabase client, verify correct RPC calls and query construction
- Test error cases (missing args, not found, insufficient stock)
- These run in our existing vitest 4.x setup — no CF dependency

### Worker Tests (deferred)

- `@cloudflare/vitest-pool-workers` requires vitest 2.x-3.2.x, incompatible with our vitest 4.x
- Worker integration tests deferred to Phase 10 or when CF ships vitest 4 support
- Manual testing via `wrangler dev` + curl for SSE/auth/session

### Extension Tests

- Mock fetch() for external APIs
- Verify correct URL construction, auth headers, response parsing

## Environment Variables (wrangler.toml)

```toml
[vars]
SUPABASE_URL = "..."
# SUPABASE_SERVICE_ROLE_KEY set via wrangler secret
```

## Scope Notes

- OAuth 2.1 support mentioned in spec is deferred — API key auth only for MVP
- Remote MCP server proxying deferred per spec
- Credential validation on extension save is a future feature
- No offline support (matches overall project decision)
