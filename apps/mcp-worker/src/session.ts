import type { ToolDefinition, ToolContext, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolError } from '@luna-hub/app-tools';
import { JsonRpcRequest, JsonRpcResponse, jsonRpcSuccess, jsonRpcError, sseEvent, McpToolSchema } from './protocol';
import { buildUserTools } from './registry';
import { createServiceClient } from './supabase';
import { validateToolArgs } from './validate';

interface Env {
  MCP_SESSION: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export class McpSession implements DurableObject {
  private userId: string = '';
  private tools: Record<string, ToolDefinition> = {};
  private toolsReady: Promise<void> = Promise.resolve();
  private sseController: ReadableStreamDefaultController | null = null;
  private supabase: any = null;
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/init') return this.handleInit(url);
    if (url.pathname === '/sse') return this.handleSseConnect(url);
    if (url.pathname === '/message' && request.method === 'POST') return this.handleMessage(request);
    if (url.pathname === '/streamable' && request.method === 'POST') return this.handleStreamablePost(request);
    return new Response('Not found', { status: 404 });
  }

  /** Called by POST /auth to pre-set userId and start building tools before SSE connects. */
  private handleInit(url: URL): Response {
    const userId = url.searchParams.get('userId') || '';
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Missing userId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    this.userId = userId;
    this.supabase = createServiceClient(this.env);
    this.toolsReady = buildUserTools(this.supabase, this.userId)
      .then((tools) => {
        this.tools = tools;
      })
      .catch((err) => {
        console.error('Failed to build user tools:', err);
        this.tools = {};
      });

    return new Response('ok', { status: 200 });
  }

  private handleSseConnect(url: URL): Response {
    // If userId is already set (via /init from POST /auth flow), skip re-initialization.
    // Otherwise, initialize from query params (legacy GET /sse?apiKey=xxx flow).
    const queryUserId = url.searchParams.get('userId') || '';
    if (!this.userId && queryUserId) {
      this.userId = queryUserId;
      this.supabase = createServiceClient(this.env);
      this.toolsReady = buildUserTools(this.supabase, this.userId)
        .then((tools) => {
          this.tools = tools;
        })
        .catch((err) => {
          console.error('Failed to build user tools:', err);
          this.tools = {};
        });
    }

    const sessionId = this.state.id.toString();

    // Close previous SSE stream if a new one connects (e.g., client reconnect)
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
    if (this.sseController) {
      try {
        this.sseController.close();
      } catch {
        /* already closed */
      }
      this.sseController = null;
    }

    const stream = new ReadableStream({
      start: (controller) => {
        this.sseController = controller;
        controller.enqueue(new TextEncoder().encode(sseEvent('endpoint', `/message?sessionId=${sessionId}`)));
        // SSE keepalive: send comment every 30s to prevent proxy/browser timeouts
        this.keepaliveInterval = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
          } catch {
            // Stream closed
            if (this.keepaliveInterval) clearInterval(this.keepaliveInterval);
          }
        }, 30_000);
      },
      cancel: () => {
        if (this.keepaliveInterval) {
          clearInterval(this.keepaliveInterval);
          this.keepaliveInterval = null;
        }
        this.sseController = null;
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  private async awaitToolsReady(): Promise<void> {
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Tools loading timed out')), 10_000),
    );
    try {
      await Promise.race([this.toolsReady, timeout]);
    } catch (err) {
      console.error('awaitToolsReady failed:', err);
      this.tools = {};
    }
  }

  /** Process a JSON-RPC message and return the response (null for notifications). */
  private async processRpcMessage(rpc: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    switch (rpc.method) {
      case 'initialize': {
        const clientVersion = (rpc.params as any)?.protocolVersion || '2024-11-05';
        const supportedVersions = ['2024-11-05', '2025-03-26'];
        const negotiatedVersion = supportedVersions.includes(clientVersion) ? clientVersion : '2025-03-26';
        return jsonRpcSuccess(rpc.id, {
          protocolVersion: negotiatedVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'luna-hub-mcp', version: '1.0.0' },
        });
      }

      case 'ping':
        return jsonRpcSuccess(rpc.id, {});

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'resources/list':
        return jsonRpcSuccess(rpc.id, { resources: [] });

      case 'prompts/list':
        return jsonRpcSuccess(rpc.id, { prompts: [] });

      case 'tools/list': {
        await this.awaitToolsReady();
        return jsonRpcSuccess(rpc.id, {
          tools: Object.values(this.tools).map(
            (t): McpToolSchema => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            }),
          ),
        });
      }

      case 'tools/call': {
        await this.awaitToolsReady();
        const toolName = (rpc.params as any)?.name;
        const toolArgs = (rpc.params as any)?.arguments || {};
        const tool = this.tools[toolName];

        if (!tool) {
          return jsonRpcError(rpc.id, -32602, `Unknown tool: ${toolName}`);
        }

        const validationError = validateToolArgs(toolArgs, tool.inputSchema);
        if (validationError) {
          return jsonRpcSuccess(rpc.id, toolError(validationError));
        }

        const toolCtx: ToolContext = { userId: this.userId, supabase: this.supabase };
        try {
          if ('extensionName' in tool) {
            const extensionName = (tool as any).extensionName as string | undefined;
            if (!extensionName) {
              return jsonRpcSuccess(rpc.id, toolError('Invalid extension tool definition'));
            }
            const { data: settings } = await this.supabase
              .schema('hub')
              .from('extension_settings')
              .select('enabled')
              .eq('user_id', this.userId)
              .eq('extension_name', extensionName)
              .eq('enabled', true)
              .single();

            if (!settings) {
              return jsonRpcSuccess(rpc.id, toolError(`Configure ${extensionName} credentials in Hub settings.`));
            }

            const { data: decryptedJson, error: decryptErr } = await this.supabase
              .schema('hub')
              .rpc('get_extension_credentials_admin', {
                p_user_id: this.userId,
                p_extension_name: extensionName,
              });

            if (decryptErr || !decryptedJson) {
              return jsonRpcSuccess(rpc.id, toolError(`Configure ${extensionName} credentials in Hub settings.`));
            }

            let credentials: Record<string, string>;
            try {
              credentials = JSON.parse(decryptedJson);
            } catch {
              return jsonRpcSuccess(rpc.id, toolError('Failed to parse extension credentials.'));
            }
            const extCtx: ExtensionToolContext = { ...toolCtx, credentials };
            const result = await tool.handler(toolArgs, extCtx);
            return jsonRpcSuccess(rpc.id, result);
          } else {
            const result = await tool.handler(toolArgs, toolCtx);
            return jsonRpcSuccess(rpc.id, result);
          }
        } catch (err: any) {
          console.error(`Tool ${toolName} error:`, err);
          return jsonRpcSuccess(rpc.id, toolError(`Tool error: ${err.message}`));
        }
      }

      default:
        return jsonRpcError(rpc.id, -32601, `Method not found: ${rpc.method}`);
    }
  }

  /** Legacy SSE transport: POST /message — processes JSON-RPC and writes response to SSE stream. */
  private async handleMessage(request: Request): Promise<Response> {
    if (!this.userId) {
      return new Response(JSON.stringify({ error: 'Session not authenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let rpc: JsonRpcRequest;
    try {
      rpc = await request.json();
    } catch {
      const errResp = jsonRpcError(null as any, -32700, 'Parse error: invalid JSON');
      if (this.sseController) {
        this.sseController.enqueue(new TextEncoder().encode(sseEvent('message', errResp)));
      }
      return new Response('', { status: 202 });
    }

    const response = await this.processRpcMessage(rpc);

    if (response !== null && this.sseController) {
      try {
        this.sseController.enqueue(new TextEncoder().encode(sseEvent('message', response)));
      } catch {
        console.warn(`SSE write failed for ${rpc.method} — client may have reconnected`);
      }
    }

    return new Response('', { status: 202 });
  }

  /** Streamable HTTP transport: POST /streamable — processes JSON-RPC and returns response directly. */
  private async handleStreamablePost(request: Request): Promise<Response> {
    if (!this.userId) {
      return new Response(JSON.stringify(jsonRpcError(undefined, -32600, 'Session not authenticated')), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let rpc: JsonRpcRequest;
    try {
      rpc = await request.json();
    } catch {
      return new Response(JSON.stringify(jsonRpcError(undefined, -32700, 'Parse error: invalid JSON')), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const response = await this.processRpcMessage(rpc);

    if (response === null) {
      return new Response('', { status: 202 });
    }

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
