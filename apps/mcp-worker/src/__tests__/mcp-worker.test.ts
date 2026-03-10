/**
 * MCP Worker E2E Protocol Tests
 *
 * Tests the full SSE/JSON-RPC protocol against a locally running wrangler dev.
 * Requires: local Supabase running (supabase start) + wrangler dev (spawned by globalSetup).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { McpTestClient } from './helpers/mcp-client';
import { generateTestApiKey } from './helpers/api-key';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const ANON_KEY =
  'eyJhbGciOiJFUzI1NiIsImtpZCI6ImI4MTI2OWYxLTIxZDgtNGYyZS1iNzE5LWMyMjQwYTg0MGQ5MCIsInR5cCI6IkpXVCJ9.eyJleHAiOjQ5MjY3MTcyNjEsImlhdCI6MTc3MzExNzI2MSwicm9sZSI6ImFub24ifQ.P9z45GEzGXk9RpkTeiFK1jgzU0N1T-w6rvXILbKT7BP4uNhe6hbyojDijLra28qrOc3GmcSDxmFFNPEZz6YU8w';

// Local Supabase uses ES256 JWTs signed with a per-project key.
// Use `supabase gen bearer-jwt` to generate long-lived tokens.
const DEFAULT_SERVICE_ROLE_KEY =
  'eyJhbGciOiJFUzI1NiIsImtpZCI6ImI4MTI2OWYxLTIxZDgtNGYyZS1iNzE5LWMyMjQwYTg0MGQ5MCIsInR5cCI6IkpXVCJ9.eyJleHAiOjQ5MjY3MTcyNjEsImlhdCI6MTc3MzExNzI2MSwicm9sZSI6InNlcnZpY2Vfcm9sZSJ9.fDBVbcn1yiwrN85kw3c70Yhm__37cMWWZPhf8cqMY5QJ46pzGo5MfHQ-jPzgXLKecXWTRrW261e0ALQQqx-rUw';

function getServiceRoleKey(): string {
  return process.env.SUPABASE_SERVICE_ROLE_KEY ?? DEFAULT_SERVICE_ROLE_KEY;
}
const SERVICE_ROLE_KEY = getServiceRoleKey();

const WORKER_BASE = 'http://localhost:8787';

/**
 * Helper: create a test user, activate apps, generate API key.
 * Returns cleanup function.
 */
async function createTestUser(
  admin: SupabaseClient,
  opts: { email: string; activateApps: string[]; enableExtensions?: string[] },
): Promise<{ userId: string; apiKey: string; cleanup: () => Promise<void> }> {
  const password = 'TestPassword123!';

  // Create user via admin API
  const { data: userData, error: createError } = await admin.auth.admin.createUser({
    email: opts.email,
    password,
    email_confirm: true,
  });
  if (createError) throw new Error(`Failed to create user: ${createError.message}`);
  const userId = userData.user!.id;

  // Sign in as the user to activate apps (requires auth.uid())
  if (opts.activateApps.length > 0) {
    const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await anonClient.auth.signInWithPassword({ email: opts.email, password });

    for (const appName of opts.activateApps) {
      const { error: activateError } = await (anonClient as any)
        .schema('hub')
        .rpc('activate_app', { p_app_name: appName });
      if (activateError) {
        throw new Error(`Failed to activate ${appName}: ${activateError.message}`);
      }
    }
  }

  // Enable extensions (via service role — bypasses RLS)
  if (opts.enableExtensions && opts.enableExtensions.length > 0) {
    const rows = opts.enableExtensions.map((ext) => ({
      user_id: userId,
      extension_name: ext,
      enabled: true,
    }));
    const { error: extErr } = await (admin as any).schema('hub').from('extension_settings').upsert(rows);
    if (extErr) throw new Error(`Failed to enable extensions: ${extErr.message}`);
  }

  // Generate API key (via service role — bypasses RLS)
  const apiKey = await generateTestApiKey(admin, userId);

  const cleanup = async () => {
    await admin.auth.admin.deleteUser(userId);
  };

  return { userId, apiKey, cleanup };
}

describe('MCP Worker E2E', () => {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Primary test user with both apps activated
  let userId: string;
  let apiKey: string;
  let primaryCleanup: () => Promise<void>;

  // Shared connected client for tests 3-8
  let client: McpTestClient;

  beforeAll(async () => {
    const result = await createTestUser(admin, {
      email: `mcp-e2e-${Date.now()}@test.local`,
      activateApps: ['coachbyte', 'chefbyte'],
      enableExtensions: ['obsidian', 'todoist', 'homeassistant'],
    });
    userId = result.userId;
    apiKey = result.apiKey;
    primaryCleanup = result.cleanup;
  });

  afterAll(async () => {
    if (client?.isConnected) await client.disconnect();
    if (primaryCleanup) await primaryCleanup();
  });

  // ─── Test 1: Health endpoint ──────────────────────────────────────────

  it('health endpoint returns 200 with "ok" body', async () => {
    const response = await fetch(`${WORKER_BASE}/health`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe('ok');
  });

  // ─── Test 2: Invalid API key returns 401 ──────────────────────────────

  it('SSE connection with invalid key returns 401', async () => {
    const response = await fetch(`${WORKER_BASE}/sse?apiKey=lh_badbadbadbadbadbadbadbadbadbadba`, {
      headers: { Accept: 'text/event-stream' },
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/invalid/i);
  });

  // ─── Test 3: SSE connection establishes session ───────────────────────

  it('SSE connection with valid key establishes session', async () => {
    client = new McpTestClient(WORKER_BASE);
    await client.connect(apiKey);

    expect(client.isConnected).toBe(true);
    expect(client.currentSessionId).toBeTruthy();
    expect(client.currentSessionId.length).toBeGreaterThan(10);
  });

  // ─── Test 4: Initialize returns protocol info ─────────────────────────

  it('initialize returns protocol version and server info', async () => {
    const result = await client.initialize();

    expect(result).toMatchObject({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: {
        name: 'luna-hub-mcp',
        version: '1.0.0',
      },
    });
  });

  // ─── Test 5: tools/list returns filtered tools ────────────────────────

  it('tools/list returns all app + extension tools when both apps active', async () => {
    const tools = await client.listTools();

    // 11 CoachByte + 19 ChefByte + 11 Extension = 41 total
    expect(tools.length).toBeGreaterThanOrEqual(30);

    const toolNames = tools.map((t: any) => t.name);

    // Verify specific app tools exist
    expect(toolNames).toContain('CHEFBYTE_create_product');
    expect(toolNames).toContain('COACHBYTE_get_today_plan');

    // Verify extension tools are included
    expect(toolNames).toContain('OBSIDIAN_get_project_hierarchy');
    expect(toolNames).toContain('TODOIST_get_tasks');
    expect(toolNames).toContain('HOMEASSISTANT_get_devices');

    // Each tool should have name, description, inputSchema
    for (const tool of tools) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
    }
  });

  // ─── Test 6: Unknown tool returns error ───────────────────────────────

  it('tools/call with unknown tool returns JSON-RPC error', async () => {
    await expect(client.callTool('FAKE_NONEXISTENT_TOOL', {})).rejects.toThrow(/unknown tool/i);
  });

  // ─── Test 6b: Invalid arguments returns validation error ──────────────

  it('tools/call with invalid arguments returns validation error', async () => {
    // CHEFBYTE_create_product requires 'name' (string) — pass a number instead
    const result = await client.callTool('CHEFBYTE_create_product', {
      name: 12345,
      calories_per_serving: 200,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/must be a string/i);
  });

  it('tools/call with missing required argument returns validation error', async () => {
    // CHEFBYTE_create_product requires 'name' — omit it
    const result = await client.callTool('CHEFBYTE_create_product', {
      calories_per_serving: 200,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/missing required/i);
  });

  // ─── Test 7: CHEFBYTE_create_product end-to-end ───────────────────────

  it('tools/call CHEFBYTE_create_product works end-to-end', async () => {
    const productName = `MCP Test Product ${Date.now()}`;
    const result = await client.callTool('CHEFBYTE_create_product', {
      name: productName,
      calories_per_serving: 200,
      protein_per_serving: 25,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBeInstanceOf(Array);
    expect(result.content.length).toBeGreaterThan(0);

    const text = result.content[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.product).toBeDefined();
    expect(parsed.product.product_id).toBeTruthy();
    expect(parsed.product.name).toBe(productName);
    expect(parsed.message).toContain(productName);
  });

  // ─── Test 8: COACHBYTE_get_today_plan end-to-end ──────────────────────

  it('tools/call COACHBYTE_get_today_plan works end-to-end', async () => {
    // Seed a split for today's weekday so ensure_daily_plan can create a plan
    const todayWeekday = new Date().getDay(); // 0=Sun, 6=Sat

    // Get a global exercise to use in the split template
    const { data: exercises } = await (admin as any)
      .schema('coachbyte')
      .from('exercises')
      .select('exercise_id, name')
      .is('user_id', null)
      .limit(1);

    const exerciseId = exercises?.[0]?.exercise_id;

    // Insert a split for today's weekday (service role bypasses RLS)
    const templateSets = exerciseId
      ? [{ exercise_id: exerciseId, target_reps: 10, target_load: 135, rest_seconds: 90 }]
      : [];

    await (admin as any).schema('coachbyte').from('splits').insert({
      user_id: userId,
      weekday: todayWeekday,
      template_sets: templateSets,
      split_notes: 'E2E test split',
    });

    const result = await client.callTool('COACHBYTE_get_today_plan', {});

    expect(result.isError).toBeUndefined();
    expect(result.content).toBeInstanceOf(Array);
    expect(result.content.length).toBeGreaterThan(0);

    const text = result.content[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.plan_id).toBeTruthy();
    expect(parsed.logical_date).toBeTruthy();
    expect(typeof parsed.total_planned).toBe('number');
  });

  // ─── Test 9: POST /auth with valid API key ─────────────────────────────

  it('POST /auth with valid API key returns sessionId and sseUrl', async () => {
    const response = await fetch(`${WORKER_BASE}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessionId: string; sseUrl: string };
    expect(body.sessionId).toBeTruthy();
    expect(body.sessionId.length).toBeGreaterThan(10);
    expect(body.sseUrl).toContain('sessionId=');
    expect(body.sseUrl).toContain(body.sessionId);
  });

  // ─── Test 10: POST /auth with invalid API key ─────────────────────────

  it('POST /auth with invalid API key returns 401', async () => {
    const response = await fetch(`${WORKER_BASE}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'lh_invalidinvalidinvalidinvalid00' }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/invalid/i);
  });

  // ─── Test 11: POST /auth with missing apiKey ──────────────────────────

  it('POST /auth with missing apiKey returns 400', async () => {
    const response = await fetch(`${WORKER_BASE}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/missing/i);
  });

  // ─── Test 12: POST /auth with invalid JSON ────────────────────────────

  it('POST /auth with invalid JSON returns 400', async () => {
    const response = await fetch(`${WORKER_BASE}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(response.status).toBe(400);
  });

  // ─── Test 13: Full POST /auth → GET /sse → initialize flow ────────────

  it('POST /auth → GET /sse?sessionId → initialize works end-to-end', async () => {
    // Step 1: Authenticate
    const authResponse = await fetch(`${WORKER_BASE}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    expect(authResponse.status).toBe(200);
    const { sessionId: authSessionId } = (await authResponse.json()) as { sessionId: string };

    // Step 2: Connect via SSE using sessionId (not apiKey)
    const sseAbort = new AbortController();
    const sseResponse = await fetch(`${WORKER_BASE}/sse?sessionId=${authSessionId}`, {
      signal: sseAbort.signal,
      headers: { Accept: 'text/event-stream' },
    });
    expect(sseResponse.status).toBe(200);

    // Read the endpoint event
    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let messageSessionId = '';

    // Read until we get the endpoint event
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('\n\n')) {
        // Parse the endpoint event
        const match = buffer.match(/sessionId=([a-f0-9]+)/);
        if (match) {
          messageSessionId = match[1];
          break;
        }
      }
    }

    expect(messageSessionId).toBeTruthy();

    // Step 3: Send initialize via POST /message
    const msgResponse = await fetch(`${WORKER_BASE}/message?sessionId=${authSessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-auth', version: '1.0' },
        },
      }),
    });
    expect(msgResponse.status).toBe(202);

    // Read the response from SSE
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('"protocolVersion"')) break;
    }

    expect(buffer).toContain('luna-hub-mcp');
    expect(buffer).toContain('2024-11-05');

    sseAbort.abort();
  });

  // ─── Test 14: POST /message without sessionId ─────────────────────────

  it('POST /message without sessionId returns 400', async () => {
    const response = await fetch(`${WORKER_BASE}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/missing/i);
  });

  // ─── Test 15: POST /message with invalid sessionId ─────────────────────

  it('POST /message with invalid sessionId returns 400', async () => {
    const response = await fetch(`${WORKER_BASE}/message?sessionId=not-a-valid-id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/invalid/i);
  });

  // ─── Test 16: GET /sse without params ──────────────────────────────────

  it('GET /sse without sessionId or apiKey returns 401 with WWW-Authenticate', async () => {
    const response = await fetch(`${WORKER_BASE}/sse`);
    expect(response.status).toBe(401);
    const wwwAuth = response.headers.get('WWW-Authenticate');
    expect(wwwAuth).toContain('Bearer');
    expect(wwwAuth).toContain('oauth-protected-resource');
  });

  // ─── Test 17: OAuth protected resource metadata ────────────────────────

  it('serves OAuth protected resource metadata at well-known endpoint', async () => {
    const res = await fetch(`${WORKER_BASE}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      bearer_methods_supported: string[];
    };
    expect(body.resource).toBeDefined();
    expect(body.authorization_servers).toBeInstanceOf(Array);
    expect(body.authorization_servers.length).toBeGreaterThan(0);
    expect(body.bearer_methods_supported).toContain('header');
  });

  // ─── Test 18: Invalid Bearer token returns 401 ────────────────────────

  it('GET /sse with invalid Bearer token returns 401', async () => {
    const res = await fetch(`${WORKER_BASE}/sse`, {
      headers: { Authorization: 'Bearer invalid-token-xxx' },
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('WWW-Authenticate');
    expect(wwwAuth).toContain('Bearer');
    expect(wwwAuth).toContain('oauth-protected-resource');
  });

  // ─── Test 19: Tool filtering — deactivated app ─────────────────────────

  it('tool filtering respects deactivated app (coachbyte only = no CHEFBYTE tools)', async () => {
    // Create a user with ONLY coachbyte active, but extensions enabled
    const { apiKey: apiKey2, cleanup } = await createTestUser(admin, {
      email: `mcp-e2e-coachonly-${Date.now()}@test.local`,
      activateApps: ['coachbyte'],
      enableExtensions: ['obsidian', 'todoist', 'homeassistant'],
    });

    let client2: McpTestClient | null = null;
    try {
      client2 = new McpTestClient(WORKER_BASE);
      await client2.connect(apiKey2);
      await client2.initialize();

      const tools = await client2.listTools();
      const toolNames = tools.map((t: any) => t.name);

      // CHEFBYTE tools should be absent
      const chefbyteTools = toolNames.filter((n: string) => n.startsWith('CHEFBYTE_'));
      expect(chefbyteTools).toHaveLength(0);

      // COACHBYTE tools should be present
      const coachbyteTools = toolNames.filter((n: string) => n.startsWith('COACHBYTE_'));
      expect(coachbyteTools.length).toBeGreaterThan(0);
      expect(toolNames).toContain('COACHBYTE_get_today_plan');

      // Extension tools should still be present
      expect(toolNames).toContain('OBSIDIAN_get_project_hierarchy');
    } finally {
      if (client2?.isConnected) await client2.disconnect();
      await cleanup();
    }
  });

  // ─── Test 20: Tool filtering — disabled tool ──────────────────────────

  it('tool filtering respects disabled tool in user_tool_config', async () => {
    // Create a fresh user with both apps active
    const {
      userId: userId3,
      apiKey: apiKey3,
      cleanup,
    } = await createTestUser(admin, {
      email: `mcp-e2e-disabled-${Date.now()}@test.local`,
      activateApps: ['coachbyte', 'chefbyte'],
    });

    let client3: McpTestClient | null = null;
    try {
      // Disable CHEFBYTE_create_product for this user (service role bypasses RLS)
      const { error: configError } = await (admin as any).schema('hub').from('user_tool_config').insert({
        user_id: userId3,
        tool_name: 'CHEFBYTE_create_product',
        enabled: false,
      });
      if (configError) throw new Error(`Failed to insert tool config: ${configError.message}`);

      client3 = new McpTestClient(WORKER_BASE);
      await client3.connect(apiKey3);
      await client3.initialize();

      const tools = await client3.listTools();
      const toolNames = tools.map((t: any) => t.name);

      // The disabled tool should NOT be in the list
      expect(toolNames).not.toContain('CHEFBYTE_create_product');

      // Other CHEFBYTE tools should still be present
      expect(toolNames).toContain('CHEFBYTE_get_products');
      expect(toolNames).toContain('CHEFBYTE_get_inventory');

      // COACHBYTE tools should be unaffected
      expect(toolNames).toContain('COACHBYTE_get_today_plan');
    } finally {
      if (client3?.isConnected) await client3.disconnect();
      await cleanup();
    }
  });
});
