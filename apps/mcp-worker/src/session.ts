import type { ToolDefinition, ToolContext, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolError } from '@luna-hub/app-tools';
import { JsonRpcRequest, jsonRpcSuccess, jsonRpcError, sseEvent, McpToolSchema } from './protocol';
import { buildUserTools } from './registry';
import { createServiceClient } from './supabase';

interface Env {
  MCP_SESSION: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export class McpSession implements DurableObject {
  private userId: string = '';
  private tools: Record<string, ToolDefinition> = {};
  private sseController: ReadableStreamDefaultController | null = null;
  private supabase: any = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/sse') return this.handleSseConnect(url);
    if (url.pathname === '/message' && request.method === 'POST') return this.handleMessage(request);
    return new Response('Not found', { status: 404 });
  }

  private handleSseConnect(url: URL): Response {
    this.userId = url.searchParams.get('userId') || '';
    this.supabase = createServiceClient(this.env);
    const sessionId = this.state.id.toString();

    // Build tools asynchronously - will be ready before first tools/list call
    buildUserTools(this.supabase, this.userId).then(tools => { this.tools = tools; });

    const stream = new ReadableStream({
      start: (controller) => {
        this.sseController = controller;
        controller.enqueue(
          new TextEncoder().encode(sseEvent('endpoint', `/message?sessionId=${sessionId}`)),
        );
      },
      cancel: () => { this.sseController = null; },
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

  private async handleMessage(request: Request): Promise<Response> {
    const rpc: JsonRpcRequest = await request.json();
    let response;

    switch (rpc.method) {
      case 'initialize':
        response = jsonRpcSuccess(rpc.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'luna-hub-mcp', version: '1.0.0' },
        });
        break;

      case 'notifications/initialized':
        return new Response('', { status: 202 });

      case 'tools/list':
        response = jsonRpcSuccess(rpc.id, {
          tools: Object.values(this.tools).map((t): McpToolSchema => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
        break;

      case 'tools/call': {
        const toolName = (rpc.params as any)?.name;
        const toolArgs = (rpc.params as any)?.arguments || {};
        const tool = this.tools[toolName];

        if (!tool) {
          response = jsonRpcSuccess(rpc.id, toolError(`Unknown tool: ${toolName}`));
        } else {
          const toolCtx: ToolContext = { userId: this.userId, supabase: this.supabase };
          try {
            if ('extensionName' in tool) {
              // Extension tool: fetch credentials from hub.extension_settings
              const { data: settings } = await this.supabase
                .schema('hub')
                .from('extension_settings')
                .select('credentials_encrypted')
                .eq('user_id', this.userId)
                .eq('extension_name', (tool as any).extensionName)
                .eq('enabled', true)
                .single();

              if (!settings?.credentials_encrypted) {
                response = jsonRpcSuccess(rpc.id, toolError(
                  `Configure ${(tool as any).extensionName} credentials in Hub settings.`,
                ));
              } else {
                const credentials = JSON.parse(settings.credentials_encrypted);
                const extCtx: ExtensionToolContext = { ...toolCtx, credentials };
                const result = await tool.handler(toolArgs, extCtx);
                response = jsonRpcSuccess(rpc.id, result);
              }
            } else {
              // App tool: call handler directly
              const result = await tool.handler(toolArgs, toolCtx);
              response = jsonRpcSuccess(rpc.id, result);
            }
          } catch (err: any) {
            response = jsonRpcSuccess(rpc.id, toolError(`Tool error: ${err.message}`));
          }
        }
        break;
      }

      default:
        response = jsonRpcError(rpc.id, -32601, `Method not found: ${rpc.method}`);
    }

    if (this.sseController && response) {
      this.sseController.enqueue(
        new TextEncoder().encode(sseEvent('message', response)),
      );
    }

    return new Response('', { status: 202 });
  }
}
