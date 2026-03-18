import { authenticateApiKey, authenticateJwt } from './auth';
import { createServiceClient } from './supabase';
import { handleStatelessMcp } from './stateless';
import { jsonRpcError } from './protocol';

export { McpSession } from './session';

export interface Env {
  MCP_SESSION: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          ...CORS_HEADERS,
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
        },
      });
    }

    // OAuth 2.1 Protected Resource Metadata (RFC 9728)
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      return new Response(
        JSON.stringify({
          resource: `${url.origin}`,
          authorization_servers: [`${env.SUPABASE_URL}/auth/v1`],
          bearer_methods_supported: ['header'],
          scopes_supported: ['openid', 'email', 'profile'],
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        },
      );
    }

    // OAuth 2.1 Authorization Server Metadata (RFC 8414)
    // Proxies Supabase's AS metadata so MCP clients can discover endpoints
    // from the MCP server itself (required by MCP OAuth spec)
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      const asMetadataUrl = `${env.SUPABASE_URL}/auth/v1/.well-known/oauth-authorization-server`;
      try {
        const upstream = await fetch(asMetadataUrl, {
          headers: { Accept: 'application/json' },
        });
        if (!upstream.ok) {
          return new Response(JSON.stringify({ error: 'OAuth AS metadata unavailable' }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        }
        const metadata = await upstream.json();
        return new Response(JSON.stringify(metadata), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600',
          },
        });
      } catch {
        return new Response(JSON.stringify({ error: 'Failed to fetch OAuth AS metadata' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response('ok', { headers: CORS_HEADERS });
    }

    // ─── Streamable HTTP transport (stateless) ────────────────────────────
    // Primary MCP endpoint. No Durable Objects — each request is self-contained.
    // Auth: Bearer token (Supabase JWT or API key) in Authorization header.

    if (url.pathname === '/mcp' && request.method === 'POST') {
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

      let rpc: any;
      try {
        rpc = await request.json();
      } catch {
        return new Response(JSON.stringify(jsonRpcError(undefined, -32700, 'Parse error: invalid JSON')), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }

      const incomingSessionId = request.headers.get('Mcp-Session-Id');
      const sessionId = incomingSessionId || crypto.randomUUID();

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

    // GET /mcp — not supported (stateless server, no server-initiated SSE)
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

    // Auth endpoint: POST /auth — validates API key in body, creates DO session,
    // returns sessionId + sseUrl. Keeps API key out of URLs/logs.
    if (url.pathname === '/auth' && request.method === 'POST') {
      let body: { apiKey?: string };
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const apiKey = body.apiKey;
      if (!apiKey) {
        return jsonResponse({ error: 'Missing apiKey in request body' }, 400);
      }

      const supabase = createServiceClient(env);
      const userId = await authenticateApiKey(supabase, apiKey);
      if (!userId) {
        return jsonResponse({ error: 'Invalid API key' }, 401);
      }

      // Create a new Durable Object and pre-initialize it with the userId.
      // This starts tool building early; the client then connects via GET /sse?sessionId=xxx.
      const id = env.MCP_SESSION.newUniqueId();
      const sessionId = id.toString();
      const stub = env.MCP_SESSION.get(id);
      const doInitUrl = new URL(request.url);
      doInitUrl.pathname = '/init';
      doInitUrl.searchParams.set('userId', userId);
      const initResponse = await stub.fetch(new Request(doInitUrl.toString()));
      if (!initResponse.ok) {
        return jsonResponse({ error: 'Failed to initialize session' }, 500);
      }

      return jsonResponse({ sessionId, sseUrl: `/sse?sessionId=${sessionId}` }, 200);
    }

    // Streamable HTTP transport (MCP 2025-03-26): POST /sse
    // Client sends JSON-RPC messages via POST, server responds with JSON or SSE.
    // Session tracked via Mcp-Session-Id header.
    if (url.pathname === '/sse' && request.method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
            ...CORS_HEADERS,
          },
        });
      }

      const token = authHeader.slice(7);
      const supabase = createServiceClient(env);
      const userId = await authenticateJwt(supabase, token);
      if (!userId) {
        return new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
            ...CORS_HEADERS,
          },
        });
      }

      const mcpSessionId = request.headers.get('Mcp-Session-Id');
      let stub: DurableObjectStub;
      let doId: string;

      if (mcpSessionId) {
        // Existing session — look up the DO
        let id: DurableObjectId;
        try {
          id = env.MCP_SESSION.idFromString(mcpSessionId);
        } catch {
          return jsonResponse({ error: 'Invalid Mcp-Session-Id' }, 400);
        }
        stub = env.MCP_SESSION.get(id);
        doId = mcpSessionId;
      } else {
        // New session — create DO and initialize with userId
        const id = env.MCP_SESSION.newUniqueId();
        doId = id.toString();
        stub = env.MCP_SESSION.get(id);

        const doInitUrl = new URL(request.url);
        doInitUrl.pathname = '/init';
        doInitUrl.searchParams.set('userId', userId);
        const initResp = await stub.fetch(new Request(doInitUrl.toString()));
        if (!initResp.ok) {
          return jsonResponse({ error: 'Failed to initialize session' }, 500);
        }
      }

      // Forward JSON-RPC to the DO's streamable handler
      const doUrl = new URL(request.url);
      doUrl.pathname = '/streamable';
      const doResponse = await stub.fetch(
        new Request(doUrl.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: request.body,
        }),
      );

      return new Response(doResponse.body, {
        status: doResponse.status,
        headers: {
          ...Object.fromEntries(doResponse.headers),
          ...CORS_HEADERS,
          'Mcp-Session-Id': doId,
        },
      });
    }

    // Session termination: DELETE /sse — not supported
    if (url.pathname === '/sse' && request.method === 'DELETE') {
      return new Response(null, { status: 405, headers: CORS_HEADERS });
    }

    // Legacy SSE transport: GET /sse
    // Supports two flows:
    //   1. (Preferred) GET /sse?sessionId=xxx — uses pre-authenticated session from POST /auth
    //   2. (Legacy)    GET /sse?apiKey=xxx   — authenticates inline, creates new DO
    if (url.pathname === '/sse' && request.method === 'GET') {
      // Flow 1: OAuth 2.1 Bearer token in Authorization header
      const authHeader = request.headers.get('Authorization');
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        const supabase = createServiceClient(env);
        const userId = await authenticateJwt(supabase, token);
        if (!userId) {
          return new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
              ...CORS_HEADERS,
            },
          });
        }

        const id = env.MCP_SESSION.newUniqueId();
        const stub = env.MCP_SESSION.get(id);
        const doInitUrl = new URL(request.url);
        doInitUrl.pathname = '/init';
        doInitUrl.searchParams.set('userId', userId);
        const initResp = await stub.fetch(new Request(doInitUrl.toString()));
        if (!initResp.ok) {
          return jsonResponse({ error: 'Failed to initialize session' }, 500);
        }

        const doUrl = new URL(request.url);
        doUrl.pathname = '/sse';
        const sseResponse = await stub.fetch(new Request(doUrl.toString(), request));
        return new Response(sseResponse.body, {
          status: sseResponse.status,
          headers: { ...Object.fromEntries(sseResponse.headers), ...CORS_HEADERS },
        });
      }

      const sessionId = url.searchParams.get('sessionId');
      const apiKey = url.searchParams.get('apiKey');

      if (sessionId) {
        // Preferred flow: session was pre-authenticated via POST /auth
        let id: DurableObjectId;
        try {
          id = env.MCP_SESSION.idFromString(sessionId);
        } catch {
          return jsonResponse({ error: 'Invalid sessionId' }, 400);
        }
        const stub = env.MCP_SESSION.get(id);
        const doUrl = new URL(request.url);
        doUrl.pathname = '/sse';
        const sseResponse = await stub.fetch(new Request(doUrl.toString(), request));
        return new Response(sseResponse.body, {
          status: sseResponse.status,
          headers: { ...Object.fromEntries(sseResponse.headers), ...CORS_HEADERS },
        });
      }

      if (apiKey) {
        // Legacy flow: authenticate inline (API key in URL — deprecated)
        const supabase = createServiceClient(env);
        const userId = await authenticateApiKey(supabase, apiKey);
        if (!userId) {
          return jsonResponse({ error: 'Invalid API key' }, 401);
        }

        const id = env.MCP_SESSION.newUniqueId();
        const stub = env.MCP_SESSION.get(id);
        const doUrl = new URL(request.url);
        doUrl.pathname = '/sse';
        doUrl.searchParams.set('userId', userId);
        const sseResponse = await stub.fetch(new Request(doUrl.toString(), request));
        return new Response(sseResponse.body, {
          status: sseResponse.status,
          headers: { ...Object.fromEntries(sseResponse.headers), ...CORS_HEADERS },
        });
      }

      return new Response(null, {
        status: 401,
        headers: {
          'WWW-Authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
          ...CORS_HEADERS,
        },
      });
    }

    // Message endpoint: POST /message?sessionId=xxx
    if (url.pathname === '/message' && request.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        return jsonResponse({ error: 'Missing sessionId' }, 400);
      }

      let id: DurableObjectId;
      try {
        id = env.MCP_SESSION.idFromString(sessionId);
      } catch {
        return jsonResponse({ error: 'Invalid sessionId' }, 400);
      }
      const stub = env.MCP_SESSION.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = '/message';
      const doResponse = await stub.fetch(new Request(doUrl.toString(), request));
      // Add CORS headers — DO responses don't include them, but browser clients need them
      return new Response(doResponse.body, {
        status: doResponse.status,
        headers: { ...Object.fromEntries(doResponse.headers), ...CORS_HEADERS },
      });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};
