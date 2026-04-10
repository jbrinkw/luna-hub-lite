import { authenticateApiKey, authenticateJwt } from './auth';
import { createServiceClient } from './supabase';
import { handleStatelessMcp } from './stateless';
import { jsonRpcError } from './protocol';
import { handleChatCompletion } from './openai-compat';
import { CORS_HEADERS } from './cors';

export { McpSession } from './session';

export interface Env {
  MCP_SESSION: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

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
        status: 204,
        headers: {
          ...CORS_HEADERS,
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
          'Access-Control-Max-Age': '86400',
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

    // ─── OpenAI-compatible Chat Completions API ────────────────────────
    // Used by Home Assistant voice assistant via extended_openai_conversation.
    // Auth: Bearer token (same API keys as MCP).
    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      let userId: string | null = null;
      const supabase = createServiceClient(env);

      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        // Try API key first (primary HA use case), fall back to JWT
        userId = await authenticateApiKey(supabase, token);
        if (!userId) {
          userId = await authenticateJwt(supabase, token);
        }
      }

      if (!userId) {
        return new Response(JSON.stringify({ error: { message: 'Invalid API key', type: 'authentication_error' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }

      return handleChatCompletion(request, userId, supabase);
    }

    // GET /v1/models — return available model list (for client compatibility)
    if (url.pathname === '/v1/models' && request.method === 'GET') {
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'claude-haiku-4-5-20251001', object: 'model', owned_by: 'anthropic' }],
        }),
        { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
      );
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
        return new Response(JSON.stringify(jsonRpcError(null, -32700, 'Parse error: invalid JSON')), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }

      if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc) || typeof rpc.method !== 'string') {
        return new Response(
          JSON.stringify(
            jsonRpcError(rpc?.id ?? null, -32600, 'Invalid Request: expected a JSON-RPC object with a method field'),
          ),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          },
        );
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

    // Streamable HTTP transport (MCP 2025-03-26): POST /sse
    // Now routes to stateless handler (same as POST /mcp) to avoid DO duration costs.
    if (url.pathname === '/sse' && request.method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      let userId: string | null = null;
      const supabase = createServiceClient(env);

      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
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
        return new Response(JSON.stringify(jsonRpcError(null, -32700, 'Parse error: invalid JSON')), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }

      if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc) || typeof rpc.method !== 'string') {
        return new Response(
          JSON.stringify(
            jsonRpcError(rpc?.id ?? null, -32600, 'Invalid Request: expected a JSON-RPC object with a method field'),
          ),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          },
        );
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

    // Session termination: DELETE /sse — no-op (stateless)
    if (url.pathname === '/sse' && request.method === 'DELETE') {
      return new Response(null, { status: 200, headers: CORS_HEADERS });
    }

    // GET /sse — reject with 405 to force clients to use POST (Streamable HTTP).
    // The old SSE transport created Durable Objects on every reconnect, causing
    // excessive DO duration billing. Claude.ai reconnects every ~2 min 24/7.
    if (url.pathname === '/sse' && request.method === 'GET') {
      return new Response(null, {
        status: 405,
        headers: { Allow: 'POST, DELETE', ...CORS_HEADERS },
      });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};
