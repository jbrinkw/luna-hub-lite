/**
 * Unit tests for executeToolWithLogging and redactArgs.
 *
 * Uses a stub tool (no real Supabase calls) and a fake supabase client
 * that records inserts, so we can assert the log row without touching the DB.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolDefinition } from '@luna-hub/app-tools';
import { toolError, toolSuccess } from '@luna-hub/app-tools';
import { executeToolWithLogging, redactArgs } from '../tool-logger';

// ─── Fake supabase client ───────────────────────────────────────────────
// Mirrors the chained API shape used by tool-logger: supabase.schema(s).from(t).insert(row).
// We capture the inserted row(s) in an array so tests can assert on them.
function makeFakeSupabase(opts: { insertError?: { message: string } | null; insertThrows?: boolean } = {}) {
  const inserts: Array<{ schema: string; table: string; row: any }> = [];
  const client = {
    schema(schema: string) {
      return {
        from(table: string) {
          return {
            async insert(row: any) {
              if (opts.insertThrows) {
                throw new Error('connection lost');
              }
              if (opts.insertError) {
                return { error: opts.insertError };
              }
              inserts.push({ schema, table, row });
              return { error: null };
            },
          };
        },
      };
    },
  };
  return { client, inserts };
}

function makeTool(handler: ToolDefinition['handler']): ToolDefinition {
  return {
    name: 'TEST_tool',
    description: 'test',
    inputSchema: { type: 'object', properties: {} },
    handler,
  };
}

// Helper: capture ctx.waitUntil promise so we can await the fire-and-forget insert
function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
    },
    flush: () => Promise.all(pending),
  };
}

describe('redactArgs', () => {
  it('returns empty object for null/undefined/non-object', () => {
    expect(redactArgs(null as any)).toEqual({});
    expect(redactArgs(undefined as any)).toEqual({});
  });

  it('passes through non-secret keys unchanged', () => {
    expect(redactArgs({ name: 'foo', count: 3 })).toEqual({ name: 'foo', count: 3 });
  });

  it('redacts top-level keys matching secret patterns', () => {
    const out = redactArgs({
      api_key: 'k1',
      apiKey: 'k2',
      'api-key': 'k3',
      token: 't',
      secret: 's',
      password: 'p',
      authorization: 'a',
      credential: 'c',
      safe: 'keep',
    });
    expect(out.api_key).toBe('[REDACTED]');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out['api-key']).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect(out.secret).toBe('[REDACTED]');
    expect(out.password).toBe('[REDACTED]');
    expect(out.authorization).toBe('[REDACTED]');
    expect(out.credential).toBe('[REDACTED]');
    expect(out.safe).toBe('keep');
  });

  it('redaction is case-insensitive', () => {
    expect(redactArgs({ Token: 'x', PASSWORD: 'y' })).toEqual({
      Token: '[REDACTED]',
      PASSWORD: '[REDACTED]',
    });
  });
});

describe('executeToolWithLogging', () => {
  const userId = '00000000-0000-0000-0000-000000000001';

  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('logs status=ok when tool returns a successful ToolResult', async () => {
    const { client, inserts } = makeFakeSupabase();
    const { ctx, flush } = makeCtx();
    const tool = makeTool(async () => toolSuccess({ ok: true }));

    const result = await executeToolWithLogging('TEST_tool', { foo: 'bar' }, tool, userId, client, ctx);
    await flush();

    expect(result.isError).toBeFalsy();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].schema).toBe('hub');
    expect(inserts[0].table).toBe('mcp_tool_logs');
    expect(inserts[0].row).toMatchObject({
      user_id: userId,
      tool_name: 'TEST_tool',
      tool_args: { foo: 'bar' },
      status: 'ok',
      error_message: null,
    });
    expect(inserts[0].row.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('logs status=tool_error when tool returns isError:true', async () => {
    const { client, inserts } = makeFakeSupabase();
    const { ctx, flush } = makeCtx();
    const tool = makeTool(async () => toolError('Product not found'));

    const result = await executeToolWithLogging('TEST_tool', {}, tool, userId, client, ctx);
    await flush();

    expect(result.isError).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row).toMatchObject({
      status: 'tool_error',
      error_message: 'Product not found',
      tool_name: 'TEST_tool',
    });
  });

  it('logs status=exception and returns generic error when handler throws', async () => {
    const { client, inserts } = makeFakeSupabase();
    const { ctx, flush } = makeCtx();
    const tool = makeTool(async () => {
      throw new Error('network died');
    });

    const result = await executeToolWithLogging('TEST_tool', { x: 1 }, tool, userId, client, ctx);
    await flush();

    expect(result.isError).toBe(true);
    // The caller should see a generic message, NOT the internal error
    const text = result.content.find((c) => c.type === 'text')?.text;
    expect(text).toBe('An internal error occurred executing the tool.');
    expect(text).not.toContain('network died');

    expect(inserts).toHaveLength(1);
    expect(inserts[0].row).toMatchObject({
      status: 'exception',
      error_message: 'network died',
      tool_name: 'TEST_tool',
    });
  });

  it('redacts secret-looking keys from tool_args before persisting', async () => {
    const { client, inserts } = makeFakeSupabase();
    const { ctx, flush } = makeCtx();
    const tool = makeTool(async () => toolSuccess('ok'));

    await executeToolWithLogging('TEST_tool', { product_id: 'abc', api_key: 'sk-leaked' }, tool, userId, client, ctx);
    await flush();

    expect(inserts[0].row.tool_args).toEqual({
      product_id: 'abc',
      api_key: '[REDACTED]',
    });
  });

  it('does not break the tool call when the insert rejects with an error', async () => {
    const { client, inserts } = makeFakeSupabase({ insertError: { message: 'db down' } });
    const { ctx, flush } = makeCtx();
    const tool = makeTool(async () => toolSuccess({ ok: true }));

    const result = await executeToolWithLogging('TEST_tool', {}, tool, userId, client, ctx);
    await flush();

    // Tool call still succeeded
    expect(result.isError).toBeFalsy();
    // Insert was attempted
    expect(inserts).toHaveLength(0); // fake didn't record because we returned error, but no throw either
    // Error was logged to stderr (but not thrown)
    expect(consoleErrorSpy).toHaveBeenCalledWith('mcp_tool_logs insert failed:', 'db down');
  });

  it('does not break the tool call when the insert throws', async () => {
    const { client } = makeFakeSupabase({ insertThrows: true });
    const { ctx, flush } = makeCtx();
    const tool = makeTool(async () => toolSuccess({ ok: true }));

    const result = await executeToolWithLogging('TEST_tool', {}, tool, userId, client, ctx);
    await flush();

    expect(result.isError).toBeFalsy();
    expect(consoleErrorSpy).toHaveBeenCalledWith('mcp_tool_logs insert threw:', 'connection lost');
  });

  it('emits a structured console.log line for wrangler tail (without tool_args)', async () => {
    const { client } = makeFakeSupabase();
    const { ctx, flush } = makeCtx();
    const tool = makeTool(async () => toolSuccess('ok'));

    await executeToolWithLogging('TEST_tool', { secret: 'hunter2', keep: 'ok' }, tool, userId, client, ctx);
    await flush();

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(logged.kind).toBe('mcp_tool_call');
    expect(logged.tool_name).toBe('TEST_tool');
    expect(logged.status).toBe('ok');
    expect(logged.user_id).toBe(userId);
    // Args must NOT be in the console line (they can contain free-form content)
    expect(logged.tool_args).toBeUndefined();
  });

  it('works without ctx.waitUntil (test/node environment)', async () => {
    const { client, inserts } = makeFakeSupabase();
    const tool = makeTool(async () => toolSuccess('ok'));

    const result = await executeToolWithLogging('TEST_tool', {}, tool, userId, client);
    // Give the fire-and-forget insert a microtask to flush
    await new Promise((r) => setTimeout(r, 10));

    expect(result.isError).toBeFalsy();
    expect(inserts).toHaveLength(1);
  });
});
