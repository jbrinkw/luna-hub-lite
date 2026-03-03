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

    // SSE connection: GET /sse?apiKey=xxx
    if (url.pathname === '/sse' && request.method === 'GET') {
      const apiKey = url.searchParams.get('apiKey');
      if (!apiKey) {
        return new Response(JSON.stringify({ error: 'Missing apiKey parameter' }), {
          status: 401,
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

      // Route to Durable Object
      const id = env.MCP_SESSION.newUniqueId();
      const stub = env.MCP_SESSION.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = '/sse';
      doUrl.searchParams.set('userId', userId);
      return stub.fetch(new Request(doUrl.toString(), request));
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

      const id = env.MCP_SESSION.idFromString(sessionId);
      const stub = env.MCP_SESSION.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = '/message';
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return new Response('Not found', { status: 404 });
  },
};
