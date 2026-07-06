import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OBSIDIAN_create_project } from './create-project';
import type { ExtensionToolContext } from '@luna-hub/app-tools';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function res(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

function obsidianCtx(): ExtensionToolContext {
  return {
    userId: 'u1',
    supabase: {} as any,
    credentials: {
      github_token: 'ghp-x',
      github_repo: 'user/vault',
      github_api_url: 'https://api.github.com',
    },
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

// ===========================================================================
// B4-06 — half-created project must be rolled back so retry is unblocked
// ===========================================================================
describe('B4-06: rollback on Notes.md commit failure', () => {
  it('deletes the root file when the second commit (Notes.md) fails', async () => {
    // URL-routed mock:
    //   GET  /git/trees/...                 -> empty tree (no existing projects)
    //   GET  /contents/<root>.md            -> 404 (root does not exist yet)
    //   GET  /contents/<...>/Notes.md       -> 404 (notes does not exist yet)
    //   PUT  /contents/<root>.md            -> 201 created, returns sha
    //   PUT  /contents/<...>/Notes.md       -> 500 FAIL (commit-2 fails)
    //   DELETE /contents/<root>.md          -> 200 (rollback) — what we assert
    const calls: Array<{ method: string; path: string }> = [];

    mockFetch.mockImplementation((url: string, opts?: { method?: string }) => {
      const method = (opts?.method || 'GET').toUpperCase();
      const u = new URL(url);
      const path = decodeURIComponent(u.pathname);
      calls.push({ method, path });

      if (method === 'GET' && path.includes('/git/trees/')) {
        return res({ tree: [] });
      }
      if (method === 'GET' && path.includes('/contents/')) {
        return res('not found', false, 404); // nothing exists yet
      }
      if (method === 'PUT' && path.endsWith('/Apollo.md')) {
        return res({ content: { sha: 'root-sha-123' } }, true, 201);
      }
      if (method === 'PUT' && path.endsWith('/Notes.md')) {
        return res('server boom', false, 500); // commit-2 fails
      }
      if (method === 'DELETE') {
        return res({ commit: { sha: 'del-sha' } }, true, 200);
      }
      return res('unexpected ' + method + ' ' + path, false, 500);
    });

    const result = await OBSIDIAN_create_project.handler({ name: 'Apollo' }, obsidianCtx());

    // Operation must report failure (not a silent half-success).
    expect(result.isError).toBe(true);

    // The root file MUST have been rolled back via a DELETE carrying its sha.
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del).toBeDefined();
    expect(del!.path).toContain('Apollo.md');

    // And the DELETE body must carry the sha returned by the root PUT.
    const delCall = mockFetch.mock.calls.find((c) => (c[1]?.method || '').toUpperCase() === 'DELETE');
    const delBody = JSON.parse(delCall![1].body);
    expect(delBody.sha).toBe('root-sha-123');
  });

  it('does NOT delete the root when both commits succeed', async () => {
    mockFetch.mockImplementation((url: string, opts?: { method?: string }) => {
      const method = (opts?.method || 'GET').toUpperCase();
      const u = new URL(url);
      const path = decodeURIComponent(u.pathname);
      if (method === 'GET' && path.includes('/git/trees/')) return res({ tree: [] });
      if (method === 'GET' && path.includes('/contents/')) return res('nf', false, 404);
      if (method === 'PUT') return res({ content: { sha: 's' } }, true, 201);
      return res('unexpected', false, 500);
    });

    const result = await OBSIDIAN_create_project.handler({ name: 'Apollo' }, obsidianCtx());

    expect(result.isError).toBeUndefined();
    const deletes = mockFetch.mock.calls.filter((c) => (c[1]?.method || '').toUpperCase() === 'DELETE');
    expect(deletes.length).toBe(0);
  });
});
