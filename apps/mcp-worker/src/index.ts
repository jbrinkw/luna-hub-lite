import { authenticateApiKey, authenticateJwt } from './auth';
import { createServiceClient } from './supabase';

export { McpSession } from './session';

export interface Env {
  MCP_SESSION: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
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
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
      const upstream = await fetch(asMetadataUrl, {
        headers: { Accept: 'application/json' },
      });
      const metadata = await upstream.json();
      return new Response(JSON.stringify(metadata), {
        status: upstream.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response('ok', { headers: CORS_HEADERS });
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
      await stub.fetch(new Request(doInitUrl.toString()));

      return jsonResponse({ sessionId, sseUrl: `/sse?sessionId=${sessionId}` }, 200);
    }

    // SSE connection: GET /sse
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
        await stub.fetch(new Request(doInitUrl.toString()));

        const doUrl = new URL(request.url);
        doUrl.pathname = '/sse';
        return stub.fetch(new Request(doUrl.toString(), request));
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
        return stub.fetch(new Request(doUrl.toString(), request));
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
        return stub.fetch(new Request(doUrl.toString(), request));
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
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};
