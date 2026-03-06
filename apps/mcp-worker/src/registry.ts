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
  const { data: activations, error: actErr } = await supabase
    .schema('hub')
    .from('app_activations')
    .select('app_name')
    .eq('user_id', userId);

  if (actErr) throw new Error(`Failed to load activations: ${actErr.message}`);

  const activeApps = new Set((activations || []).map((a: any) => a.app_name));

  // 2. Get disabled tools
  const { data: toolConfig, error: toolErr } = await supabase
    .schema('hub')
    .from('user_tool_config')
    .select('tool_name, enabled')
    .eq('user_id', userId)
    .eq('enabled', false);

  if (toolErr) throw new Error(`Failed to load tool config: ${toolErr.message}`);

  const disabledTools = new Set((toolConfig || []).map((t: any) => t.tool_name));

  const userTools: Record<string, ToolDefinition | ExtensionToolDefinition> = {};

  // 3. Filter app tools by active modules and enabled status
  for (const [name, tool] of Object.entries(allAppTools)) {
    const module = name.startsWith('COACHBYTE_') ? 'coachbyte' : name.startsWith('CHEFBYTE_') ? 'chefbyte' : null;
    if (module && !activeApps.has(module)) continue;
    if (disabledTools.has(name)) continue;
    userTools[name] = tool;
  }

  // 4. Get enabled extensions
  const { data: extensionSettings, error: extErr } = await supabase
    .schema('hub')
    .from('extension_settings')
    .select('extension_name, enabled')
    .eq('user_id', userId);

  if (extErr) throw new Error(`Failed to load extension settings: ${extErr.message}`);

  const enabledExtensions = new Set(
    (extensionSettings || []).filter((e: any) => e.enabled).map((e: any) => e.extension_name),
  );

  // 5. Extension tools: only include if the extension is enabled and the tool is not individually disabled
  for (const [name, tool] of Object.entries(allExtensionTools)) {
    if (!enabledExtensions.has(tool.extensionName)) continue;
    if (disabledTools.has(name)) continue;
    userTools[name] = tool;
  }

  return userTools;
}
