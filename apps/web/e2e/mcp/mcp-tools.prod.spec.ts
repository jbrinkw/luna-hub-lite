/**
 * MCP Worker production smoke test.
 *
 * Calls a read-only tool against the deployed worker at mcp.lunahub.dev
 * to prove:
 *   - the production worker is reachable
 *   - API-key auth against the prod hub.api_keys table works
 *   - the tool handler is wired to prod Supabase
 *
 * Uses the Streamable HTTP transport (MCP 2025-03-26): POST /sse with
 * JSON-RPC body and Bearer auth. This matches what `apps/mcp-worker`
 * serves in prod (not the legacy SSE GET transport used in the
 * wrangler-dev helper).
 */
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { seedUser, signInWithRetry } from '../helpers/seed';
import { generateTestApiKey } from '../helpers/mcp-client';
import { SUPABASE_URL, ANON_KEY } from '../helpers/constants';

const PROD_MCP_URL = 'https://mcp.lunahub.dev';

async function mcpCall(apiKey: string, method: string, params: unknown, id: number) {
  const resp = await fetch(`${PROD_MCP_URL}/sse`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
  });
  expect(resp.status, `HTTP ${resp.status} from ${method}`).toBeLessThan(500);
  const body = await resp.json();
  expect(body.jsonrpc).toBe('2.0');
  expect(body.id).toBe(id);
  return body;
}

test.describe('MCP Worker — production smoke', () => {
  test('COACHBYTE_get_timer returns idle against prod mcp.lunahub.dev', async () => {
    test.setTimeout(60_000);

    // 1. Create a fresh prod user via admin API. generateTestApiKey() writes
    //    to the same prod hub.api_keys table the deployed worker reads from.
    const { userId, email, password, cleanup } = await seedUser('mcp-prod-smoke');
    try {
      // 2. Activate coachbyte so the tool has a schema to query.
      const client = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error: signInErr } = await signInWithRetry(client, email, password);
      if (signInErr) throw new Error(`Sign-in failed: ${signInErr.message}`);
      const { error: actErr } = await (client as any).schema('hub').rpc('activate_app', {
        p_app_name: 'coachbyte',
      });
      if (actErr) throw new Error(`activate_app failed: ${actErr.message}`);

      // 3. Mint an API key hashed into hub.api_keys.
      const apiKey = await generateTestApiKey(userId);

      // 4. Initialize, then call a read-only tool. The deployed worker
      //    is stateless — each POST /sse is a self-contained JSON-RPC
      //    exchange.
      const initResp = await mcpCall(apiKey, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'e2e-prod-smoke', version: '1.0' },
      }, 1);
      expect(initResp.error).toBeUndefined();
      expect(initResp.result?.protocolVersion).toBeTruthy();

      const toolResp = await mcpCall(
        apiKey,
        'tools/call',
        { name: 'COACHBYTE_get_timer', arguments: {} },
        2,
      );
      expect(toolResp.error).toBeUndefined();
      const result = toolResp.result;
      expect(result).toBeTruthy();
      expect(result.isError).not.toBe(true);
      expect(Array.isArray(result.content)).toBe(true);
      const text = result.content[0]?.text;
      expect(text).toBeTruthy();
      const data = JSON.parse(text);
      // Fresh user → timer in 'idle' state.
      expect(data.state).toBe('idle');
    } finally {
      await cleanup();
    }
  });
});
