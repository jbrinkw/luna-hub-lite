import type Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition, ExtensionToolDefinition } from '@luna-hub/app-tools';
import { executeToolWithLogging, type LoggerCtx } from './tool-logger';
import { buildChunk, encodeDataLine, encodeComment, encodeDone, buildErrorChunk } from './sse';
import type { VoiceAckSettings } from './voice-ack';
import { CORS_HEADERS } from './cors';

const MAX_TOOL_ROUNDS = 10;
const KEEPALIVE_INTERVAL_MS = 15_000;

export interface HandleStreamingParams {
  anthropic: Anthropic;
  model: string;
  system: string;
  initialMessages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens: number;
  userTools: Record<string, ToolDefinition | ExtensionToolDefinition>;
  userId: string;
  supabase: any;
  voiceAck: VoiceAckSettings;
  ctx?: LoggerCtx;
}

export function handleStreaming(params: HandleStreamingParams): Response {
  const abortController = new AbortController();
  const encoder = new TextEncoder();
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      runStreamingLoop(controller, params, {
        encoder,
        completionId,
        created,
        abortController,
      }).catch(() => {
        /* runStreamingLoop handles its own errors via SSE */
      });
    },
    cancel() {
      abortController.abort();
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...CORS_HEADERS,
    },
  });
}

interface LoopContext {
  encoder: TextEncoder;
  completionId: string;
  created: number;
  abortController: AbortController;
}

async function runStreamingLoop(
  controller: ReadableStreamDefaultController<Uint8Array>,
  params: HandleStreamingParams,
  ctx: LoopContext,
): Promise<void> {
  const { encoder, completionId, created, abortController } = ctx;
  const { anthropic, model, system, tools, maxTokens, userTools, userId, supabase, voiceAck } = params;

  const writeChunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => {
    try {
      controller.enqueue(encodeDataLine(encoder, buildChunk(completionId, created, model, delta, finish_reason)));
      // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: ReadableStream controller.enqueue throws if the stream is already closed/cancelled — suppress
    } catch {}
  };
  const writeError = (message: string) => {
    try {
      controller.enqueue(encodeDataLine(encoder, buildErrorChunk(message)));
      // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: ReadableStream controller.enqueue throws if the stream is already closed/cancelled — suppress
    } catch {}
  };
  const writeDone = () => {
    try {
      controller.enqueue(encodeDone(encoder));
      // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: ReadableStream controller.enqueue throws if the stream is already closed/cancelled — suppress
    } catch {}
  };

  // Initial role chunk
  writeChunk({ role: 'assistant', content: '' });

  let firstTextEmitted = false;
  let ackTimer: ReturnType<typeof setTimeout> | undefined;

  const emitAck = () => {
    if (firstTextEmitted) return;
    firstTextEmitted = true;
    writeChunk({ content: `${voiceAck.text} ` });
  };

  if (voiceAck.enabled) {
    ackTimer = setTimeout(emitAck, voiceAck.delayMs);
  }

  const keepaliveTimer: ReturnType<typeof setInterval> = setInterval(() => {
    try {
      controller.enqueue(encodeComment(encoder, 'keepalive'));
      // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: ReadableStream controller.enqueue throws if the stream is already closed — suppress
    } catch {}
  }, KEEPALIVE_INTERVAL_MS);

  const onText = (delta: string) => {
    if (!firstTextEmitted) {
      firstTextEmitted = true;
      if (ackTimer) clearTimeout(ackTimer);
    }
    writeChunk({ content: delta });
  };

  const currentMessages: Anthropic.MessageParam[] = [...params.initialMessages];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (abortController.signal.aborted) return;

      const aStream = anthropic.messages.stream(
        {
          model,
          max_tokens: maxTokens,
          system,
          messages: currentMessages,
          tools: tools.length > 0 ? tools : undefined,
        },
        { signal: abortController.signal },
      );
      aStream.on('text', onText);

      const finalMessage = await aStream.finalMessage();

      if (finalMessage.stop_reason === 'tool_use') {
        const toolUseBlocks = finalMessage.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

        if (toolUseBlocks.length === 0) {
          writeChunk({}, 'stop');
          writeDone();
          return;
        }

        currentMessages.push({ role: 'assistant', content: finalMessage.content });

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
          // executeToolWithLogging never throws — internal errors are caught,
          // logged, and returned as a generic tool_error ToolResult.
          const result = await executeToolWithLogging(
            toolUse.name,
            (toolUse.input ?? {}) as Record<string, unknown>,
            tool,
            userId,
            supabase,
            params.ctx,
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result.content
              .filter((c) => c.type === 'text')
              .map((c) => c.text)
              .join('\n'),
            is_error: result.isError ?? false,
          });
        }
        currentMessages.push({ role: 'user', content: toolResults });
        continue;
      }

      // end_turn | stop_sequence | max_tokens | refusal
      const finishReason = finalMessage.stop_reason === 'max_tokens' ? 'length' : 'stop';
      writeChunk({}, finishReason);
      writeDone();
      return;
    }

    // Exceeded MAX_TOOL_ROUNDS
    writeError('Tool round limit exceeded');
    writeDone();
  } catch (err: any) {
    if (abortController.signal.aborted) {
      // Client disconnected — don't emit anything, just close.
      return;
    }
    writeError(formatAnthropicError(err));
    writeDone();
  } finally {
    if (ackTimer) clearTimeout(ackTimer);
    clearInterval(keepaliveTimer);
    try {
      controller.close();
      // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: ReadableStreamDefaultController.close() throws if already closed — suppress
    } catch {}
  }
}

function formatAnthropicError(err: any): string {
  if (err?.status === 401) return 'Invalid Anthropic API key. Update it in Hub > AI Agent.';
  if (err?.status === 429) return 'Anthropic rate limit exceeded. Try again later.';
  return `Anthropic API error: ${err?.message ?? 'Unknown error'}`;
}
