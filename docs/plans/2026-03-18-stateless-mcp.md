# Stateless MCP Streamable HTTP Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Durable Object-backed MCP transport with a fully stateless Streamable HTTP handler to eliminate DO duration costs from Claude.ai's SSE reconnect loop.

**Architecture:** New `POST /mcp` endpoint handles all JSON-RPC statelessly in the Worker itself — auth via Bearer token on every request, build tools inline, process RPC, return JSON. Session ID is a random UUID (protocol formality only, no server-side state). Legacy SSE endpoints kept for backward compatibility but no longer the default path. DO class remains in code but is only used by legacy endpoints.

**Tech Stack:** Cloudflare Workers, Supabase JS client, existing app-tools/extension packages

---

## File Map

| File                                                             | Action    | Responsibility                                                                       |
| ---------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------ |
| `apps/mcp-worker/src/stateless.ts`                               | Create    | Stateless MCP request handler — auth, build tools, process JSON-RPC, return response |
| `apps/mcp-worker/src/index.ts`                                   | Modify    | Add `POST /mcp` + `GET /mcp` routes, wire to stateless handler                       |
| `apps/mcp-worker/src/session.ts`                                 | No change | Legacy DO class stays for backward compat                                            |
| `apps/mcp-worker/src/__tests__/helpers/mcp-streamable-client.ts` | Create    | Test client for Streamable HTTP (POST-based, no SSE)                                 |
| `apps/mcp-worker/src/__tests__/mcp-streamable.test.ts`           | Create    | E2E tests for the stateless `/mcp` endpoint                                          |
| `apps/mcp-worker/wrangler.toml`                                  | No change | DO config stays (legacy SSE still works)                                             |
| `docs/mcp/guide.md`                                              | Modify    | Document new `/mcp` endpoint as primary transport                                    |

---

### Task 1: Create stateless MCP handler

**Files:**

- Create: `apps/mcp-worker/src/stateless.ts`

- [ ] **Step 1: Create `stateless.ts` with the handler function**

```typescript
// apps/mcp-worker/src/stateless.ts
import type { ToolDefinition, ToolContext, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolError } from '@luna-hub/app-tools';
import { JsonRpcRequest, JsonRpcResponse, jsonRpcSuccess, jsonRpcError, McpToolSchema } from './protocol';
import { buildUserTools } from './registry';
import { validateToolArgs } from './validate';

interface StatelessEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

/**
 * Handle a single MCP JSON-RPC request statelessly.
 * No Durable Objects — auth, tool building, and RPC processing happen inline.
 */
export async function handleStatelessMcp(
  rpc: JsonRpcRequest,
  userId: string,
  supabase: any,
): Promise<JsonRpcResponse | null> {
  switch (rpc.method) {
    case 'initialize': {
      const clientVersion = (rpc.params as any)?.protocolVersion || '2024-11-05';
      const supportedVersions = ['2024-11-05', '2025-03-26'];
      const negotiatedVersion = supportedVersions.includes(clientVersion) ? clientVersion : '2025-03-26';
      return jsonRpcSuccess(rpc.id, {
        protocolVersion: negotiatedVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'luna-hub-mcp', version: '1.0.0' },
      });
    }

    case 'ping':
      return jsonRpcSuccess(rpc.id, {});

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'resources/list':
      return jsonRpcSuccess(rpc.id, { resources: [] });

    case 'prompts/list':
      return jsonRpcSuccess(rpc.id, { prompts: [] });

    case 'tools/list': {
      const tools = await buildUserTools(supabase, userId);
      return jsonRpcSuccess(rpc.id, {
        tools: Object.values(tools).map(
          (t): McpToolSchema => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          }),
        ),
      });
    }

    case 'tools/call': {
      const tools = await buildUserTools(supabase, userId);
      const toolName = (rpc.params as any)?.name;
      const toolArgs = (rpc.params as any)?.arguments || {};
      const tool = tools[toolName];

      if (!tool) {
        return jsonRpcError(rpc.id, -32602, `Unknown tool: ${toolName}`);
      }

      const validationError = validateToolArgs(toolArgs, tool.inputSchema);
      if (validationError) {
        return jsonRpcSuccess(rpc.id, toolError(validationError));
      }

      const toolCtx: ToolContext = { userId, supabase };
      try {
        if ('extensionName' in tool) {
          const extensionName = (tool as any).extensionName as string | undefined;
          if (!extensionName) {
            return jsonRpcSuccess(rpc.id, toolError('Invalid extension tool definition'));
          }
          const { data: settings } = await supabase
            .schema('hub')
            .from('extension_settings')
            .select('enabled')
            .eq('user_id', userId)
            .eq('extension_name', extensionName)
            .eq('enabled', true)
            .single();

          if (!settings) {
            return jsonRpcSuccess(rpc.id, toolError(`Configure ${extensionName} credentials in Hub settings.`));
          }

          const { data: decryptedJson, error: decryptErr } = await supabase
            .schema('hub')
            .rpc('get_extension_credentials_admin', {
              p_user_id: userId,
              p_extension_name: extensionName,
            });

          if (decryptErr || !decryptedJson) {
            return jsonRpcSuccess(rpc.id, toolError(`Configure ${extensionName} credentials in Hub settings.`));
          }

          let credentials: Record<string, string>;
          try {
            credentials = JSON.parse(decryptedJson);
          } catch {
            return jsonRpcSuccess(rpc.id, toolError('Failed to parse extension credentials.'));
          }
          const extCtx: ExtensionToolContext = { ...toolCtx, credentials };
          const result = await tool.handler(toolArgs, extCtx);
          return jsonRpcSuccess(rpc.id, result);
        } else {
          const result = await tool.handler(toolArgs, toolCtx);
          return jsonRpcSuccess(rpc.id, result);
        }
      } catch (err: any) {
        console.error(`Tool ${toolName} error:`, err);
        return jsonRpcSuccess(rpc.id, toolError(`Tool error: ${err.message}`));
      }
    }

    default:
      return jsonRpcError(rpc.id, -32601, `Method not found: ${rpc.method}`);
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/mcp-worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/mcp-worker/src/stateless.ts
git commit -m "feat(mcp): add stateless MCP request handler"
```

---

### Task 2: Wire `POST /mcp` and `GET /mcp` into the Worker router

**Files:**

- Modify: `apps/mcp-worker/src/index.ts` (add routes after health check, before POST /auth)

The `POST /mcp` endpoint is the primary Streamable HTTP transport. `GET /mcp` returns `405` with allowed methods (per MCP spec, GET is only for server-initiated SSE which we don't need).

`DELETE /mcp` terminates sessions — return `200` (no-op since stateless).

- [ ] **Step 1: Add import and route for POST /mcp**

Add import at top of `index.ts`:

```typescript
import { handleStatelessMcp } from './stateless';
```

Add these routes after the `/health` block (line 92) and before the `POST /auth` block (line 96):

```typescript
// ─── Streamable HTTP transport (stateless) ────────────────────────────
// Primary MCP endpoint. No Durable Objects — each request is self-contained.
// Auth: Bearer token (Supabase JWT) or API key in Authorization header.

if (url.pathname === '/mcp' && request.method === 'POST') {
  // Authenticate
  const authHeader = request.headers.get('Authorization');
  let userId: string | null = null;
  const supabase = createServiceClient(env);

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    // Try JWT first, fall back to API key
    userId = await authenticateJwt(supabase, token);
    if (!userId) {
      userId = await authenticateApiKey(supabase, token);
    }
  }

  if (!userId) {
    return new Response(null, {
      status: 401,
      headers: {
        'WWW-Authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
        ...CORS_HEADERS,
      },
    });
  }

  // Parse JSON-RPC
  let rpc: any;
  try {
    rpc = await request.json();
  } catch {
    return new Response(JSON.stringify(jsonRpcError(undefined, -32700, 'Parse error: invalid JSON')), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  // Session management: accept or generate Mcp-Session-Id
  const incomingSessionId = request.headers.get('Mcp-Session-Id');
  const sessionId = incomingSessionId || crypto.randomUUID();

  // Process
  const response = await handleStatelessMcp(rpc, userId, supabase);

  if (response === null) {
    return new Response('', {
      status: 202,
      headers: { 'Mcp-Session-Id': sessionId, ...CORS_HEADERS },
    });
  }

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Mcp-Session-Id': sessionId,
      ...CORS_HEADERS,
    },
  });
}

// GET /mcp — server-initiated SSE (not supported, stateless server)
if (url.pathname === '/mcp' && request.method === 'GET') {
  return new Response(null, {
    status: 405,
    headers: { Allow: 'POST, DELETE', ...CORS_HEADERS },
  });
}

// DELETE /mcp — session termination (no-op since stateless)
if (url.pathname === '/mcp' && request.method === 'DELETE') {
  return new Response(null, { status: 200, headers: CORS_HEADERS });
}
```

Also add `jsonRpcError` to the imports from `./protocol`:

```typescript
import { jsonRpcError } from './protocol';
```

- [ ] **Step 2: Add `/mcp` to CORS preflight allowed methods**

In the OPTIONS handler (line 33), update:

```typescript
'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
```

(Already correct — no change needed.)

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd apps/mcp-worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/mcp-worker/src/index.ts
git commit -m "feat(mcp): add stateless POST /mcp endpoint"
```

---

### Task 3: Create Streamable HTTP test client

**Files:**

- Create: `apps/mcp-worker/src/__tests__/helpers/mcp-streamable-client.ts`

Simple HTTP client that sends JSON-RPC via POST and reads JSON responses. No SSE, no persistent connections.

- [ ] **Step 1: Create the streamable test client**

```typescript
// apps/mcp-worker/src/__tests__/helpers/mcp-streamable-client.ts
/**
 * McpStreamableClient — Streamable HTTP client for testing the stateless MCP endpoint.
 * Uses POST /mcp for all communication. No SSE, no persistent connections.
 */
export class McpStreamableClient {
  private baseUrl: string;
  private apiKey: string = '';
  private sessionId: string = '';
  private rpcId = 0;

  constructor(baseUrl = 'http://localhost:8787') {
    this.baseUrl = baseUrl;
  }

  /** Set the API key for authentication (sent as Bearer token). */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  /** Get the current session ID (assigned by server on initialize). */
  get currentSessionId(): string {
    return this.sessionId;
  }

  /** Send a JSON-RPC request via POST /mcp and return the parsed result. */
  async sendRpc(method: string, params?: any): Promise<any> {
    if (!this.apiKey) throw new Error('No API key set — call setApiKey() first');

    const id = ++this.rpcId;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
    });

    // Capture session ID from response
    const respSessionId = response.headers.get('Mcp-Session-Id');
    if (respSessionId) {
      this.sessionId = respSessionId;
    }

    if (response.status === 202) {
      return null; // Notification acknowledged
    }

    if (response.status === 401) {
      throw new Error(`Authentication failed (401)`);
    }

    const rpcResponse = (await response.json()) as any;

    if (rpcResponse.error) {
      throw new Error(`JSON-RPC error (${rpcResponse.error.code}): ${rpcResponse.error.message}`);
    }

    return rpcResponse.result;
  }

  /** Send the MCP initialize handshake. */
  async initialize(): Promise<any> {
    return this.sendRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-streamable', version: '1.0' },
    });
  }

  /** List all available MCP tools. */
  async listTools(): Promise<any[]> {
    const result = await this.sendRpc('tools/list', {});
    return result.tools;
  }

  /** Call an MCP tool by name with the given arguments. */
  async callTool(name: string, args: any = {}): Promise<any> {
    return this.sendRpc('tools/call', { name, arguments: args });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/mcp-worker/src/__tests__/helpers/mcp-streamable-client.ts
git commit -m "test(mcp): add streamable HTTP test client"
```

---

### Task 4: Write E2E tests for stateless `/mcp` endpoint

**Files:**

- Create: `apps/mcp-worker/src/__tests__/mcp-streamable.test.ts`

Tests mirror the existing `mcp-worker.test.ts` structure but use `POST /mcp` instead of SSE.

- [ ] **Step 1: Write the test file**

```typescript
// apps/mcp-worker/src/__tests__/mcp-streamable.test.ts
/**
 * Stateless MCP Streamable HTTP E2E Tests
 *
 * Tests the POST /mcp endpoint against a locally running wrangler dev.
 * Requires: local Supabase running (supabase start) + wrangler dev (spawned by globalSetup).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { McpStreamableClient } from './helpers/mcp-streamable-client';
import { generateTestApiKey } from './helpers/api-key';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const WORKER_BASE = 'http://localhost:8787';

async function createTestUser(
  admin: SupabaseClient,
  opts: { email: string; activateApps: string[]; enableExtensions?: string[] },
) {
  const password = 'TestPassword123!';
  const { data: userData, error: createError } = await admin.auth.admin.createUser({
    email: opts.email,
    password,
    email_confirm: true,
  });
  if (createError) throw new Error(`Failed to create user: ${createError.message}`);
  const userId = userData.user!.id;

  if (opts.activateApps.length > 0) {
    const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await anonClient.auth.signInWithPassword({ email: opts.email, password });
    for (const appName of opts.activateApps) {
      const { error } = await (anonClient as any).schema('hub').rpc('activate_app', { p_app_name: appName });
      if (error) throw new Error(`Failed to activate ${appName}: ${error.message}`);
    }
  }

  if (opts.enableExtensions?.length) {
    const rows = opts.enableExtensions.map((ext) => ({
      user_id: userId,
      extension_name: ext,
      enabled: true,
    }));
    await (admin as any).schema('hub').from('extension_settings').upsert(rows);
  }

  const apiKey = await generateTestApiKey(admin, userId);
  return { userId, apiKey, cleanup: () => admin.auth.admin.deleteUser(userId) };
}

describe('MCP Streamable HTTP E2E', () => {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let userId: string;
  let apiKey: string;
  let cleanup: () => Promise<any>;
  let client: McpStreamableClient;

  beforeAll(async () => {
    const result = await createTestUser(admin, {
      email: `mcp-streamable-${Date.now()}@test.local`,
      activateApps: ['coachbyte', 'chefbyte'],
      enableExtensions: ['obsidian', 'todoist', 'homeassistant'],
    });
    userId = result.userId;
    apiKey = result.apiKey;
    cleanup = result.cleanup;

    client = new McpStreamableClient(WORKER_BASE);
    client.setApiKey(apiKey);
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  // ─── Auth ──────────────────────────────────────────────────────────────

  it('POST /mcp without auth returns 401 with WWW-Authenticate', async () => {
    const res = await fetch(`${WORKER_BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
  });

  it('POST /mcp with invalid Bearer returns 401', async () => {
    const res = await fetch(`${WORKER_BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /mcp with invalid JSON returns 400', async () => {
    const res = await fetch(`${WORKER_BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  // ─── Protocol ──────────────────────────────────────────────────────────

  it('initialize returns protocol version, capabilities, and server info', async () => {
    const result = await client.initialize();
    expect(result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'luna-hub-mcp', version: '1.0.0' },
    });
    expect(client.currentSessionId).toBeTruthy();
  });

  it('Mcp-Session-Id persists across requests', async () => {
    const firstSessionId = client.currentSessionId;
    await client.sendRpc('ping');
    expect(client.currentSessionId).toBe(firstSessionId);
  });

  // ─── Tools ─────────────────────────────────────────────────────────────

  it('tools/list returns all app + extension tools', async () => {
    const tools = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(30);

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain('CHEFBYTE_create_product');
    expect(toolNames).toContain('COACHBYTE_get_today_plan');
    expect(toolNames).toContain('OBSIDIAN_get_project_hierarchy');
    expect(toolNames).toContain('TODOIST_get_tasks');
    expect(toolNames).toContain('HOMEASSISTANT_get_devices');

    for (const tool of tools) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
    }
  });

  it('tools/call with unknown tool returns error', async () => {
    await expect(client.callTool('FAKE_TOOL', {})).rejects.toThrow(/unknown tool/i);
  });

  it('tools/call with invalid args returns validation error', async () => {
    const result = await client.callTool('CHEFBYTE_create_product', { name: 12345 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/must be a string/i);
  });

  it('tools/call CHEFBYTE_create_product works e2e', async () => {
    const name = `Streamable Test ${Date.now()}`;
    const result = await client.callTool('CHEFBYTE_create_product', {
      name,
      calories_per_serving: 100,
      protein_per_serving: 10,
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.product.name).toBe(name);
  });

  // ─── Tool filtering ────────────────────────────────────────────────────

  it('tool filtering respects deactivated app', async () => {
    const { apiKey: key2, cleanup: cleanup2 } = await createTestUser(admin, {
      email: `mcp-str-coach-${Date.now()}@test.local`,
      activateApps: ['coachbyte'],
      enableExtensions: ['obsidian'],
    });
    const client2 = new McpStreamableClient(WORKER_BASE);
    client2.setApiKey(key2);
    await client2.initialize();
    const tools = await client2.listTools();
    const names = tools.map((t: any) => t.name);
    expect(names.filter((n: string) => n.startsWith('CHEFBYTE_'))).toHaveLength(0);
    expect(names).toContain('COACHBYTE_get_today_plan');
    await cleanup2();
  });

  // ─── HTTP method handling ──────────────────────────────────────────────

  it('GET /mcp returns 405', async () => {
    const res = await fetch(`${WORKER_BASE}/mcp`);
    expect(res.status).toBe(405);
  });

  it('DELETE /mcp returns 200', async () => {
    const res = await fetch(`${WORKER_BASE}/mcp`, { method: 'DELETE' });
    expect(res.status).toBe(200);
  });

  // ─── Notifications ─────────────────────────────────────────────────────

  it('notifications return 202', async () => {
    const res = await fetch(`${WORKER_BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(202);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd apps/mcp-worker && npx vitest run src/__tests__/mcp-streamable.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add apps/mcp-worker/src/__tests__/mcp-streamable.test.ts
git commit -m "test(mcp): add E2E tests for stateless /mcp endpoint"
```

---

### Task 5: Deploy and verify

- [ ] **Step 1: Run full test suite**

Run: `cd apps/mcp-worker && npx vitest run`
Expected: All existing SSE tests + new streamable tests pass

- [ ] **Step 2: Run typecheck**

Run: `cd apps/mcp-worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Deploy to Cloudflare**

Run: `cd apps/mcp-worker && npx wrangler deploy`
Expected: Successful deployment

- [ ] **Step 4: Update docs**

Update `docs/mcp/guide.md` to document `/mcp` as the primary transport endpoint. Note that `/sse` legacy endpoints still work but use Durable Objects and are not recommended.

- [ ] **Step 5: Commit**

```bash
git add docs/mcp/guide.md
git commit -m "docs: document stateless /mcp endpoint as primary transport"
```

---

## Summary

| What             | Before                               | After                                                      |
| ---------------- | ------------------------------------ | ---------------------------------------------------------- |
| Transport        | SSE via GET /sse (persistent DO)     | Streamable HTTP via POST /mcp (stateless)                  |
| DO duration/day  | ~2,400 minutes (from reconnect loop) | 0 (legacy only)                                            |
| Auth per request | Once at session start                | Every request (Bearer token)                               |
| Tool building    | Once at session start (cached in DO) | Every `tools/list` or `tools/call` (~3 DB queries, <100ms) |
| Claude.ai compat | SSE reconnect loop                   | Single POST per RPC call                                   |
