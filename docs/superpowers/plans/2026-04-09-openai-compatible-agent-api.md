# OpenAI-Compatible Agent API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `POST /v1/chat/completions` endpoint to the MCP worker that acts as an OpenAI-compatible agentic API with access to all enabled Luna Hub tools, for use as a Home Assistant voice assistant backbone.

**Architecture:** The endpoint lives on the existing Cloudflare Worker at `mcp.lunahub.dev`. It reuses the auth layer (`authenticateApiKey`/`authenticateJwt`), tool registry (`buildUserTools`), and tool execution patterns from `stateless.ts`. Each request: auth → fetch user's Anthropic key from vault → build tools → call Claude Haiku with agentic loop → return OpenAI-format response. A new "AI Agent" Hub page stores the user's Anthropic API key (encrypted) and custom system prompt.

**Tech Stack:** Cloudflare Workers, Anthropic SDK (`@anthropic-ai/sdk`), Supabase (Postgres + pgcrypto vault), React 18, TanStack Query, Tailwind CSS

---

## File Map

### Worker (apps/mcp-worker/src/)

| File               | Action | Responsibility                                                                                            |
| ------------------ | ------ | --------------------------------------------------------------------------------------------------------- |
| `openai-compat.ts` | Create | Core handler: auth check, fetch Anthropic key, message conversion, agentic tool loop, response formatting |
| `openai-types.ts`  | Create | TypeScript interfaces for OpenAI request/response shapes                                                  |
| `tool-executor.ts` | Create | Shared tool execution logic extracted from stateless.ts (call handler, handle extension creds)            |
| `cors.ts`          | Create | Shared CORS_HEADERS constant (used by index.ts + openai-compat.ts)                                        |
| `index.ts`         | Modify | Add `POST /v1/chat/completions` route, import CORS from shared module                                     |
| `package.json`     | Modify | Add `@anthropic-ai/sdk` dependency                                                                        |
| `wrangler.toml`    | Modify | Add `nodejs_compat` compatibility flag for Anthropic SDK                                                  |

### Database (supabase/migrations/)

| File                                | Action | Responsibility                                                                            |
| ----------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `20260409010000_agent_settings.sql` | Create | `hub.agent_settings` table + vault encrypt/decrypt RPCs for Anthropic key + system prompt |

### Hub UI (apps/web/src/)

| File                           | Action | Responsibility                                                                  |
| ------------------------------ | ------ | ------------------------------------------------------------------------------- |
| `pages/hub/AgentPage.tsx`      | Create | AI Agent settings page: endpoint URL, Anthropic key input, system prompt editor |
| `modules/hub/routes.tsx`       | Modify | Add `/hub/agent` route                                                          |
| `components/hub/HubLayout.tsx` | Modify | Add "AI Agent" to mobile nav items                                              |
| `components/hub/SideNav.tsx`   | Modify | Add "AI Agent" to desktop nav items                                             |
| `shared/queryKeys.ts`          | Modify | Add `agentSettings` query key                                                   |

---

## Task 1: Database — Agent Settings Table + Vault RPCs

**Files:**

- Create: `supabase/migrations/20260409010000_agent_settings.sql`

This stores the user's Anthropic API key (encrypted) and system prompt. Reuses the exact same pgcrypto vault pattern as `extension_settings`.

- [ ] **Step 1: Write the migration**

```sql
-- Agent settings: Anthropic API key (encrypted) + custom system prompt
-- Reuses the same pgcrypto vault pattern as extension credentials

CREATE TABLE hub.agent_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  anthropic_key_encrypted TEXT,
  system_prompt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE hub.agent_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own agent settings"
  ON hub.agent_settings FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can insert own agent settings"
  ON hub.agent_settings FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own agent settings"
  ON hub.agent_settings FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

------------------------------------------------------------
-- Save Anthropic key (encrypted)
------------------------------------------------------------
CREATE OR REPLACE FUNCTION hub.save_agent_anthropic_key(
  p_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enc_key TEXT;
  v_uid UUID;
BEGIN
  v_uid := (SELECT auth.uid());
  v_enc_key := current_setting('app.settings.encryption_key');

  INSERT INTO hub.agent_settings (user_id, anthropic_key_encrypted)
  VALUES (v_uid, pgp_sym_encrypt(p_key, v_enc_key))
  ON CONFLICT (user_id)
  DO UPDATE SET
    anthropic_key_encrypted = pgp_sym_encrypt(p_key, v_enc_key),
    updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION hub.save_agent_anthropic_key(TEXT) TO authenticated;

------------------------------------------------------------
-- Save system prompt (plain text, no encryption needed)
------------------------------------------------------------
CREATE OR REPLACE FUNCTION hub.save_agent_system_prompt(
  p_prompt TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO hub.agent_settings (user_id, system_prompt)
  VALUES ((SELECT auth.uid()), p_prompt)
  ON CONFLICT (user_id)
  DO UPDATE SET system_prompt = p_prompt, updated_at = now();
$$;

GRANT EXECUTE ON FUNCTION hub.save_agent_system_prompt(TEXT) TO authenticated;

------------------------------------------------------------
-- Service-role: get decrypted Anthropic key (for MCP Worker)
------------------------------------------------------------
CREATE OR REPLACE FUNCTION hub.get_agent_anthropic_key_admin(
  p_user_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enc_key TEXT;
  v_encrypted TEXT;
BEGIN
  v_enc_key := current_setting('app.settings.encryption_key');

  SELECT anthropic_key_encrypted INTO v_encrypted
  FROM hub.agent_settings
  WHERE user_id = p_user_id;

  IF v_encrypted IS NULL THEN RETURN NULL; END IF;

  RETURN pgp_sym_decrypt(v_encrypted::bytea, v_enc_key);
END;
$$;

GRANT EXECUTE ON FUNCTION hub.get_agent_anthropic_key_admin(UUID) TO service_role;

------------------------------------------------------------
-- Service-role: get system prompt (for MCP Worker)
------------------------------------------------------------
CREATE OR REPLACE FUNCTION hub.get_agent_system_prompt_admin(
  p_user_id UUID
)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT system_prompt FROM hub.agent_settings WHERE user_id = p_user_id;
$$;

GRANT EXECUTE ON FUNCTION hub.get_agent_system_prompt_admin(UUID) TO service_role;

------------------------------------------------------------
-- Clear Anthropic key
------------------------------------------------------------
CREATE OR REPLACE FUNCTION hub.clear_agent_anthropic_key()
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE hub.agent_settings
  SET anthropic_key_encrypted = NULL, updated_at = now()
  WHERE user_id = (SELECT auth.uid());
$$;

GRANT EXECUTE ON FUNCTION hub.clear_agent_anthropic_key() TO authenticated;
```

- [ ] **Step 2: Apply migration**

Run: `cd /home/jeremy/luna-hub-lite && npx supabase db push`
Expected: Migration applied successfully.

- [ ] **Step 3: Verify**

Run: `cd /home/jeremy/luna-hub-lite && npx supabase test db`
Expected: Existing pgTAP tests still pass. New table visible in schema.

- [ ] **Step 4: Regenerate DB types**

Run: `cd /home/jeremy/luna-hub-lite && pnpm run gen:types`
Expected: `packages/db-types/` updated with new `agent_settings` table types.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260409010000_agent_settings.sql packages/db-types/
git commit -m "feat(db): add hub.agent_settings table with vault RPCs for AI agent"
```

---

## Task 2: Worker — Shared Tool Executor

Extract tool execution logic from `stateless.ts` into a reusable module that both the MCP handler and the OpenAI-compat handler can call.

**Files:**

- Create: `apps/mcp-worker/src/tool-executor.ts`
- Modify: `apps/mcp-worker/src/stateless.ts` (import from new module)

- [ ] **Step 1: Create tool-executor.ts**

```typescript
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
  toolName: string,
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
    const extensionName = (tool as ExtensionToolDefinition).extensionName;
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

    const { data: decryptedJson, error: decryptErr } = await supabase
      .schema('hub')
      .rpc('get_extension_credentials_admin', {
        p_user_id: userId,
        p_extension_name: extensionName,
      });

    if (decryptErr || !decryptedJson) {
      return toolError(`Configure ${extensionName} credentials in Hub settings.`);
    }

    let credentials: Record<string, string>;
    try {
      credentials = JSON.parse(decryptedJson);
    } catch {
      return toolError('Failed to parse extension credentials.');
    }

    const extCtx: ExtensionToolContext = { ...toolCtx, credentials };
    return tool.handler(toolArgs, extCtx);
  }

  return tool.handler(toolArgs, toolCtx);
}
```

- [ ] **Step 2: Refactor stateless.ts to use executeTool**

In `apps/mcp-worker/src/stateless.ts`, replace the `tools/call` case body (lines 54-117) to use the shared executor:

```typescript
// At top of file, add import:
import { executeTool } from './tool-executor';

// Replace the tools/call case:
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
    return jsonRpcSuccess(rpc.id, toolError(`Tool error: ${err.message}`));
  }
}
```

- [ ] **Step 3: Verify existing MCP tests pass**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/mcp-worker test`
Expected: All existing tests pass (the refactor is behavior-preserving).

- [ ] **Step 4: Commit**

```bash
git add apps/mcp-worker/src/tool-executor.ts apps/mcp-worker/src/stateless.ts
git commit -m "refactor(mcp): extract shared tool executor from stateless handler"
```

---

## Task 3: Worker — OpenAI Types

**Files:**

- Create: `apps/mcp-worker/src/openai-types.ts`

- [ ] **Step 1: Create type definitions**

```typescript
/** OpenAI Chat Completions API request shape */
export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: OpenAITool[];
  tool_choice?: 'auto' | 'required' | 'none';
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** OpenAI Chat Completions API response shape */
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: 'stop' | 'tool_calls' | 'length' | null;
}

/** Streaming chunk */
export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: Partial<ChatMessage>;
  finish_reason: 'stop' | 'tool_calls' | 'length' | null;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/mcp-worker/src/openai-types.ts
git commit -m "feat(mcp): add OpenAI-compatible API type definitions"
```

---

## Task 4: Worker — Add Anthropic SDK Dependency

**Files:**

- Modify: `apps/mcp-worker/package.json`

- [ ] **Step 1: Install the SDK**

Run: `cd /home/jeremy/luna-hub-lite/apps/mcp-worker && pnpm add @anthropic-ai/sdk`

- [ ] **Step 1b: Add nodejs_compat flag to wrangler.toml**

The Anthropic SDK uses Node.js APIs internally. Cloudflare Workers require the `nodejs_compat` compatibility flag.

In `apps/mcp-worker/wrangler.toml`, add after the `compatibility_date` line:

```toml
compatibility_flags = ["nodejs_compat"]
```

- [ ] **Step 2: Verify build**

Run: `cd /home/jeremy/luna-hub-lite/apps/mcp-worker && pnpm run build`
Expected: Build succeeds. The SDK bundles for Cloudflare Workers.

- [ ] **Step 3: Verify typecheck**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/mcp-worker typecheck`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add apps/mcp-worker/package.json pnpm-lock.yaml
git commit -m "feat(mcp): add @anthropic-ai/sdk dependency for agent API"
```

---

## Task 5: Worker — OpenAI-Compatible Handler (Core)

The main handler file. Implements the agentic loop: receive OpenAI-format request → convert to Anthropic format → call Haiku → execute tool calls → loop until text response → convert back to OpenAI format.

**Files:**

- Create: `apps/mcp-worker/src/openai-compat.ts`

- [ ] **Step 1: Create the handler**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition, ExtensionToolDefinition } from '@luna-hub/app-tools';
import { buildUserTools } from './registry';
import { executeTool } from './tool-executor';
import { CORS_HEADERS } from './cors';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ToolCall,
  ChatCompletionChunk,
} from './openai-types';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOOL_ROUNDS = 10;

const DEFAULT_SYSTEM_PROMPT = `You are Luna, a helpful voice assistant. You have access to tools for managing workouts (CoachByte), food/nutrition (ChefByte), tasks (Todoist), and smart home devices (Home Assistant). Keep responses concise and conversational — the user is talking to you via voice. When calling tools, explain what you're doing briefly. If a tool fails, tell the user plainly.`;

/**
 * Handle an OpenAI-compatible POST /v1/chat/completions request.
 * Runs an agentic loop with Claude Haiku and the user's enabled tools.
 */
export async function handleChatCompletion(request: Request, userId: string, supabase: any): Promise<Response> {
  // 1. Parse request body
  let body: ChatCompletionRequest;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return jsonError('messages array is required', 400);
  }

  // 2. Fetch user's Anthropic API key from vault
  const { data: anthropicKey, error: keyErr } = await supabase
    .schema('hub')
    .rpc('get_agent_anthropic_key_admin', { p_user_id: userId });

  if (keyErr || !anthropicKey) {
    return jsonError('Anthropic API key not configured. Set it in Hub > AI Agent settings.', 422);
  }

  // 3. Fetch user's custom system prompt (or use default)
  const { data: customPrompt } = await supabase
    .schema('hub')
    .rpc('get_agent_system_prompt_admin', { p_user_id: userId });

  const systemPrompt = customPrompt || DEFAULT_SYSTEM_PROMPT;

  // 4. Build user's enabled tools
  const userTools = await buildUserTools(supabase, userId);

  // 5. Convert tools to Anthropic format
  const anthropicTools = Object.values(userTools).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
  }));

  // 6. Convert OpenAI messages to Anthropic format
  const { system, messages: anthropicMessages } = convertMessages(body.messages, systemPrompt);

  // 7. Create Anthropic client with user's key
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  const model = DEFAULT_MODEL; // Always use Haiku regardless of what client sends
  const maxTokens = Math.min(body.max_tokens ?? 4096, 8192);

  // 8. Check if streaming requested
  if (body.stream) {
    return handleStreaming(
      anthropic,
      model,
      system,
      anthropicMessages,
      anthropicTools,
      maxTokens,
      userTools,
      userId,
      supabase,
    );
  }

  // 9. Non-streaming agentic loop
  let currentMessages = [...anthropicMessages];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: currentMessages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    if (response.stop_reason === 'tool_use') {
      // Extract tool use blocks
      const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

      if (toolUseBlocks.length === 0) break;

      // Add assistant message with all content blocks
      currentMessages.push({ role: 'assistant', content: response.content });

      // Execute each tool and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        const tool = userTools[toolUse.name];
        if (!tool) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Unknown tool: ${toolUse.name}`,
            is_error: true,
          });
          continue;
        }

        try {
          const result = await executeTool(
            toolUse.name,
            (toolUse.input ?? {}) as Record<string, unknown>,
            tool,
            userId,
            supabase,
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result.content.map((c) => c.text).join('\n'),
            is_error: result.isError ?? false,
          });
        } catch (err: any) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Tool error: ${err.message}`,
            is_error: true,
          });
        }
      }

      currentMessages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Not a tool_use stop — extract text and return
    const textContent = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return formatCompletionResponse(textContent, model, totalInputTokens, totalOutputTokens, response.stop_reason);
  }

  // Exceeded max rounds — return whatever we have
  return formatCompletionResponse(
    'I was unable to complete the request within the allowed number of steps.',
    model,
    totalInputTokens,
    totalOutputTokens,
    'stop',
  );
}

/**
 * Handle streaming response.
 * Runs the agentic tool loop non-streaming, then streams ONLY the final turn.
 * This avoids double-generating the final response.
 */
async function handleStreaming(
  anthropic: Anthropic,
  model: string,
  system: string,
  initialMessages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
  maxTokens: number,
  userTools: Record<string, ToolDefinition | ExtensionToolDefinition>,
  userId: string,
  supabase: any,
): Promise<Response> {
  let currentMessages = [...initialMessages];

  // Run tool loop (non-streaming) until the last round needs a text response
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: currentMessages,
      tools: tools.length > 0 ? tools : undefined,
    });

    if (response.stop_reason !== 'tool_use') {
      // Not a tool call — we have the final text. Emit it as a synthetic SSE stream.
      const textContent = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return emitSyntheticStream(textContent, model);
    }

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) break;

    currentMessages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      const tool = userTools[toolUse.name];
      if (!tool) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Unknown tool: ${toolUse.name}`,
          is_error: true,
        });
        continue;
      }
      try {
        const result = await executeTool(
          toolUse.name,
          (toolUse.input ?? {}) as Record<string, unknown>,
          tool,
          userId,
          supabase,
        );
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.content.map((c) => c.text).join('\n'),
          is_error: result.isError ?? false,
        });
      } catch (err: any) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Tool error: ${err.message}`,
          is_error: true,
        });
      }
    }
    currentMessages.push({ role: 'user', content: toolResults });
  }

  // Exceeded max rounds
  return emitSyntheticStream('I was unable to complete the request within the allowed number of steps.', model);
}

/**
 * Emit already-obtained text as a synthetic OpenAI SSE stream.
 * Sends the text in one chunk followed by [DONE].
 */
function emitSyntheticStream(text: string, model: string): Response {
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();

  const body = [
    `data: ${JSON.stringify({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');

  return new Response(encoder.encode(body), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...CORS_HEADERS,
    },
  });
}

/**
 * Convert OpenAI messages to Anthropic format.
 * Extracts system messages separately and maps tool call/result messages.
 */
function convertMessages(
  openaiMessages: ChatMessage[],
  defaultSystem: string,
): { system: string; messages: Anthropic.MessageParam[] } {
  const systemParts: string[] = [];
  const messages: Anthropic.MessageParam[] = [];

  for (const msg of openaiMessages) {
    if (msg.role === 'system') {
      if (msg.content) systemParts.push(msg.content);
      continue;
    }

    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content || '' });
      continue;
    }

    if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant message with tool calls
        const content: Anthropic.ContentBlockParam[] = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }
        messages.push({ role: 'assistant', content });
      } else {
        messages.push({ role: 'assistant', content: msg.content || '' });
      }
      continue;
    }

    if (msg.role === 'tool') {
      // Tool result — find or create a user message with tool_result blocks
      const lastMsg = messages[messages.length - 1];
      const toolResult: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id || '',
        content: msg.content || '',
      };

      if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
        (lastMsg.content as Anthropic.ToolResultBlockParam[]).push(toolResult);
      } else {
        messages.push({ role: 'user', content: [toolResult] });
      }
      continue;
    }
  }

  // Always include the user's configured prompt. Client system messages augment it.
  const system = [defaultSystem, ...systemParts].filter(Boolean).join('\n\n');
  return { system, messages };
}

/** Format a non-streaming OpenAI completion response */
function formatCompletionResponse(
  text: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  stopReason: string | null,
): Response {
  const response: ChatCompletionResponse = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: stopReason === 'max_tokens' ? 'length' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };

  return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { message, type: 'invalid_request_error' } }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/mcp-worker typecheck`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/mcp-worker/src/openai-compat.ts
git commit -m "feat(mcp): add OpenAI-compatible chat completions handler with agentic tool loop"
```

---

## Task 6: Worker — Route Wiring in index.ts

**Files:**

- Create: `apps/mcp-worker/src/cors.ts`
- Modify: `apps/mcp-worker/src/index.ts`

- [ ] **Step 0: Create shared CORS module**

Create `apps/mcp-worker/src/cors.ts`:

```typescript
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};
```

Then update `index.ts` to import from it instead of defining inline:

```typescript
// Remove the local CORS_HEADERS const and add:
import { CORS_HEADERS } from './cors';
```

- [ ] **Step 1: Add import and route**

At top of `index.ts`, add:

```typescript
import { handleChatCompletion } from './openai-compat';
```

After the health check block (around line 94) and before the MCP routes, add the OpenAI-compat route:

```typescript
// ─── OpenAI-compatible Chat Completions API ────────────────────────
// Used by Home Assistant voice assistant via extended_openai_conversation.
// Auth: Bearer token (same API keys as MCP).
if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
  const authHeader = request.headers.get('Authorization');
  let userId: string | null = null;
  const supabase = createServiceClient(env);

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    userId = await authenticateJwt(supabase, token);
    if (!userId) {
      userId = await authenticateApiKey(supabase, token);
    }
  }

  if (!userId) {
    return new Response(JSON.stringify({ error: { message: 'Invalid API key', type: 'authentication_error' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  return handleChatCompletion(request, userId, supabase);
}

// GET /v1/models — return available model list (for client compatibility)
if (url.pathname === '/v1/models' && request.method === 'GET') {
  return new Response(
    JSON.stringify({
      object: 'list',
      data: [{ id: 'claude-haiku-4-5-20251001', object: 'model', owned_by: 'anthropic' }],
    }),
    { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd /home/jeremy/luna-hub-lite/apps/mcp-worker && pnpm run build`
Expected: Build succeeds.

- [ ] **Step 3: Verify existing tests pass**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/mcp-worker test`
Expected: All existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add apps/mcp-worker/src/index.ts
git commit -m "feat(mcp): wire OpenAI-compat /v1/chat/completions route"
```

---

## Task 7: Worker — Deploy and Smoke Test

- [ ] **Step 1: Deploy**

Run: `cd /home/jeremy/luna-hub-lite/apps/mcp-worker && npx wrangler deploy`
Expected: Deploy succeeds.

- [ ] **Step 2: Verify health**

Run: `curl -s https://mcp.lunahub.dev/health`
Expected: `ok`

- [ ] **Step 3: Verify auth rejection**

Run: `curl -s -X POST https://mcp.lunahub.dev/v1/chat/completions -H 'Content-Type: application/json' -d '{"messages":[]}'`
Expected: 401 with `authentication_error`

- [ ] **Step 4: Verify models endpoint**

Run: `curl -s https://mcp.lunahub.dev/v1/models`
Expected: JSON with `claude-haiku-4-5-20251001` model listed.

- [ ] **Step 5: Verify MCP still works**

Run: `curl -s -o /dev/null -w "%{http_code}" -X POST https://mcp.lunahub.dev/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}'`
Expected: `401` (auth required — same as before).

---

## Task 8: Hub UI — Agent Settings Page

**Files:**

- Create: `apps/web/src/pages/hub/AgentPage.tsx`
- Modify: `apps/web/src/modules/hub/routes.tsx`
- Modify: `apps/web/src/components/hub/HubLayout.tsx`
- Modify: `apps/web/src/components/hub/SideNav.tsx`
- Modify: `apps/web/src/shared/queryKeys.ts`

- [ ] **Step 1: Add query key**

In `apps/web/src/shared/queryKeys.ts`, add after the `extensions` key:

```typescript
  agentSettings: (userId: string) => ['agent-settings', userId] as const,
```

- [ ] **Step 2: Create AgentPage.tsx**

```tsx
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { HubLayout } from '@/components/hub/HubLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { CardSkeleton } from '@/components/ui/Skeleton';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Copy, Check } from 'lucide-react';

const DEFAULT_SYSTEM_PROMPT = `You are Luna, a helpful voice assistant. You have access to tools for managing workouts (CoachByte), food/nutrition (ChefByte), tasks (Todoist), and smart home devices (Home Assistant). Keep responses concise and conversational — the user is talking to you via voice. When calling tools, explain what you're doing briefly. If a tool fails, tell the user plainly.`;

export function AgentPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [endpointCopied, setEndpointCopied] = useState(false);

  const [apiKey, setApiKey] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [keySaveError, setKeySaveError] = useState<string | null>(null);
  const [keySaveSuccess, setKeySaveSuccess] = useState(false);
  const [promptSaveError, setPromptSaveError] = useState<string | null>(null);
  const [promptSaveSuccess, setPromptSaveSuccess] = useState(false);

  const endpointUrl = `${import.meta.env.VITE_MCP_URL ?? 'https://mcp.lunahub.dev'}/v1`;

  // Load agent settings
  const { data: settings, isLoading } = useQuery({
    queryKey: queryKeys.agentSettings(user!.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('hub')
        .from('agent_settings')
        .select('anthropic_key_encrypted, system_prompt')
        .eq('user_id', user!.id)
        .maybeSingle();
      if (error) throw error;
      return {
        hasKey: !!data?.anthropic_key_encrypted,
        systemPrompt: data?.system_prompt || '',
      };
    },
    enabled: !!user,
  });

  // Initialize system prompt field from loaded data
  useEffect(() => {
    if (settings) {
      setSystemPrompt(settings.systemPrompt);
    }
  }, [settings]);

  // Save API key mutation
  const saveKeyMutation = useMutation({
    mutationFn: async (key: string) => {
      const { error } = await supabase.schema('hub').rpc('save_agent_anthropic_key', {
        p_key: key,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setKeySaveSuccess(true);
      setApiKey('');
      queryClient.invalidateQueries({ queryKey: queryKeys.agentSettings(user!.id) });
    },
    onError: (err: Error) => setKeySaveError(err.message),
  });

  // Clear API key mutation
  const clearKeyMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.schema('hub').rpc('clear_agent_anthropic_key');
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentSettings(user!.id) });
      setKeySaveSuccess(false);
    },
    onError: (err: Error) => setKeySaveError(err.message),
  });

  // Save system prompt mutation
  const savePromptMutation = useMutation({
    mutationFn: async (prompt: string) => {
      const { error } = await supabase.schema('hub').rpc('save_agent_system_prompt', {
        p_prompt: prompt,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setPromptSaveSuccess(true);
      queryClient.invalidateQueries({ queryKey: queryKeys.agentSettings(user!.id) });
    },
    onError: (err: Error) => setPromptSaveError(err.message),
  });

  const handleCopyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(endpointUrl);
      setEndpointCopied(true);
      setTimeout(() => setEndpointCopied(false), 2000);
    } catch {
      // Clipboard API may not be available
    }
  };

  const handleSaveKey = () => {
    setKeySaveError(null);
    setKeySaveSuccess(false);
    if (!apiKey.trim()) {
      setKeySaveError('API key is required');
      return;
    }
    saveKeyMutation.mutate(apiKey.trim());
  };

  const handleSavePrompt = () => {
    setPromptSaveError(null);
    setPromptSaveSuccess(false);
    savePromptMutation.mutate(systemPrompt);
  };

  const handleResetPrompt = () => {
    setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
    setPromptSaveSuccess(false);
  };

  if (isLoading) {
    return (
      <HubLayout title="AI Agent">
        <div className="space-y-6">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </HubLayout>
    );
  }

  return (
    <HubLayout title="AI Agent">
      <div className="space-y-6">
        {/* Endpoint URL */}
        <Card>
          <CardHeader>
            <CardTitle>API Endpoint</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-text-secondary">
              Use this as the base URL in your Home Assistant OpenAI-compatible integration. Authenticate with the same
              API keys from MCP Settings.
            </p>
            <div className="flex items-center gap-2">
              <code className="text-sm bg-code-bg px-3 py-1.5 rounded-md text-code-text flex-1 break-all">
                {endpointUrl}
              </code>
              <Button variant="secondary" size="sm" onClick={handleCopyEndpoint}>
                {endpointCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {endpointCopied ? 'Copied!' : 'Copy'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Anthropic API Key */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Anthropic API Key</CardTitle>
              {settings?.hasKey ? (
                <Badge variant="success">Configured</Badge>
              ) : (
                <Badge variant="warning">Not configured</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-text-secondary">
              Your Anthropic API key is used to call Claude Haiku for each voice request. The key is stored encrypted
              and never exposed after saving.
            </p>
            <Input
              label="API Key"
              type="password"
              placeholder="sk-ant-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <div className="flex gap-2">
              <Button onClick={handleSaveKey} loading={saveKeyMutation.isPending} size="sm">
                {settings?.hasKey ? 'Update Key' : 'Save Key'}
              </Button>
              {settings?.hasKey && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={clearKeyMutation.isPending}
                  onClick={() => {
                    setKeySaveError(null);
                    setKeySaveSuccess(false);
                    clearKeyMutation.mutate();
                  }}
                >
                  Remove Key
                </Button>
              )}
            </div>
            {keySaveError && <Alert variant="error">{keySaveError}</Alert>}
            {keySaveSuccess && <Alert variant="success">API key saved</Alert>}
          </CardContent>
        </Card>

        {/* System Prompt */}
        <Card>
          <CardHeader>
            <CardTitle>System Prompt</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-text-secondary">
              Customize how Luna responds to voice commands. This prompt is sent with every request.
            </p>
            <textarea
              className="w-full min-h-[160px] px-3 py-2 text-sm rounded-md border border-border bg-surface text-text resize-y focus:outline-none focus:ring-2 focus:ring-focus-ring"
              value={systemPrompt}
              onChange={(e) => {
                setSystemPrompt(e.target.value);
                setPromptSaveSuccess(false);
              }}
              placeholder={DEFAULT_SYSTEM_PROMPT}
            />
            <div className="flex gap-2">
              <Button onClick={handleSavePrompt} loading={savePromptMutation.isPending} size="sm">
                Save Prompt
              </Button>
              <Button variant="secondary" size="sm" onClick={handleResetPrompt}>
                Reset to Default
              </Button>
            </div>
            {promptSaveError && <Alert variant="error">{promptSaveError}</Alert>}
            {promptSaveSuccess && <Alert variant="success">System prompt saved</Alert>}
          </CardContent>
        </Card>
      </div>
    </HubLayout>
  );
}
```

- [ ] **Step 3: Add route**

In `apps/web/src/modules/hub/routes.tsx`, add import and route:

```typescript
import { AgentPage } from '@/pages/hub/AgentPage';

// Inside <Routes>, add before the catch-all:
<Route path="agent" element={<AgentPage />} />
```

- [ ] **Step 4: Add to SideNav**

In `apps/web/src/components/hub/SideNav.tsx`, add import and nav item:

```typescript
import { User, LayoutGrid, Wrench, Puzzle, KeyRound, Bot } from 'lucide-react';

// Add to navItems array:
{ label: 'AI Agent', path: '/hub/agent', icon: Bot },
```

- [ ] **Step 5: Add to HubLayout mobile nav**

In `apps/web/src/components/hub/HubLayout.tsx`, add import and nav item:

```typescript
import { Menu, X, User, LayoutGrid, Wrench, Puzzle, KeyRound, Bot } from 'lucide-react';

// Add to mobileNavItems array:
{ label: 'AI Agent', path: '/hub/agent', icon: Bot },
```

- [ ] **Step 6: Verify dev server**

Run: `cd /home/jeremy/luna-hub-lite && pnpm --filter @luna-hub/web dev`
Navigate to `http://localhost:5173/hub/agent`
Expected: Page renders with endpoint URL, API key input, system prompt editor.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/hub/AgentPage.tsx apps/web/src/modules/hub/routes.tsx \
  apps/web/src/components/hub/SideNav.tsx apps/web/src/components/hub/HubLayout.tsx \
  apps/web/src/shared/queryKeys.ts
git commit -m "feat(hub): add AI Agent settings page with Anthropic key + system prompt"
```

---

## Task 9: End-to-End Test — Manual Verification

- [ ] **Step 1: Set Anthropic key via Hub UI**

Navigate to `/hub/agent`, paste Anthropic API key, save.

- [ ] **Step 2: Test non-streaming**

```bash
curl -s -X POST https://mcp.lunahub.dev/v1/chat/completions \
  -H "Authorization: Bearer <your-luna-hub-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "messages": [{"role": "user", "content": "What Todoist projects do I have?"}]
  }' | python3 -m json.tool
```

Expected: Response in OpenAI format with a text answer listing Todoist projects.

- [ ] **Step 3: Test streaming**

```bash
curl -s -N -X POST https://mcp.lunahub.dev/v1/chat/completions \
  -H "Authorization: Bearer <your-luna-hub-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

Expected: SSE stream with `data: {...}` chunks followed by `data: [DONE]`.

- [ ] **Step 4: Test tool call**

```bash
curl -s -X POST https://mcp.lunahub.dev/v1/chat/completions \
  -H "Authorization: Bearer <your-luna-hub-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "messages": [{"role": "user", "content": "Turn on the living room lights"}]
  }' | python3 -m json.tool
```

Expected: Response mentioning it called the Home Assistant tool (or error about HA credentials).

- [ ] **Step 5: Update docs**

Update `docs/mcp/guide.md` to document the new `/v1/chat/completions` endpoint, auth, and HA integration setup.

- [ ] **Step 6: Commit docs**

```bash
git add docs/
git commit -m "docs: add AI Agent API documentation"
```
