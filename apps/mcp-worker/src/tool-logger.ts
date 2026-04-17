import type { ToolDefinition, ExtensionToolDefinition, ToolResult } from '@luna-hub/app-tools';
import { toolError } from '@luna-hub/app-tools';
import { executeTool } from './tool-executor';

/**
 * Minimal execution-context shape. We only need waitUntil (optional).
 * Cloudflare's ExecutionContext type is compatible; Node/test environments
 * can pass undefined or an object without waitUntil.
 */
export interface LoggerCtx {
  waitUntil?: (promise: Promise<unknown>) => void;
}

type LogStatus = 'ok' | 'tool_error' | 'exception';

/** Keys we redact from tool_args at the top level before persisting. */
const REDACT_KEY_PATTERN = /token|secret|password|api[_-]?key|authorization|credential/i;

/**
 * Shallow redaction — extension credentials are NOT in args (they're in
 * ctx.credentials), so a deep sanitizer is overkill. We just scrub obvious
 * secret-looking keys at the top level in case a tool ever forwards them.
 */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (REDACT_KEY_PATTERN.test(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = value;
    }
  }
  return out;
}

interface LogRow {
  user_id: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  status: LogStatus;
  error_message: string | null;
  duration_ms: number;
}

async function insertLog(supabase: any, row: LogRow): Promise<void> {
  try {
    const { error } = await supabase.schema('hub').from('mcp_tool_logs').insert(row);
    if (error) {
      // Don't throw — logging must never break the tool call. Surface to
      // `wrangler tail` so operators still see persistence failures.
      console.error('mcp_tool_logs insert failed:', error.message);
    }
  } catch (err: any) {
    console.error('mcp_tool_logs insert threw:', err?.message ?? err);
  }
}

function emitConsoleLine(row: LogRow) {
  // Structured single-line JSON for `wrangler tail`. Omit args to avoid
  // leaking user content into log streams.
  const { user_id, tool_name, status, error_message, duration_ms } = row;
  console.log(JSON.stringify({ kind: 'mcp_tool_call', user_id, tool_name, status, error_message, duration_ms }));
}

/**
 * Execute a tool and log the result. Fires-and-forgets the DB insert so
 * latency on the hot path is unaffected. If the runtime provides
 * `waitUntil`, we use it so the Worker stays alive long enough to flush.
 */
export async function executeToolWithLogging(
  toolName: string,
  toolArgs: Record<string, unknown>,
  tool: ToolDefinition | ExtensionToolDefinition,
  userId: string,
  supabase: any,
  ctx?: LoggerCtx,
): Promise<ToolResult> {
  const startedAt = Date.now();
  let status: LogStatus;
  let errorMessage: string | null = null;
  let result: ToolResult;

  try {
    result = await executeTool(toolName, toolArgs, tool, userId, supabase);
    if (result.isError) {
      status = 'tool_error';
      // First text block is the error message per toolError() convention.
      const firstText = result.content.find((c) => c.type === 'text')?.text;
      errorMessage = firstText ?? 'Unknown tool error';
    } else {
      status = 'ok';
    }
  } catch (err: any) {
    status = 'exception';
    errorMessage = err?.message ?? String(err);
    result = toolError('An internal error occurred executing the tool.');
  }

  const row: LogRow = {
    user_id: userId,
    tool_name: toolName,
    tool_args: redactArgs(toolArgs ?? {}),
    status,
    error_message: errorMessage,
    duration_ms: Date.now() - startedAt,
  };

  emitConsoleLine(row);

  const writePromise = insertLog(supabase, row);
  if (ctx?.waitUntil) {
    ctx.waitUntil(writePromise);
  } else {
    // Best-effort: swallow rejection (already handled inside insertLog,
    // but double-guard to avoid unhandled rejections in test envs).
    void writePromise.catch(() => {});
  }

  return result;
}
