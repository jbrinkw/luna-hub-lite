import type {
  ToolDefinition,
  ExtensionToolDefinition,
  ToolContext,
  ExtensionToolContext,
  ToolResult,
} from '@luna-hub/app-tools';
import { toolError } from '@luna-hub/app-tools';
import { validateToolArgs } from './validate';

/**
 * Execute a single tool by name. Handles both regular and extension tools.
 * Returns a ToolResult (content array + optional isError flag).
 */
export async function executeTool(
  _toolName: string,
  toolArgs: Record<string, unknown>,
  tool: ToolDefinition | ExtensionToolDefinition,
  userId: string,
  supabase: any,
): Promise<ToolResult> {
  const validationError = validateToolArgs(toolArgs, tool.inputSchema);
  if (validationError) {
    return toolError(validationError);
  }

  const toolCtx: ToolContext = { userId, supabase };

  if ('extensionName' in tool) {
    const extTool = tool as ExtensionToolDefinition;
    const extensionName = extTool.extensionName;
    if (!extensionName) {
      return toolError('Invalid extension tool definition');
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
      return toolError(`Configure ${extensionName} credentials in Hub settings.`);
    }

    let credentials: Record<string, string> = {};
    if (extTool.requiresCredentials !== false) {
      const { data: decryptedJson, error: decryptErr } = await supabase
        .schema('hub')
        .rpc('get_extension_credentials_admin', {
          p_user_id: userId,
          p_extension_name: extensionName,
        });

      if (decryptErr || !decryptedJson) {
        return toolError(`Configure ${extensionName} credentials in Hub settings.`);
      }

      try {
        credentials = JSON.parse(decryptedJson);
      } catch {
        return toolError('Failed to parse extension credentials.');
      }
    }

    const extCtx: ExtensionToolContext = { ...toolCtx, credentials };
    return tool.handler(toolArgs, extCtx);
  }

  return tool.handler(toolArgs, toolCtx);
}
