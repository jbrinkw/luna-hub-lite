import { describe, it, expect, vi } from 'vitest';
import { handleStreaming } from '../chat-streaming';
import { createFakeStream } from './helpers/fake-anthropic';
import { readSse, dataChunks } from './helpers/read-sse';
import { DEFAULT_VOICE_ACK } from '../voice-ack';

const baseParams = {
  model: 'claude-haiku-4-5-20251001',
  system: 'sys',
  initialMessages: [{ role: 'user' as const, content: 'hi' }],
  tools: [],
  maxTokens: 4096,
  userTools: {},
  userId: 'user-1',
  supabase: {} as any,
  voiceAck: DEFAULT_VOICE_ACK,
};

describe('handleStreaming — direct text', () => {
  it('streams multi-delta text as OpenAI SSE chunks ending in finish stop + DONE', async () => {
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation(() =>
          createFakeStream({
            events: [
              { type: 'text', delta: 'Hello ' },
              { type: 'text', delta: 'world' },
              { type: 'stop', reason: 'end_turn' },
            ],
          }),
        ),
      },
    } as any;

    const response = handleStreaming({ ...baseParams, anthropic });
    const events = await readSse(response);
    const chunks = dataChunks(events);

    // role chunk, "Hello ", "world", finish stop
    expect(chunks).toHaveLength(4);
    expect(chunks[0]).toMatchObject({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });
    expect(chunks[1].choices[0].delta).toEqual({ content: 'Hello ' });
    expect(chunks[2].choices[0].delta).toEqual({ content: 'world' });
    expect(chunks[3].choices[0]).toEqual({ index: 0, delta: {}, finish_reason: 'stop' });
    // Terminator
    expect(events[events.length - 1]).toEqual({ kind: 'done' });
  });
});

describe('handleStreaming — tool rounds', () => {
  function makeUserTool(name: string, handler: (args: any) => any) {
    return {
      name,
      description: 'test',
      inputSchema: { type: 'object' as const, properties: {} },
      handler: async (args: any) => ({ content: [{ type: 'text', text: JSON.stringify(await handler(args)) }] }),
    };
  }

  it('executes tool_use, feeds result back, streams round-2 text', async () => {
    const calls: any[] = [];
    const userTools = {
      FOO: makeUserTool('FOO', (args) => {
        calls.push(args);
        return { ok: true };
      }),
    };

    let callIndex = 0;
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation(() => {
          callIndex++;
          if (callIndex === 1) {
            return createFakeStream({
              events: [
                { type: 'text', delta: 'Let me check… ' },
                { type: 'tool_use', id: 'tu_1', name: 'FOO', input: { x: 1 } },
                { type: 'stop', reason: 'tool_use' },
              ],
            });
          }
          return createFakeStream({
            events: [
              { type: 'text', delta: 'Done.' },
              { type: 'stop', reason: 'end_turn' },
            ],
          });
        }),
      },
    } as any;

    const response = handleStreaming({
      ...baseParams,
      anthropic,
      userTools: userTools as any,
    });
    const events = await readSse(response);
    const chunks = dataChunks(events);

    // role, "Let me check… ", "Done.", finish stop, [DONE]
    const contents = chunks
      .map((c: any) => c.choices[0].delta.content)
      .filter((x: unknown) => typeof x === 'string' && x.length > 0);
    expect(contents).toEqual(['Let me check… ', 'Done.']);
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
    expect(calls).toEqual([{ x: 1 }]);
    expect(anthropic.messages.stream).toHaveBeenCalledTimes(2);
  });

  it('records tool error and continues loop when tool handler throws', async () => {
    const userTools = {
      FOO: {
        name: 'FOO',
        description: 'test',
        inputSchema: { type: 'object' as const, properties: {} },
        handler: async () => {
          throw new Error('boom');
        },
      },
    };

    let secondCallArgs: any = null;
    let callIndex = 0;
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation((args: any) => {
          callIndex++;
          if (callIndex === 1) {
            return createFakeStream({
              events: [
                { type: 'tool_use', id: 'tu_1', name: 'FOO', input: {} },
                { type: 'stop', reason: 'tool_use' },
              ],
            });
          }
          secondCallArgs = args;
          return createFakeStream({
            events: [
              { type: 'text', delta: 'Sorry, that failed.' },
              { type: 'stop', reason: 'end_turn' },
            ],
          });
        }),
      },
    } as any;

    const response = handleStreaming({
      ...baseParams,
      anthropic,
      userTools: userTools as any,
    });
    const events = await readSse(response);
    const chunks = dataChunks(events);

    expect(chunks.some((c: any) => c.choices[0].delta.content === 'Sorry, that failed.')).toBe(true);
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');

    // Verify the tool_result block sent back to Anthropic on the second call
    // records the error (is_error=true) with a meaningful message.
    const lastMsg = secondCallArgs.messages[secondCallArgs.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toHaveLength(1);
    expect(lastMsg.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      is_error: true,
    });
    expect(lastMsg.content[0].content).toMatch(/An internal error occurred|Tool error|boom/);
  });

  it('handles unknown tool name with is_error tool_result, loop continues', async () => {
    let secondCallArgs: any = null;
    let callIndex = 0;
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation((args: any) => {
          callIndex++;
          if (callIndex === 1) {
            return createFakeStream({
              events: [
                { type: 'tool_use', id: 'tu_1', name: 'NOPE', input: {} },
                { type: 'stop', reason: 'tool_use' },
              ],
            });
          }
          secondCallArgs = args;
          return createFakeStream({
            events: [
              { type: 'text', delta: 'no such tool' },
              { type: 'stop', reason: 'end_turn' },
            ],
          });
        }),
      },
    } as any;

    const response = handleStreaming({ ...baseParams, anthropic });
    const events = await readSse(response);
    const chunks = dataChunks(events);
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');

    // Verify the unknown-tool tool_result block is shaped correctly.
    const lastMsg = secondCallArgs.messages[secondCallArgs.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toHaveLength(1);
    expect(lastMsg.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'Unknown tool: NOPE',
      is_error: true,
    });
  });

  it('executes two parallel tool_use blocks serially and sends results in one user message', async () => {
    const calls: string[] = [];
    const timings: { tool: string; startedAt: number; endedAt: number }[] = [];
    const userTools = {
      A: {
        name: 'A',
        description: '',
        inputSchema: { type: 'object' as const, properties: {} },
        handler: async () => {
          const startedAt = Date.now();
          calls.push('A');
          await new Promise((r) => setTimeout(r, 50));
          timings.push({ tool: 'A', startedAt, endedAt: Date.now() });
          return { content: [{ type: 'text' as const, text: 'a-result' }] };
        },
      },
      B: {
        name: 'B',
        description: '',
        inputSchema: { type: 'object' as const, properties: {} },
        handler: async () => {
          const startedAt = Date.now();
          calls.push('B');
          timings.push({ tool: 'B', startedAt, endedAt: Date.now() });
          return { content: [{ type: 'text' as const, text: 'b-result' }] };
        },
      },
    };

    let secondCallArgs: any = null;
    let callIndex = 0;
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation((args: any) => {
          callIndex++;
          if (callIndex === 1) {
            return createFakeStream({
              events: [
                { type: 'tool_use', id: 'tu_1', name: 'A', input: {} },
                { type: 'tool_use', id: 'tu_2', name: 'B', input: {} },
                { type: 'stop', reason: 'tool_use' },
              ],
            });
          }
          secondCallArgs = args;
          return createFakeStream({
            events: [
              { type: 'text', delta: 'both done' },
              { type: 'stop', reason: 'end_turn' },
            ],
          });
        }),
      },
    } as any;

    const response = handleStreaming({
      ...baseParams,
      anthropic,
      userTools: userTools as any,
    });
    await readSse(response);

    expect(calls).toEqual(['A', 'B']);
    // Second Anthropic call's last message is a user message with two tool_result blocks
    const lastMsg = secondCallArgs.messages[secondCallArgs.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toHaveLength(2);
    expect(lastMsg.content[0].tool_use_id).toBe('tu_1');
    expect(lastMsg.content[1].tool_use_id).toBe('tu_2');

    // Serial execution: B's start must be after A's end (minus small scheduling slack).
    // With Promise.all this would fail — both would start within microseconds of each other.
    const aRun = timings.find((t) => t.tool === 'A')!;
    const bRun = timings.find((t) => t.tool === 'B')!;
    expect(bRun.startedAt).toBeGreaterThanOrEqual(aRun.endedAt - 5);
  });
});

describe('handleStreaming — stop reasons and errors', () => {
  it('maps stop_reason=max_tokens to finish_reason=length', async () => {
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation(() =>
          createFakeStream({
            events: [
              { type: 'text', delta: 'partial' },
              { type: 'stop', reason: 'max_tokens' },
            ],
          }),
        ),
      },
    } as any;

    const response = handleStreaming({ ...baseParams, anthropic });
    const chunks = dataChunks(await readSse(response));
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('length');
  });

  it('emits error chunk + DONE when MAX_TOOL_ROUNDS exceeded', async () => {
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation(() =>
          createFakeStream({
            events: [
              { type: 'tool_use', id: 'tu_1', name: 'X', input: {} },
              { type: 'stop', reason: 'tool_use' },
            ],
          }),
        ),
      },
    } as any;
    const userTools = {
      X: {
        name: 'X',
        description: '',
        inputSchema: { type: 'object' as const, properties: {} },
        handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
      },
    };

    const response = handleStreaming({ ...baseParams, anthropic, userTools: userTools as any });
    const events = await readSse(response);
    const payloads = dataChunks(events);
    const lastPayload = payloads[payloads.length - 1] as any;
    expect(lastPayload).toEqual({ error: { message: 'Tool round limit exceeded', type: 'server_error' } });
    expect(events[events.length - 1]).toEqual({ kind: 'done' });
  });

  it('emits Anthropic 401 as server_error chunk with actionable message', async () => {
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation(() =>
          createFakeStream({
            events: [{ type: 'error', error: Object.assign(new Error('unauthorized'), { status: 401 }) }],
          }),
        ),
      },
    } as any;

    const response = handleStreaming({ ...baseParams, anthropic });
    const events = await readSse(response);
    const payloads = dataChunks(events) as any[];
    const errPayload = payloads.find((p) => p.error);
    expect(errPayload.error.message).toMatch(/Invalid Anthropic API key/);
    expect(events[events.length - 1]).toEqual({ kind: 'done' });
  });

  it('emits rate-limit message on Anthropic 429', async () => {
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation(() =>
          createFakeStream({
            events: [{ type: 'error', error: Object.assign(new Error('rate'), { status: 429 }) }],
          }),
        ),
      },
    } as any;

    const response = handleStreaming({ ...baseParams, anthropic });
    const payloads = dataChunks(await readSse(response)) as any[];
    const errPayload = payloads.find((p) => p.error);
    expect(errPayload.error.message).toMatch(/rate limit/i);
  });
});

describe('handleStreaming — voice ACK timer', () => {
  it('does NOT emit ACK when voice_ack_enabled=false even with long silence', async () => {
    // Use a short delayMs (10ms) that WOULD fire before the text delta (100ms)
    // if the `enabled` guard were removed. This makes the guard falsifiable.
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation(() =>
          createFakeStream({
            events: [
              { type: 'text', delta: 'slow', delayMs: 100 },
              { type: 'stop', reason: 'end_turn' },
            ],
          }),
        ),
      },
    } as any;

    const response = handleStreaming({
      ...baseParams,
      anthropic,
      voiceAck: { enabled: false, text: 'SHOULD_NOT_APPEAR', delayMs: 10 },
    });
    const chunks = dataChunks(await readSse(response));
    const contents = chunks.map((c: any) => c.choices[0]?.delta?.content).filter(Boolean);
    expect(contents).not.toContain('SHOULD_NOT_APPEAR ');
    expect(contents).toContain('slow');
  });

  it('cancels ACK when real text arrives before delay expires', async () => {
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation(() =>
          createFakeStream({
            events: [
              // Text arrives almost immediately; ACK delay is 100ms.
              { type: 'text', delta: 'fast', delayMs: 10 },
              { type: 'stop', reason: 'end_turn' },
            ],
          }),
        ),
      },
    } as any;

    const response = handleStreaming({
      ...baseParams,
      anthropic,
      voiceAck: { enabled: true, text: 'One moment', delayMs: 100 },
    });
    const chunks = dataChunks(await readSse(response));
    const contents = chunks.map((c: any) => c.choices[0]?.delta?.content).filter(Boolean);
    expect(contents).toEqual(['fast']);
  });

  it('emits ACK when no text arrives within delay', async () => {
    // Round 1: pure tool_use (no text). Tool takes 200ms.
    // Round 2: text arrives at 250ms total. ACK delay is 100ms -> fires.
    const userTools = {
      SLOW: {
        name: 'SLOW',
        description: '',
        inputSchema: { type: 'object' as const, properties: {} },
        handler: async () => {
          await new Promise((r) => setTimeout(r, 200));
          return { content: [{ type: 'text' as const, text: 'ok' }] };
        },
      },
    };

    let callIndex = 0;
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation(() => {
          callIndex++;
          if (callIndex === 1) {
            return createFakeStream({
              events: [
                { type: 'tool_use', id: 'tu_1', name: 'SLOW', input: {} },
                { type: 'stop', reason: 'tool_use' },
              ],
            });
          }
          return createFakeStream({
            events: [
              { type: 'text', delta: 'all set' },
              { type: 'stop', reason: 'end_turn' },
            ],
          });
        }),
      },
    } as any;

    const response = handleStreaming({
      ...baseParams,
      anthropic,
      userTools: userTools as any,
      voiceAck: { enabled: true, text: 'One moment', delayMs: 100 },
    });
    const chunks = dataChunks(await readSse(response));
    const contents = chunks
      .map((c: any) => c.choices[0]?.delta?.content)
      .filter((x: any) => typeof x === 'string' && x.length > 0);
    expect(contents[0]).toBe('One moment ');
    expect(contents).toContain('all set');
  });

  it('ACK fires at most once even if multiple tool rounds stay silent', async () => {
    const userTools = {
      X: {
        name: 'X',
        description: '',
        inputSchema: { type: 'object' as const, properties: {} },
        // Each tool call takes 60ms, pushing first text past the 50ms ACK delay.
        handler: async () => {
          await new Promise((r) => setTimeout(r, 60));
          return { content: [{ type: 'text' as const, text: 'ok' }] };
        },
      },
    };

    let callIndex = 0;
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation(() => {
          callIndex++;
          if (callIndex <= 2) {
            return createFakeStream({
              events: [
                { type: 'tool_use', id: `tu_${callIndex}`, name: 'X', input: {} },
                { type: 'stop', reason: 'tool_use' },
              ],
            });
          }
          return createFakeStream({
            events: [
              { type: 'text', delta: 'finally' },
              { type: 'stop', reason: 'end_turn' },
            ],
          });
        }),
      },
    } as any;

    const response = handleStreaming({
      ...baseParams,
      anthropic,
      userTools: userTools as any,
      voiceAck: { enabled: true, text: 'Hold on', delayMs: 50 },
    });
    const chunks = dataChunks(await readSse(response));
    const acks = chunks.filter((c: any) => c.choices[0]?.delta?.content === 'Hold on ');
    expect(acks).toHaveLength(1);
  });

  it('always appends a trailing space to ACK text', async () => {
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation(() =>
          createFakeStream({
            events: [
              { type: 'text', delta: 'reply', delayMs: 100 },
              { type: 'stop', reason: 'end_turn' },
            ],
          }),
        ),
      },
    } as any;

    const response = handleStreaming({
      ...baseParams,
      anthropic,
      voiceAck: { enabled: true, text: 'Thinking', delayMs: 10 },
    });
    const chunks = dataChunks(await readSse(response));
    const contents = chunks
      .map((c: any) => c.choices[0]?.delta?.content)
      .filter((x: any) => typeof x === 'string' && x.length > 0);
    expect(contents[0]).toBe('Thinking ');
  });
});

describe('handleStreaming — keepalive', () => {
  it('emits SSE keepalive comments every 15s during long tool execution', async () => {
    vi.useFakeTimers();

    let resolveTool: (() => void) | undefined;
    const userTools = {
      SLOW: {
        name: 'SLOW',
        description: '',
        inputSchema: { type: 'object' as const, properties: {} },
        handler: async () => {
          await new Promise<void>((r) => {
            resolveTool = r;
          });
          return { content: [{ type: 'text' as const, text: 'done' }] };
        },
      },
    };

    let callIndex = 0;
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation(() => {
          callIndex++;
          if (callIndex === 1) {
            return createFakeStream({
              events: [
                { type: 'tool_use', id: 'tu_1', name: 'SLOW', input: {} },
                { type: 'stop', reason: 'tool_use' },
              ],
            });
          }
          return createFakeStream({
            events: [
              { type: 'text', delta: 'all set' },
              { type: 'stop', reason: 'end_turn' },
            ],
          });
        }),
      },
    } as any;

    const response = handleStreaming({
      ...baseParams,
      anthropic,
      userTools: userTools as any,
    });

    // Drain the response in the background
    const readPromise = readSse(response);

    // Let microtasks flush, then advance past the 15s keepalive threshold
    await vi.advanceTimersByTimeAsync(20_000);

    // Release the tool handler so the stream can complete
    resolveTool?.();
    await vi.advanceTimersByTimeAsync(100);

    vi.useRealTimers();
    const events = await readPromise;
    const keepalives = events.filter((e: any) => e.kind === 'comment' && e.text === 'keepalive');
    expect(keepalives.length).toBeGreaterThanOrEqual(1);
  });
});

describe('handleStreaming — client disconnect', () => {
  it('aborts the Anthropic stream when the consumer cancels the response body', async () => {
    let capturedSignal: AbortSignal | undefined;
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation((_body: any, opts: any) => {
          capturedSignal = opts?.signal;
          return createFakeStream({
            events: [
              // Very slow — simulate a stream that would never end unless aborted.
              { type: 'text', delta: 'slow', delayMs: 5_000 },
              { type: 'stop', reason: 'end_turn' },
            ],
            signal: opts?.signal,
          });
        }),
      },
    } as any;

    const response = handleStreaming({ ...baseParams, anthropic });
    const reader = response.body!.getReader();
    // Read the first chunk (role marker), then cancel.
    await reader.read();
    await reader.cancel();

    // Give the abort microtask a moment to propagate.
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedSignal?.aborted).toBe(true);
  });
});
