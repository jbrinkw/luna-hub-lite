import type { ToolDefinition, ToolContext, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolError } from '@luna-hub/app-tools';
import { JsonRpcRequest, jsonRpcSuccess, jsonRpcError, sseEvent, McpToolSchema } from './protocol';
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

  private async handleMessage(request: Request): Promise<Response> {
    // Reject unauthenticated sessions — userId is set during SSE connect
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
    let response;

    switch (rpc.method) {
      case 'initialize':
        response = jsonRpcSuccess(rpc.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'luna-hub-mcp', version: '1.0.0' },
        });
        break;

      case 'ping':
        response = jsonRpcSuccess(rpc.id, {});
        break;

      case 'notifications/initialized':
        return new Response('', { status: 202 });

      case 'resources/list':
        response = jsonRpcSuccess(rpc.id, { resources: [] });
        break;

      case 'prompts/list':
        response = jsonRpcSuccess(rpc.id, { prompts: [] });
        break;

      case 'tools/list':
        await this.awaitToolsReady();
        response = jsonRpcSuccess(rpc.id, {
          tools: Object.values(this.tools).map(
            (t): McpToolSchema => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            }),
          ),
        });
        break;

      case 'tools/call': {
        await this.awaitToolsReady();
        const toolName = (rpc.params as any)?.name;
        const toolArgs = (rpc.params as any)?.arguments || {};
        const tool = this.tools[toolName];

        if (!tool) {
          response = jsonRpcError(rpc.id, -32602, `Unknown tool: ${toolName}`);
        } else {
          // Validate arguments against inputSchema
          const validationError = validateToolArgs(toolArgs, tool.inputSchema);
          if (validationError) {
            response = jsonRpcSuccess(rpc.id, toolError(validationError));
            break;
          }

          const toolCtx: ToolContext = { userId: this.userId, supabase: this.supabase };
          try {
            if ('extensionName' in tool) {
              // Extension tool: check enabled status, then decrypt credentials via RPC
              const extensionName = (tool as any).extensionName;
              const { data: settings } = await this.supabase
                .schema('hub')
                .from('extension_settings')
                .select('enabled')
                .eq('user_id', this.userId)
                .eq('extension_name', extensionName)
                .eq('enabled', true)
                .single();

              if (!settings) {
                response = jsonRpcSuccess(rpc.id, toolError(`Configure ${extensionName} credentials in Hub settings.`));
              } else {
                // Decrypt credentials server-side via private.get_extension_credentials
                const { data: decryptedJson, error: decryptErr } = await this.supabase
                  .schema('hub')
                  .rpc('get_extension_credentials_admin', {
                    p_user_id: this.userId,
                    p_extension_name: extensionName,
                  });

                if (decryptErr || !decryptedJson) {
                  response = jsonRpcSuccess(
                    rpc.id,
                    toolError(`Configure ${extensionName} credentials in Hub settings.`),
                  );
                } else {
                  let credentials: Record<string, string>;
                  try {
                    credentials = JSON.parse(decryptedJson);
                  } catch {
                    response = jsonRpcSuccess(rpc.id, toolError('Failed to parse extension credentials.'));
                    break;
                  }
                  const extCtx: ExtensionToolContext = { ...toolCtx, credentials };
                  const result = await tool.handler(toolArgs, extCtx);
                  response = jsonRpcSuccess(rpc.id, result);
                }
              }
            } else {
              // App tool: call handler directly
              const result = await tool.handler(toolArgs, toolCtx);
              response = jsonRpcSuccess(rpc.id, result);
            }
          } catch (err: any) {
            console.error(`Tool ${toolName} error:`, err);
            response = jsonRpcSuccess(rpc.id, toolError(`Tool error: ${err.message}`));
          }
        }
        break;
      }

      default:
        response = jsonRpcError(rpc.id, -32601, `Method not found: ${rpc.method}`);
    }

    if (this.sseController && response) {
      try {
        this.sseController.enqueue(new TextEncoder().encode(sseEvent('message', response)));
      } catch {
        // Controller may have been closed during SSE reconnection — message lost
        console.warn(`SSE write failed for ${rpc.method} — client may have reconnected`);
      }
    }

    return new Response('', { status: 202 });
  }
}
