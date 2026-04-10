import { toolError } from '@luna-hub/app-tools';
import { JsonRpcRequest, JsonRpcResponse, jsonRpcSuccess, jsonRpcError, McpToolSchema } from './protocol';
import { buildUserTools } from './registry';
import { executeTool } from './tool-executor';

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

      try {
        const result = await executeTool(toolName, toolArgs, tool, userId, supabase);
        return jsonRpcSuccess(rpc.id, result);
      } catch (err: any) {
        console.error(`Tool ${toolName} error:`, err);
        return jsonRpcSuccess(rpc.id, toolError('An internal error occurred executing the tool.'));
      }
    }

    default:
      return jsonRpcError(rpc.id, -32601, `Method not found: ${rpc.method}`);
  }
}
