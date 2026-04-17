import type Anthropic from '@anthropic-ai/sdk';

export type FakeStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal';

export type FakeEvent =
  | { type: 'text'; delta: string; delayMs?: number }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'stop'; reason: FakeStopReason }
  | { type: 'error'; error: Error };

export interface FakeStreamOptions {
  events: FakeEvent[];
  signal?: AbortSignal;
}

type Listener = (...args: unknown[]) => void;

export function createFakeStream(opts: FakeStreamOptions) {
  const listeners: Record<string, Listener[]> = {};
  let finalResolve!: (m: Anthropic.Message) => void;
  let finalReject!: (e: unknown) => void;
  const finalPromise = new Promise<Anthropic.Message>((resolve, reject) => {
    finalResolve = resolve;
    finalReject = reject;
  });

  const stream = {
    on(event: string, listener: Listener) {
      (listeners[event] ??= []).push(listener);
      return stream;
    },
    finalMessage(): Promise<Anthropic.Message> {
      return finalPromise;
    },
  };

  if (opts.signal) {
    opts.signal.addEventListener('abort', () => finalReject(new Error('aborted')));
  }

  (async () => {
    // Yield a microtask so the caller can register listeners (e.g. `stream.on('text', ...)`)
    // before we start emitting events. Matches real Anthropic SDK stream behavior where
    // events are asynchronous relative to the stream() call returning.
    await Promise.resolve();
    const content: Anthropic.ContentBlock[] = [];
    let stopReason: Anthropic.Message['stop_reason'] = null;
    try {
      for (const ev of opts.events) {
        if (opts.signal?.aborted) return;
        if (ev.type === 'text') {
          if (ev.delayMs && ev.delayMs > 0) {
            await new Promise((r) => setTimeout(r, ev.delayMs));
          }
          const last = content[content.length - 1];
          if (last && last.type === 'text') {
            (last as Anthropic.TextBlock).text += ev.delta;
          } else {
            content.push({ type: 'text', text: ev.delta } as Anthropic.TextBlock);
          }
          listeners['text']?.forEach((fn) => fn(ev.delta, ev.delta));
        } else if (ev.type === 'tool_use') {
          content.push({
            type: 'tool_use',
            id: ev.id,
            name: ev.name,
            input: ev.input,
          } as Anthropic.ToolUseBlock);
        } else if (ev.type === 'stop') {
          stopReason = ev.reason;
        } else if (ev.type === 'error') {
          finalReject(ev.error);
          return;
        }
      }
      finalResolve({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content,
        model: 'claude-haiku-4-5-20251001',
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      } as Anthropic.Message);
    } catch (err) {
      finalReject(err);
    }
  })();

  return stream;
}

export type FakeStream = ReturnType<typeof createFakeStream>;
