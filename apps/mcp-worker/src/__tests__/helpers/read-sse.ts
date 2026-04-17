export type SseEvent = { kind: 'data'; payload: unknown } | { kind: 'comment'; text: string } | { kind: 'done' };

/**
 * Consumes a Response whose body is an SSE stream and returns the parsed event sequence.
 * `data: [DONE]` becomes `{kind:'done'}`. JSON data lines become `{kind:'data', payload}`.
 * Comment lines (starting with `:`) become `{kind:'comment', text}`.
 */
export async function readSse(response: Response): Promise<SseEvent[]> {
  if (!response.body) throw new Error('Response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: SseEvent[] = [];

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      if (raw.startsWith(': ')) {
        events.push({ kind: 'comment', text: raw.slice(2) });
      } else if (raw.startsWith('data: ')) {
        const body = raw.slice(6);
        if (body === '[DONE]') {
          events.push({ kind: 'done' });
        } else {
          events.push({ kind: 'data', payload: JSON.parse(body) });
        }
      }
    }
  }
  return events;
}

export function dataChunks(events: SseEvent[]): Array<Record<string, unknown>> {
  return events
    .filter((e): e is { kind: 'data'; payload: Record<string, unknown> } => e.kind === 'data')
    .map((e) => e.payload);
}
