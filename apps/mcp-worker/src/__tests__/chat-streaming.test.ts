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
