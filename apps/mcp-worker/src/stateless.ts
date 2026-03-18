import type { ToolContext, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolError } from '@luna-hub/app-tools';
import { JsonRpcRequest, JsonRpcResponse, jsonRpcSuccess, jsonRpcError, McpToolSchema } from './protocol';
import { buildUserTools } from './registry';
import { validateToolArgs } from './validate';

/**
 * Handle a single MCP JSON-RPC request statelessly.
 * No Durable Objects — auth, tool building, and RPC processing happen inline.
 */
export async function handleStatelessMcp(
  rpc: JsonRpcRequest,
  userId: string,
  supabase: any,
): Promise<JsonRpcResponse | null> {
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
      const tools = await buildUserTools(supabase, userId);
      return jsonRpcSuccess(rpc.id, {
        tools: Object.values(tools).map(
          (t): McpToolSchema => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          }),
        ),
      });
    }

    case 'tools/call': {
      const tools = await buildUserTools(supabase, userId);
      const toolName = (rpc.params as any)?.name;
      const toolArgs = (rpc.params as any)?.arguments || {};
      const tool = tools[toolName];

      if (!tool) {
        return jsonRpcError(rpc.id, -32602, `Unknown tool: ${toolName}`);
      }

      const validationError = validateToolArgs(toolArgs, tool.inputSchema);
      if (validationError) {
        return jsonRpcSuccess(rpc.id, toolError(validationError));
      }

      const toolCtx: ToolContext = { userId, supabase };
      try {
        if ('extensionName' in tool) {
          const extensionName = (tool as any).extensionName as string | undefined;
          if (!extensionName) {
            return jsonRpcSuccess(rpc.id, toolError('Invalid extension tool definition'));
          }
          const { data: settings } = await supabase
            .schema('hub')
            .from('extension_settings')
            .select('enabled')
            .eq('user_id', userId)
            .eq('extension_name', extensionName)
            .eq('enabled', true)
            .single();

          if (!settings) {
            return jsonRpcSuccess(rpc.id, toolError(`Configure ${extensionName} credentials in Hub settings.`));
          }

          const { data: decryptedJson, error: decryptErr } = await supabase
            .schema('hub')
            .rpc('get_extension_credentials_admin', {
              p_user_id: userId,
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
