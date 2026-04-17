/**
 * Unit tests for executeTool, focused on extension-tool paths.
 *
 * The credentialed path is covered at higher layers (integration tests) — here
 * we verify that `requiresCredentials: false` opts out of the credentials RPC
 * while keeping the enabled-extension gate intact.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ExtensionToolDefinition } from '@luna-hub/app-tools';
import { toolSuccess } from '@luna-hub/app-tools';
import { executeTool } from '../tool-executor';

function makeFakeSupabase(opts: { enabled: boolean; credsJson?: string | null }) {
  const rpcSpy = vi.fn();
  const client = {
    schema(_schema: string) {
      return {
        from(_table: string) {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    single: async () => ({ data: opts.enabled ? { enabled: true } : null }),
                  }),
                }),
              }),
            }),
          };
        },
        rpc: (_name: string, _args: unknown) => {
          rpcSpy(_name, _args);
          return Promise.resolve({ data: opts.credsJson ?? null, error: null });
        },
      };
    },
    rpc: (name: string, args: unknown) => {
      rpcSpy(name, args);
      return Promise.resolve({ data: opts.credsJson ?? null, error: null });
    },
  };
  return { client, rpcSpy };
}

function makeGuideTool(overrides: Partial<ExtensionToolDefinition> = {}): ExtensionToolDefinition {
  const handler = vi.fn(async () => toolSuccess({ guide: 'ok' }));
  return {
    name: 'OBSIDIAN_usage_guide',
    description: 'test guide',
    extensionName: 'obsidian',
    requiresCredentials: false,
    inputSchema: { type: 'object', properties: {} },
    handler,
    ...overrides,
  };
}

describe('executeTool — extension tool with requiresCredentials: false', () => {
  it('skips the credentials RPC and calls the handler with empty credentials', async () => {
    const { client, rpcSpy } = makeFakeSupabase({ enabled: true });
    const tool = makeGuideTool();

    const result = await executeTool('OBSIDIAN_usage_guide', {}, tool, 'user-1', client);

    expect(result.isError).toBeUndefined();
    expect(rpcSpy).not.toHaveBeenCalled();
    const [[, ctx]] = (tool.handler as any).mock.calls;
    expect(ctx.credentials).toEqual({});
    expect(ctx.userId).toBe('user-1');
  });

  it('still enforces the extension-enabled gate', async () => {
    const { client, rpcSpy } = makeFakeSupabase({ enabled: false });
    const tool = makeGuideTool();

    const result = await executeTool('OBSIDIAN_usage_guide', {}, tool, 'user-1', client);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Configure obsidian');
    expect(rpcSpy).not.toHaveBeenCalled();
    expect(tool.handler as any).not.toHaveBeenCalled();
  });
});

describe('executeTool — extension tool with credentials required (default)', () => {
  it('calls the credentials RPC and passes decrypted credentials to the handler', async () => {
    const creds = { github_token: 'gh', github_repo: 'u/r' };
    const { client, rpcSpy } = makeFakeSupabase({
      enabled: true,
      credsJson: JSON.stringify(creds),
    });
    const tool = makeGuideTool({ requiresCredentials: undefined });

    const result = await executeTool('OBSIDIAN_usage_guide', {}, tool, 'user-1', client);

    expect(result.isError).toBeUndefined();
    expect(rpcSpy).toHaveBeenCalledWith('get_extension_credentials_admin', {
      p_user_id: 'user-1',
      p_extension_name: 'obsidian',
    });
    const [[, ctx]] = (tool.handler as any).mock.calls;
    expect(ctx.credentials).toEqual(creds);
  });
});
