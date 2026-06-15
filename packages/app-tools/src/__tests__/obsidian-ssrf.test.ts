/**
 * SSRF guard coverage for the Obsidian extension's `github_api_url` field.
 *
 * Obsidian tools call GitHub via the user-configurable `github_api_url`
 * (defaults to https://api.github.com, overridable for GitHub Enterprise).
 * That user-supplied URL is a classic SSRF vector: without validation, a
 * malicious extension_settings row could aim the Cloudflare Worker's fetch
 * at cloud metadata endpoints (AWS 169.254.169.254, GCE
 * metadata.google.internal), loopback, or RFC1918 LAN IPs.
 *
 * These tests assert that `getGitCredentials` (which every Obsidian tool
 * calls first) returns null for blocked hosts, preventing any downstream
 * fetch. A null credentials object surfaces to the handler as
 * `toolError('Missing credentials (github_token, github_repo)')`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { obsidianTools } from '../../../../extensions/obsidian/tools';
import { getGitCredentials } from '../../../../extensions/obsidian/tools/git-api';
import type { ExtensionToolContext } from '../types';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const baseCtx = { userId: 'user-1', supabase: {} as any };

function obsidianCtx(overrides: Partial<Record<string, string>> = {}): ExtensionToolContext {
  return {
    ...baseCtx,
    credentials: {
      github_token: 'ghp-test-token',
      github_repo: 'testuser/vault',
      // Intentionally no github_api_url — tests set it per case
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Blocked URLs: every form a private/loopback/metadata target could take.
// Mirror of ha-api.ts's block list so Obsidian and HomeAssistant stay in lockstep.
// ---------------------------------------------------------------------------

describe('Obsidian SSRF protection — getGitCredentials', () => {
  const BLOCKED_URLS: Array<[label: string, url: string]> = [
    ['AWS metadata IPv4 (link-local)', 'http://169.254.169.254/'],
    ['AWS metadata with explicit port + path', 'http://169.254.169.254:80/latest/meta-data/'],
    ['link-local IPv4 range', 'http://169.254.1.2/'],
    ['localhost hostname', 'http://localhost/'],
    ['IPv4 loopback', 'http://127.0.0.1/'],
    ['IPv4 loopback with port', 'http://127.0.0.1:8080/api'],
    ['INADDR_ANY', 'http://0.0.0.0/'],
    ['RFC1918 10/8', 'http://10.0.0.1/'],
    ['RFC1918 192.168/16', 'http://192.168.1.1/'],
    ['RFC1918 172.16/12', 'http://172.16.0.1/'],
    ['RFC1918 172.31/12 upper bound', 'http://172.31.255.254/'],
    ['IPv6 loopback [::1]', 'http://[::1]/'],
    ['IPv6 unspecified [::]', 'http://[::]/'],
    ['IPv6 link-local [fe80::1]', 'http://[fe80::1]/'],
    ['IPv6 ULA [fc00::1]', 'http://[fc00::1]/'],
    ['IPv6 ULA [fd00::1]', 'http://[fd00::1]/'],
    ['IPv4-mapped IPv6 [::ffff:10.0.0.1]', 'http://[::ffff:10.0.0.1]/'],
    ['IPv4-mapped IPv6 hex form [::ffff:a00:1]', 'http://[::ffff:a00:1]/'],
    ['GCE metadata hostname', 'http://metadata.google.internal/'],
    ['Azure metadata internal TLD', 'http://foo.internal/'],
  ];

  for (const [label, url] of BLOCKED_URLS) {
    it(`returns null for ${label} (${url})`, () => {
      expect(getGitCredentials(obsidianCtx({ github_api_url: url }))).toBeNull();
    });
  }

  it('returns null for non-http(s) protocols', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://ftp.example.com/',
      'gopher://example.com/',
      'javascript:alert(1)',
    ]) {
      expect(getGitCredentials(obsidianCtx({ github_api_url: url }))).toBeNull();
    }
  });

  it('returns null for malformed URLs', () => {
    expect(getGitCredentials(obsidianCtx({ github_api_url: 'not a url' }))).toBeNull();
    expect(getGitCredentials(obsidianCtx({ github_api_url: '://badscheme' }))).toBeNull();
  });
});

describe('Obsidian SSRF protection — allows public GitHub hosts', () => {
  it('returns credentials for the default https://api.github.com (no override)', () => {
    const creds = getGitCredentials(obsidianCtx());
    expect(creds).not.toBeNull();
    expect(creds!.apiUrl).toBe('https://api.github.com');
  });

  it('preserves the API base path for self-hosted Gitea (.../api/v1)', () => {
    // H-15: Gitea / GitHub Enterprise expose their REST API under a base path
    // (Gitea = "/api/v1", GHE = "/api/v3"). The validator MUST keep that path
    // so `${apiUrl}/repos/...` resolves; dropping it 404s every call.
    const creds = getGitCredentials(obsidianCtx({ github_api_url: 'https://git.corp/api/v1' }));
    expect(creds).not.toBeNull();
    expect(creds!.apiUrl).toBe('https://git.corp/api/v1');
  });

  it('preserves the API base path for a public GitHub Enterprise hostname', () => {
    const creds = getGitCredentials(obsidianCtx({ github_api_url: 'https://ghe.example.com/api/v3' }));
    expect(creds).not.toBeNull();
    expect(creds!.apiUrl).toBe('https://ghe.example.com/api/v3');
  });

  it('normalizes a trailing slash on the configured base path (no // double-slash)', () => {
    const creds = getGitCredentials(obsidianCtx({ github_api_url: 'https://git.corp/api/v1/' }));
    expect(creds).not.toBeNull();
    expect(creds!.apiUrl).toBe('https://git.corp/api/v1');
  });

  it('treats empty-string github_api_url as "unset" and falls back to the default', () => {
    const creds = getGitCredentials(obsidianCtx({ github_api_url: '' }));
    expect(creds).not.toBeNull();
    expect(creds!.apiUrl).toBe('https://api.github.com');
  });

  it('treats whitespace-only github_api_url as "unset" and falls back to the default', () => {
    const creds = getGitCredentials(obsidianCtx({ github_api_url: '   ' }));
    expect(creds).not.toBeNull();
    expect(creds!.apiUrl).toBe('https://api.github.com');
  });
});

// ---------------------------------------------------------------------------
// End-to-end composition: the base path the user configures must flow through
// to the ACTUAL outbound fetch URL (this is the surface H-15 broke). Drive a
// real tool with a mocked fetch and assert the request path.
// ---------------------------------------------------------------------------

describe('Obsidian base-path composition — outbound fetch URL', () => {
  // Minimal Response stub for getTree (reads resp.ok + resp.json().tree).
  function okTree() {
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ tree: [] }),
      text: () => Promise.resolve('{"tree":[]}'),
    });
  }

  beforeEach(() => {
    mockFetch.mockReset();
  });

  async function fetchedUrlFor(github_api_url: string): Promise<string> {
    mockFetch.mockReturnValue(okTree());
    const tools = obsidianTools as unknown as Record<string, { handler: (args: any, ctx: any) => Promise<any> }>;
    await tools.OBSIDIAN_get_project_hierarchy.handler({}, obsidianCtx({ github_api_url }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    return mockFetch.mock.calls[0][0] as string;
  }

  it('keeps /api/v1 in the request URL for self-hosted Gitea', async () => {
    const url = await fetchedUrlFor('https://git.corp/api/v1');
    // Must hit .../api/v1/repos/...; dropping the path would 404 every call.
    expect(url).toBe('https://git.corp/api/v1/repos/testuser/vault/git/trees/main?recursive=1');
  });

  it('does NOT produce a // double-slash for the default github.com base', async () => {
    const url = await fetchedUrlFor('https://api.github.com');
    expect(url).toBe('https://api.github.com/repos/testuser/vault/git/trees/main?recursive=1');
    // Guard the exact regression a naive origin+pathname fix would introduce.
    expect(url).not.toContain('com//repos');
  });
});

// ---------------------------------------------------------------------------
// End-to-end guarantee: every Obsidian tool that fetches GitHub must refuse
// to call fetch() when `github_api_url` points at a blocked target. Pick
// representative tools spanning read + write surfaces.
// ---------------------------------------------------------------------------

describe('Obsidian SSRF protection — handlers never call fetch for blocked URLs', () => {
  const BLOCKED_SAMPLE: Array<[label: string, url: string]> = [
    ['AWS metadata', 'http://169.254.169.254/'],
    ['localhost', 'http://localhost:8080/'],
    ['RFC1918 10/8', 'http://10.1.2.3/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv4-mapped IPv6 RFC1918', 'http://[::ffff:192.168.1.1]/'],
  ];

  const TOOLS_TO_TEST: Array<[string, Record<string, unknown>]> = [
    ['OBSIDIAN_get_project_hierarchy', {}],
    ['OBSIDIAN_get_project_text', { project_id: 'Daily Review' }],
    ['OBSIDIAN_get_notes_by_date_range', { start_date: '4/1/26', end_date: '4/10/26' }],
    ['OBSIDIAN_update_project_note', { project_id: 'Daily Review', content: 'hello' }],
    ['OBSIDIAN_create_project', { name: 'Test' }],
    ['OBSIDIAN_patch_file', { path: 'Daily Review/Notes.md', patches: [{ find: 'a', replace: 'b' }] }],
    ['OBSIDIAN_get_morning_brief', {}],
  ];

  beforeEach(() => {
    mockFetch.mockReset();
  });

  for (const [label, url] of BLOCKED_SAMPLE) {
    describe(`blocks ${label} (${url})`, () => {
      for (const [toolName, args] of TOOLS_TO_TEST) {
        it(`${toolName} returns isError and never calls fetch`, async () => {
          const tools = obsidianTools as unknown as Record<string, { handler: (args: any, ctx: any) => Promise<any> }>;
          const tool = tools[toolName];
          expect(tool, `tool ${toolName} exists in obsidianTools registry`).toBeDefined();
          const result = await tool.handler(args, obsidianCtx({ github_api_url: url }));

          // Blocked URL → getGitCredentials returns null → toolError with
          // "Missing credentials". This mirrors the ha-api.ts contract
          // (null credentials == same failure mode as absent credentials).
          expect(result.isError).toBe(true);
          expect(result.content[0].text).toMatch(/Missing credentials/i);
          // CRITICAL: no outbound network call was made. If this assertion
          // ever fails, the SSRF guard has a bypass.
          expect(mockFetch).not.toHaveBeenCalled();
        });
      }
    });
  }
});
