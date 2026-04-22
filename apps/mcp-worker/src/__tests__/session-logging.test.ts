/**
 * Regression test for the legacy DurableObject MCP session transport.
 *
 * Context: `McpSession` (apps/mcp-worker/src/session.ts) used to inline its
 * own extension-auth + handler dispatch logic inside the `tools/call`
 * branch, silently bypassing `executeToolWithLogging`. That meant any MCP
 * client still hitting the Durable Object path (via the `/streamable` or
 * `/message` DO endpoints) produced zero mcp_tool_logs rows and lost
 * exception-to-generic-error conversion.
 *
 * We now route through `executeToolWithLogging`, matching the stateless
 * transport (stateless.ts). These tests pin that contract by driving a
 * `tools/call` JSON-RPC message through `McpSession` and asserting the
 * logger wrapper was invoked with the expected args.
 *
 * We stub `./tool-logger` at the vi.mock level and drive `McpSession` via
 * a minimal DurableObjectState double + handler injection, so we don't need
 * a real Workers runtime. Stryker's `vitest.related` coverage analyzer
 * follows the `../session` import and maps mutants to these tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock ./tool-logger BEFORE the dynamic import of session.ts — otherwise
// vitest wires the real implementation. The spy has to live at module
// scope so the test body can assert against it.
const executeToolWithLoggingSpy = vi.fn();

vi.mock('../tool-logger', () => ({
  executeToolWithLogging: (...args: unknown[]) => executeToolWithLoggingSpy(...args),
  // Re-export the type names to keep transitive importers happy (they
  // tree-shake at build but tsc-via-vitest still resolves them).
}));

// Mock the registry so buildUserTools returns a predictable tool set.
const toolHandlerSpy = vi.fn(async () => ({
  content: [{ type: 'text', text: 'raw handler was called — SHOULD NOT HAPPEN' }],
}));

vi.mock('../registry', () => ({
  buildUserTools: async () => ({
    COACHBYTE_fake_tool: {
      name: 'COACHBYTE_fake_tool',
      description: 'test',
      inputSchema: { type: 'object', properties: {} },
      handler: toolHandlerSpy,
    },
  }),
}));

// Mock ./supabase so createServiceClient returns a sentinel object we can
// identify in the spy's argument list.
const FAKE_SUPABASE = { __sentinel: 'fake-supabase-client' };
vi.mock('../supabase', () => ({
  createServiceClient: () => FAKE_SUPABASE,
}));

// Now import — mocks above resolve lazily via vi.mock hoisting.
const { McpSession } = await import('../session');

// Minimal DurableObjectState double: only needs .id.toString() for the
// tools/call code path we exercise.
function makeFakeState(): any {
  return {
    id: { toString: () => 'fake-do-id-abc123' },
    // unused but referenced on the class — provide stubs to silence access
    storage: { get: async () => undefined, put: async () => undefined },
    waitUntil: () => {},
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
  };
}

const fakeEnv: any = {
  MCP_SESSION: {} as any,
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc-key',
};

async function makeSession(): Promise<any> {
  const session = new McpSession(makeFakeState(), fakeEnv);
  // Trigger /init so userId + tools load before we call tools/call.
  await session.fetch(new Request('http://do/init?userId=00000000-0000-0000-0000-000000000001'));
  return session;
}

describe('McpSession — tools/call dispatch goes through executeToolWithLogging', () => {
  beforeEach(() => {
    executeToolWithLoggingSpy.mockReset();
    toolHandlerSpy.mockReset();
    executeToolWithLoggingSpy.mockResolvedValue({
      content: [{ type: 'text', text: 'ok-from-logger' }],
    });
  });

  it('routes a tools/call JSON-RPC message through executeToolWithLogging', async () => {
    const session = await makeSession();

    const res = await session.fetch(
      new Request('http://do/streamable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 42,
          method: 'tools/call',
          params: { name: 'COACHBYTE_fake_tool', arguments: { foo: 'bar' } },
        }),
      }),
    );

    // JSON-RPC success with the logger's return value as the tool result.
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(42);
    expect(body.result).toEqual({ content: [{ type: 'text', text: 'ok-from-logger' }] });

    // THE critical assertion: the logger wrapper was used, NOT the raw handler.
    expect(executeToolWithLoggingSpy).toHaveBeenCalledTimes(1);
    expect(toolHandlerSpy).not.toHaveBeenCalled();

    // And it received the right contract: (toolName, args, tool, userId, supabase).
    const [toolName, toolArgs, tool, userId, supabase] = executeToolWithLoggingSpy.mock.calls[0];
    expect(toolName).toBe('COACHBYTE_fake_tool');
    expect(toolArgs).toEqual({ foo: 'bar' });
    expect(tool.name).toBe('COACHBYTE_fake_tool');
    expect(userId).toBe('00000000-0000-0000-0000-000000000001');
    expect(supabase).toBe(FAKE_SUPABASE);
  });

  it('returns JSON-RPC error for unknown tools WITHOUT invoking the logger', async () => {
    const session = await makeSession();

    const res = await session.fetch(
      new Request('http://do/streamable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'DOES_NOT_EXIST', arguments: {} },
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toMatch(/Unknown tool: DOES_NOT_EXIST/);

    // Unknown tool → short-circuit before the logger, matches stateless.ts.
    expect(executeToolWithLoggingSpy).not.toHaveBeenCalled();
  });

  // Additional behavioral coverage for processRpcMessage's non-tools/call
  // branches. These don't touch the SSRF/logging fix directly but drive up
  // mutation coverage on the same file so the mutation gate reports a
  // meaningful score on the module we actually modified. Each assertion
  // pins a JSON-RPC protocol contract that a regression (e.g. a mutant
  // flipping a protocolVersion string) would break.

  it('initialize returns supported protocolVersion when client sends a known one', async () => {
    const session = await makeSession();
    const res = await session.fetch(
      new Request('http://do/streamable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05' },
        }),
      }),
    );
    const body = (await res.json()) as any;
    expect(body.result.protocolVersion).toBe('2024-11-05');
    expect(body.result.serverInfo).toEqual({ name: 'luna-hub-mcp', version: '1.0.0' });
    expect(body.result.capabilities).toEqual({ tools: {} });
  });

  it('initialize falls back to 2025-03-26 when client sends an unknown protocolVersion', async () => {
    const session = await makeSession();
    const res = await session.fetch(
      new Request('http://do/streamable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '9999-99-99' },
        }),
      }),
    );
    const body = (await res.json()) as any;
    expect(body.result.protocolVersion).toBe('2025-03-26');
  });

  it('ping returns an empty success result', async () => {
    const session = await makeSession();
    const res = await session.fetch(
      new Request('http://do/streamable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }),
      }),
    );
    const body = (await res.json()) as any;
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(5);
    expect(body.result).toEqual({});
  });

  it('notifications return 202 with no body (JSON-RPC notification spec)', async () => {
    const session = await makeSession();
    for (const method of ['notifications/initialized', 'notifications/cancelled']) {
      const res = await session.fetch(
        new Request('http://do/streamable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method }),
        }),
      );
      expect(res.status).toBe(202);
      expect(await res.text()).toBe('');
    }
  });

  it('resources/list returns an empty array (MCP server declares no resources)', async () => {
    const session = await makeSession();
    const res = await session.fetch(
      new Request('http://do/streamable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/list' }),
      }),
    );
    const body = (await res.json()) as any;
    expect(body.result).toEqual({ resources: [] });
  });

  it('prompts/list returns an empty array (MCP server declares no prompts)', async () => {
    const session = await makeSession();
    const res = await session.fetch(
      new Request('http://do/streamable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'prompts/list' }),
      }),
    );
    const body = (await res.json()) as any;
    expect(body.result).toEqual({ prompts: [] });
  });

  it('tools/list returns the registered tool metadata', async () => {
    const session = await makeSession();
    const res = await session.fetch(
      new Request('http://do/streamable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    const body = (await res.json()) as any;
    expect(body.result.tools).toHaveLength(1);
    expect(body.result.tools[0]).toMatchObject({
      name: 'COACHBYTE_fake_tool',
      description: 'test',
      inputSchema: { type: 'object', properties: {} },
    });
  });

  it('unknown JSON-RPC method returns -32601 Method not found', async () => {
    const session = await makeSession();
    const res = await session.fetch(
      new Request('http://do/streamable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope/unknown' }),
      }),
    );
    const body = (await res.json()) as any;
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toMatch(/nope\/unknown/);
  });

  it('malformed JSON body returns -32700 Parse error (400 status)', async () => {
    const session = await makeSession();
    const res = await session.fetch(
      new Request('http://do/streamable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ not json',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe(-32700);
  });

  it('handleStreamablePost rejects unauthenticated requests with 401 + -32600', async () => {
    // Skip handleInit so userId stays empty — the auth guard should fire.
    const session = new McpSession(makeFakeState(), fakeEnv);
    const res = await session.fetch(
      new Request('http://do/streamable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toMatch(/not authenticated/i);
  });

  it('unknown URL path returns 404', async () => {
    const session = await makeSession();
    const res = await session.fetch(new Request('http://do/does-not-exist'));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not found');
  });

  it('forwards logger-produced tool_error results inside a jsonrpc success envelope', async () => {
    // executeToolWithLogging returns a ToolResult with isError:true when the
    // underlying tool returns toolError(...). The wrapper pattern is that
    // the JSON-RPC layer wraps that in a success envelope (the tool ran,
    // the protocol didn't fail). Pin this behavior so a regression that
    // elevates a tool_error to a jsonrpc error fails here.
    executeToolWithLoggingSpy.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Product not found' }],
      isError: true,
    });

    const session = await makeSession();

    const res = await session.fetch(
      new Request('http://do/streamable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'COACHBYTE_fake_tool', arguments: {} },
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe('Product not found');
    expect(executeToolWithLoggingSpy).toHaveBeenCalledTimes(1);
  });
});
