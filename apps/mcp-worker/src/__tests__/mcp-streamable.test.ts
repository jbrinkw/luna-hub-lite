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

  let apiKey: string;
  let cleanup: () => Promise<any>;
  let client: McpStreamableClient;

  beforeAll(async () => {
    const result = await createTestUser(admin, {
      email: `mcp-streamable-${Date.now()}@test.local`,
      activateApps: ['coachbyte', 'chefbyte'],
      enableExtensions: ['obsidian', 'todoist', 'homeassistant'],
    });
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
