import { describe, it, expect } from 'vitest';
import { buildChunk, encodeDataLine, encodeComment, encodeDone, buildErrorChunk } from '../sse';

const encoder = new TextEncoder();
const decode = (u: Uint8Array) => new TextDecoder().decode(u);

describe('buildChunk', () => {
  it('produces an OpenAI chat.completion.chunk envelope', () => {
    const chunk = buildChunk('chatcmpl-abc', 1700000000, 'claude-haiku-4-5', { content: 'hi' }, null);
    expect(chunk).toEqual({
      id: 'chatcmpl-abc',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'claude-haiku-4-5',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    });
  });

  it('defaults finish_reason to null when omitted', () => {
    const chunk = buildChunk('id', 1, 'm', {});
    expect(chunk.choices[0].finish_reason).toBeNull();
  });

  it('honors a non-null finish_reason', () => {
    const chunk = buildChunk('id', 1, 'm', {}, 'stop');
    expect(chunk.choices[0].finish_reason).toBe('stop');
  });
});

describe('encodeDataLine', () => {
  it('produces a single SSE data event with JSON payload', () => {
    const bytes = encodeDataLine(encoder, { hello: 'world' });
    expect(decode(bytes)).toBe('data: {"hello":"world"}\n\n');
  });
});

describe('encodeComment', () => {
  it('produces an SSE comment line', () => {
    const bytes = encodeComment(encoder, 'keepalive');
    expect(decode(bytes)).toBe(': keepalive\n\n');
  });
});

describe('encodeDone', () => {
  it('produces the literal [DONE] terminator', () => {
    expect(decode(encodeDone(encoder))).toBe('data: [DONE]\n\n');
  });
});

describe('buildErrorChunk', () => {
  it('wraps a message and default type', () => {
    expect(buildErrorChunk('boom')).toEqual({ error: { message: 'boom', type: 'server_error' } });
  });

  it('honors a custom type', () => {
    expect(buildErrorChunk('x', 'rate_limit')).toEqual({ error: { message: 'x', type: 'rate_limit' } });
  });
});
