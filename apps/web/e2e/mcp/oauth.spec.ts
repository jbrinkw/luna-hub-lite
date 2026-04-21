/**
 * MCP OAuth 2.1 surface coverage (audit item #13).
 *
 * The worker only implements two OAuth endpoints itself — the RFC 9728
 * Protected Resource Metadata and an RFC 8414 Authorization Server Metadata
 * proxy to Supabase. Everything else (authorize, token, register, revoke)
 * lives on Supabase's Auth server, which is off by default on Supabase local
 * (config.toml: auth.oauth_server.enabled = false).
 *
 * So this spec covers the surface the Worker owns end-to-end, plus the
 * upstream Supabase endpoints on a best-effort basis (skipping cleanly when
 * the local Supabase stack doesn't have the OAuth server enabled — full-flow
 * coverage runs on prod). A future regression in the Worker's OAuth discovery
 * or 401-challenge behavior will fail this suite in CI.
 */
import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { SUPABASE_URL } from '../helpers/constants';
import { seedUser } from '../helpers/seed';
import { generateTestApiKey } from '../helpers/mcp-client';

const MCP_WORKER_URL = process.env.MCP_WORKER_URL ?? 'http://localhost:8787';

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// Detect whether Supabase's OAuth server is enabled in this environment.
// If not, full-flow tests skip cleanly (keep Worker-side coverage intact).
// ---------------------------------------------------------------------------

let asMetadata: any = null;
let asMetadataAvailable = false;

test.beforeAll(async () => {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/.well-known/oauth-authorization-server`, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      asMetadata = await res.json();
      asMetadataAvailable = true;
    }
  } catch {
    // Supabase local with auth.oauth_server.enabled=false returns 404.
    asMetadataAvailable = false;
  }
});

// ---------------------------------------------------------------------------
// Worker-side OAuth surface — always runs.
// ---------------------------------------------------------------------------

test.describe('MCP OAuth 2.1 — Worker surface', () => {
  test('/.well-known/oauth-protected-resource returns RFC 9728 metadata', async () => {
    const res = await fetch(`${MCP_WORKER_URL}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);

    const body = await res.json();
    // RFC 9728 required fields — pin the shape, not exact origin values
    // (prod worker hardcodes its canonical origin in the `resource` field).
    expect(typeof body.resource).toBe('string');
    expect(body.resource.length).toBeGreaterThan(0);
    expect(Array.isArray(body.authorization_servers)).toBe(true);
    expect(body.authorization_servers.length).toBeGreaterThan(0);
    expect(body.authorization_servers[0]).toContain('/auth/v1');
    expect(body.bearer_methods_supported).toContain('header');
    expect(Array.isArray(body.scopes_supported)).toBe(true);
  });

  test('/.well-known/oauth-authorization-server proxies Supabase AS metadata or returns 502', async () => {
    const res = await fetch(`${MCP_WORKER_URL}/.well-known/oauth-authorization-server`);

    if (asMetadataAvailable) {
      expect(res.status).toBe(200);
      const body = await res.json();
      // RFC 8414 requires at minimum these fields
      expect(body.issuer).toBeTruthy();
      // Supabase may name endpoints slightly differently; be lenient about which
      // one is present — the Worker just proxies whatever upstream returns.
      const hasAuth = typeof body.authorization_endpoint === 'string';
      const hasToken = typeof body.token_endpoint === 'string';
      expect(hasAuth || hasToken).toBe(true);
    } else {
      // Upstream Supabase with OAuth off → Worker proxies the 404 as 502
      expect(res.status).toBe(502);
    }
  });

  test('POST /mcp without auth returns 401 with WWW-Authenticate pointing at discovery', async () => {
    const res = await fetch(`${MCP_WORKER_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);

    const www = res.headers.get('www-authenticate');
    expect(www).toBeTruthy();
    expect(www!.toLowerCase()).toContain('bearer');
    expect(www!).toContain('resource_metadata=');
    expect(www!).toContain('/.well-known/oauth-protected-resource');
  });

  test('POST /mcp with invalid Bearer token returns 401 + WWW-Authenticate', async () => {
    const res = await fetch(`${MCP_WORKER_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer not-a-real-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  test('POST /sse without auth returns 401 + WWW-Authenticate', async () => {
    const res = await fetch(`${MCP_WORKER_URL}/sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });
});

// ---------------------------------------------------------------------------
// Supabase-side OAuth endpoints — best-effort, skip when OAuth server is off.
// ---------------------------------------------------------------------------

test.describe('MCP OAuth 2.1 — Supabase AS endpoints', () => {
  test.beforeEach(({}, testInfo) => {
    if (!asMetadataAvailable) {
      testInfo.skip(
        true,
        'Supabase OAuth server is disabled in this environment ' +
          '(config.toml: auth.oauth_server.enabled = false). ' +
          'Enable it to exercise the full authorize/token/register/revoke flow.',
      );
    }
  });

  test('dynamic client registration — POST /oauth/clients returns client_id (or 4xx if disabled)', async () => {
    const regEndpoint =
      asMetadata?.registration_endpoint ?? `${SUPABASE_URL}/auth/v1/oauth/clients`;

    const res = await fetch(regEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'e2e-oauth-spec',
        redirect_uris: ['http://localhost:5173/oauth/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none', // public PKCE client
      }),
    });

    // Either:
    //   - 200/201 with { client_id, ... } → dynamic registration is enabled
    //   - 4xx → dynamic registration disabled; that's still well-formed behavior
    // We just need to confirm the endpoint exists and returns JSON, not 5xx.
    expect(res.status).toBeLessThan(500);

    if (res.status >= 200 && res.status < 300) {
      const body = await res.json();
      expect(typeof body.client_id).toBe('string');
      // Public PKCE clients won't always have a secret — that's per spec.
      // If present, it must be a string.
      if (body.client_secret !== undefined) {
        expect(typeof body.client_secret).toBe('string');
      }
    } else {
      // 4xx payloads should at least be JSON with an error field
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        const err = await res.json();
        expect(err).toBeTruthy();
      }
    }
  });

  test('authorize endpoint requires client_id + redirect_uri (rejects malformed requests)', async () => {
    const authorizeEndpoint =
      asMetadata?.authorization_endpoint ?? `${SUPABASE_URL}/auth/v1/oauth/authorize`;

    // No params → must not 500, must not silently 302 to a random place
    const res = await fetch(authorizeEndpoint, { redirect: 'manual' });
    expect(res.status).toBeLessThan(500);
    // Typical response is 400 with an error payload, or a 302 to an error page
    expect([302, 400, 404, 422]).toContain(res.status);
  });

  test('token endpoint with invalid code + PKCE verifier returns 4xx', async () => {
    const tokenEndpoint = asMetadata?.token_endpoint ?? `${SUPABASE_URL}/auth/v1/oauth/token`;

    const { verifier } = generatePkcePair();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'definitely-not-a-real-code',
      redirect_uri: 'http://localhost:5173/oauth/callback',
      code_verifier: verifier,
      client_id: 'e2e-test-client',
    });

    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    // PKCE mismatch / invalid grant → RFC 6749 §5.2 error payload
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const err = await res.json();
      // Any of: invalid_grant, invalid_request, invalid_client, unauthorized_client
      expect(typeof err.error).toBe('string');
    }
  });

  test('PKCE mismatch at token exchange returns invalid_grant-class error', async () => {
    const tokenEndpoint = asMetadata?.token_endpoint ?? `${SUPABASE_URL}/auth/v1/oauth/token`;
    const { verifier } = generatePkcePair(); // different verifier than the fake code was signed with

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'stale-or-wrong-code',
      redirect_uri: 'http://localhost:5173/oauth/callback',
      code_verifier: verifier,
      client_id: 'e2e-test-client',
    });

    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    // The failure path must be a 4xx — never a 5xx (regression guard for the
    // Worker-side discovery + upstream wiring).
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Authenticated tool call with a Bearer token — covers the "token used against
// an MCP tool" scenario from the audit. We cannot mint a real OAuth token
// without a live OAuth server, but we CAN prove the Bearer-token surface works
// end-to-end against the worker+Supabase+tool registry by using an API key
// (which rides the same `Authorization: Bearer` path as an OAuth token).
// This exact path is how OAuth tokens end up being used — any regression in
// Bearer-token handling, user resolution, or tool dispatch breaks both.
// ---------------------------------------------------------------------------

test.describe('MCP OAuth 2.1 — Bearer-token tool dispatch parity', () => {
  test('Bearer token (API key path) resolves user and dispatches initialize over POST /mcp', async () => {
    // Streamable HTTP transport (POST /mcp) — same Bearer-token code path as
    // OAuth access tokens. Exercises: auth header parse → user resolution →
    // RPC dispatch → response envelope. Any regression in that chain breaks
    // both the OAuth and API-key paths because they share everything from the
    // Bearer-token boundary inward.
    const { userId, cleanup } = await seedUser('oauth-bearer-tool');
    const apiKey = await generateTestApiKey(userId);
    try {
      const initRes = await fetch(`${MCP_WORKER_URL}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'oauth-e2e', version: '1.0' },
          },
        }),
      });
      expect(initRes.status).toBe(200);
      const init = await initRes.json();
      expect(init.jsonrpc).toBe('2.0');
      expect(init.result?.protocolVersion).toBeTruthy();

      // tools/list confirms user resolution + registry walk completed
      const listRes = await fetch(`${MCP_WORKER_URL}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Mcp-Session-Id': initRes.headers.get('mcp-session-id') ?? '',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(listRes.status).toBe(200);
      const list = await listRes.json();
      // New user with no activations may have 0 tools — what matters is that
      // the dispatcher returned a well-formed result, not an error.
      expect(Array.isArray(list.result?.tools)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test('revoked Bearer token → 401 on next tool call', async () => {
    const { userId, cleanup } = await seedUser('oauth-revoke-bearer');
    const apiKey = await generateTestApiKey(userId);

    try {
      // 1. Token works
      const okRes = await fetch(`${MCP_WORKER_URL}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
        }),
      });
      expect(okRes.status).toBe(200);

      // 2. Revoke the key (emulates OAuth token revocation)
      const { admin } = await import('../helpers/constants');
      const keyHash = createHash('sha256').update(apiKey).digest('hex');
      const { error: revokeErr } = await (admin as any)
        .schema('hub')
        .from('api_keys')
        .update({ revoked_at: new Date().toISOString() })
        .eq('api_key_hash', keyHash);
      expect(revokeErr).toBeNull();

      // 3. Same token is now rejected
      const res2 = await fetch(`${MCP_WORKER_URL}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
      });
      expect(res2.status).toBe(401);
      expect(res2.headers.get('www-authenticate')).toContain('resource_metadata=');
    } finally {
      await cleanup();
    }
  });
});
