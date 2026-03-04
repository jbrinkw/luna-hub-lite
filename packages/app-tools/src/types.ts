import type { SupabaseClient } from '@supabase/supabase-js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  userId: string;
  supabase: SupabaseClient;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ExtensionToolDefinition extends ToolDefinition {
  extensionName: string;
}

export interface ExtensionToolContext extends ToolContext {
  credentials: Record<string, string>;
}
