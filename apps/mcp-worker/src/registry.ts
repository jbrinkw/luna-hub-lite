import type { ToolDefinition, ExtensionToolDefinition } from '@luna-hub/app-tools';
import { coachbyteTools, chefbyteTools } from '@luna-hub/app-tools';
import { obsidianTools } from '../../../extensions/obsidian/tools';
import { todoistTools } from '../../../extensions/todoist/tools';
import { homeassistantTools } from '../../../extensions/homeassistant/tools';

const allAppTools: Record<string, ToolDefinition> = {
  ...coachbyteTools,
  ...chefbyteTools,
};

const allExtensionTools: Record<string, ExtensionToolDefinition> = {
  ...obsidianTools,
  ...todoistTools,
  ...homeassistantTools,
};

export async function buildUserTools(
  supabase: any,
  userId: string,
): Promise<Record<string, ToolDefinition | ExtensionToolDefinition>> {
  // 1. Get active app modules
  const { data: activations } = await supabase
    .schema('hub')
    .from('app_activations')
    .select('app_name')
    .eq('user_id', userId);

  const activeApps = new Set((activations || []).map((a: any) => a.app_name));

  // 2. Get disabled tools
  const { data: toolConfig } = await supabase
    .schema('hub')
    .from('user_tool_config')
    .select('tool_name, enabled')
    .eq('user_id', userId)
    .eq('enabled', false);

  const disabledTools = new Set((toolConfig || []).map((t: any) => t.tool_name));

  const userTools: Record<string, ToolDefinition | ExtensionToolDefinition> = {};

  // 3. Filter app tools by active modules and enabled status
  for (const [name, tool] of Object.entries(allAppTools)) {
    const module = name.startsWith('COACHBYTE_') ? 'coachbyte' : name.startsWith('CHEFBYTE_') ? 'chefbyte' : null;
    if (module && !activeApps.has(module)) continue;
    if (disabledTools.has(name)) continue;
    userTools[name] = tool;
  }

  // 4. Extension tools are always available unless explicitly disabled
  for (const [name, tool] of Object.entries(allExtensionTools)) {
    if (disabledTools.has(name)) continue;
    userTools[name] = tool;
  }

  return userTools;
}
