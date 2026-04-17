export interface SseChunkPayload {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
}

export function buildChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finish_reason: string | null = null,
): SseChunkPayload {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason }],
  };
}

export function encodeDataLine(encoder: TextEncoder, data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

export function encodeComment(encoder: TextEncoder, text: string): Uint8Array {
  return encoder.encode(`: ${text}\n\n`);
}

export function encodeDone(encoder: TextEncoder): Uint8Array {
  return encoder.encode('data: [DONE]\n\n');
}

export function buildErrorChunk(
  message: string,
  type: string = 'server_error',
): { error: { message: string; type: string } } {
  return { error: { message, type } };
}
