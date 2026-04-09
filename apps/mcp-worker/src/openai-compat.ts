import Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition, ExtensionToolDefinition } from '@luna-hub/app-tools';
import { buildUserTools } from './registry';
import { executeTool } from './tool-executor';
import type { ChatCompletionRequest, ChatCompletionResponse, ChatMessage } from './openai-types';
import { CORS_HEADERS } from './cors';

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
  const currentMessages = [...anthropicMessages];
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
 * Runs the agentic tool loop non-streaming, then emits the final text as a synthetic SSE stream.
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
  const currentMessages = [...initialMessages];

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
