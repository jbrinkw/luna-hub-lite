import { authenticateApiKey } from './auth';
import { createServiceClient } from './supabase';

export { McpSession } from './session';

export interface Env {
  MCP_SESSION: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response('ok');
    }

    // Auth endpoint: POST /auth — validates API key in body, creates DO session,
    // returns sessionId + sseUrl. Keeps API key out of URLs/logs.
    if (url.pathname === '/auth' && request.method === 'POST') {
      let body: { apiKey?: string };
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const apiKey = body.apiKey;
      if (!apiKey) {
        return new Response(JSON.stringify({ error: 'Missing apiKey in request body' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const supabase = createServiceClient(env);
      const userId = await authenticateApiKey(supabase, apiKey);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid API key' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
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

      return new Response(
        JSON.stringify({
          sessionId,
          sseUrl: `/sse?sessionId=${sessionId}`,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        },
      );
    }

    // SSE connection: GET /sse
    // Supports two flows:
    //   1. (Preferred) GET /sse?sessionId=xxx — uses pre-authenticated session from POST /auth
    //   2. (Legacy)    GET /sse?apiKey=xxx   — authenticates inline, creates new DO
    if (url.pathname === '/sse' && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      const apiKey = url.searchParams.get('apiKey');

      if (sessionId) {
        // Preferred flow: session was pre-authenticated via POST /auth
        let id: DurableObjectId;
        try {
          id = env.MCP_SESSION.idFromString(sessionId);
        } catch {
          return new Response(JSON.stringify({ error: 'Invalid sessionId' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
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
          return new Response(JSON.stringify({ error: 'Invalid API key' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const id = env.MCP_SESSION.newUniqueId();
        const stub = env.MCP_SESSION.get(id);
        const doUrl = new URL(request.url);
        doUrl.pathname = '/sse';
        doUrl.searchParams.set('userId', userId);
        return stub.fetch(new Request(doUrl.toString(), request));
      }

      return new Response(JSON.stringify({ error: 'Missing sessionId or apiKey parameter' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Message endpoint: POST /message?sessionId=xxx
    if (url.pathname === '/message' && request.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        return new Response(JSON.stringify({ error: 'Missing sessionId' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      let id: DurableObjectId;
      try {
        id = env.MCP_SESSION.idFromString(sessionId);
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid sessionId' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const stub = env.MCP_SESSION.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = '/message';
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return new Response('Not found', { status: 404 });
  },
};
