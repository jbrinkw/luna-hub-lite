export interface Env {
  MCP_SESSION: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok');
    }

    return new Response('Luna Hub MCP Server - Not yet implemented', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};

export class McpSession implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(_request: Request): Promise<Response> {
    // Will use this.state and this.env once MCP session logic is implemented
    void this.state;
    void this.env;
    return new Response('MCP Session - Not yet implemented');
  }
}
