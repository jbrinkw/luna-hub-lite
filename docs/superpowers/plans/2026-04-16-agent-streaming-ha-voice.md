# Agent Streaming for HA Voice Preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `POST /v1/chat/completions` streaming to emit real token-by-token OpenAI-shaped SSE (replacing today's synthetic single-chunk behavior), with an optional per-user voice-ACK filler that fires only when tool execution delays the first real token. Target consumer is Home Assistant's `extended_openai_conversation` HACS integration driving Voice Preview Edition.

**Architecture:** Extract streaming out of `openai-compat.ts` into a dedicated `chat-streaming.ts` module. Use `anthropic.messages.stream()` with event listeners for real-time text deltas. Run the agentic tool loop inside a `ReadableStream` that maps Anthropic text events to OpenAI SSE chunks; tool_use blocks execute server-side silently. Layer a one-shot ACK timer that cancels on the first real text delta. Per-user settings live on three new columns in `hub.agent_settings`.

**Tech Stack:** TypeScript, Cloudflare Workers (with `nodejs_compat`), Vitest, `@anthropic-ai/sdk@^0.87.0`, Supabase (PostgREST + plpgsql SECURITY DEFINER), React 18 + TanStack Query v5 on the UI side.

**Spec:** `docs/superpowers/specs/2026-04-16-agent-streaming-design.md` — consult for behavior rationale, error matrix, and out-of-scope list.

---

## File Structure

**Create:**

- `supabase/migrations/20260416010000_agent_voice_ack.sql` — adds 3 columns to `hub.agent_settings` + 2 new RPCs (`hub.save_agent_voice_ack`, `hub.get_agent_voice_ack_admin`); replaces `hub.get_agent_settings()` to also return voice-ack fields.
- `apps/mcp-worker/src/sse.ts` — pure SSE encoding helpers (buildChunk, encodeDataLine, encodeComment, encodeDone, buildErrorChunk).
- `apps/mcp-worker/src/chat-streaming.ts` — streaming chat-completions handler (replaces `handleStreaming` + `emitSyntheticStream` in `openai-compat.ts`).
- `apps/mcp-worker/src/voice-ack.ts` — loads voice-ack settings per request with defensive defaults.
- `apps/mcp-worker/src/__tests__/sse.test.ts` — unit tests for SSE helpers.
- `apps/mcp-worker/src/__tests__/chat-streaming.test.ts` — unit tests for streaming handler.
- `apps/mcp-worker/src/__tests__/helpers/fake-anthropic.ts` — fake `MessageStream` for tests.
- `apps/mcp-worker/src/__tests__/helpers/read-sse.ts` — helper that reads an SSE Response into an ordered list of chunk objects / comment strings / `'[DONE]'`.

**Modify:**

- `apps/mcp-worker/src/openai-compat.ts` — delete `handleStreaming` and `emitSyntheticStream`; call `handleStreaming` from new module.
- `apps/mcp-worker/vitest.config.ts` — add new test files to `include`.
- `apps/web/src/pages/hub/AgentPage.tsx` — add Voice Assist card + save mutation.
- `docs/mcp/guide.md` — replace HA section with Voice Preview walkthrough.
- `docs/architecture/database.md` — add voice-ack columns to `hub.agent_settings` schema.
- `docs/apps/hub.md` — document new Voice Assist section on Agent page.
- `~/.claude/projects/-home-jeremy-luna-hub-lite/memory/current-task.md` — stopping-point update.
- `~/.claude/projects/-home-jeremy-luna-hub-lite/memory/decisions.md` — append autonomous decisions.

**Regenerate (not a hand-edit):**

- `packages/db-types/src/database.types.ts` — via `pnpm -F db-types gen` after migration applied.

---

## Task 1: Database migration + RPCs

**Files:**

- Create: `supabase/migrations/20260416010000_agent_voice_ack.sql`

- [ ] **Step 1.1: Create migration file**

Write `supabase/migrations/20260416010000_agent_voice_ack.sql`:

```sql
-- Voice ACK settings: let users opt-in to a short filler phrase emitted during
-- long tool-execution gaps so Home Assistant Voice Preview TTS has something to
-- speak instead of dead air.

------------------------------------------------------------
-- Columns
------------------------------------------------------------
ALTER TABLE hub.agent_settings
  ADD COLUMN voice_ack_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN voice_ack_text TEXT NOT NULL DEFAULT 'Working on that…',
  ADD COLUMN voice_ack_delay_ms INTEGER NOT NULL DEFAULT 1200
    CHECK (voice_ack_delay_ms BETWEEN 0 AND 5000);

ALTER TABLE hub.agent_settings
  ADD CONSTRAINT voice_ack_text_length CHECK (char_length(voice_ack_text) <= 200);

------------------------------------------------------------
-- User-facing: save voice-ack settings
------------------------------------------------------------
CREATE OR REPLACE FUNCTION hub.save_agent_voice_ack(
  p_enabled BOOLEAN,
  p_text TEXT,
  p_delay_ms INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_delay_ms < 0 OR p_delay_ms > 5000 THEN
    RAISE EXCEPTION 'voice_ack_delay_ms must be between 0 and 5000';
  END IF;

  IF p_text IS NULL OR char_length(p_text) = 0 THEN
    RAISE EXCEPTION 'voice_ack_text must not be empty';
  END IF;

  IF char_length(p_text) > 200 THEN
    RAISE EXCEPTION 'voice_ack_text must be at most 200 characters';
  END IF;

  INSERT INTO hub.agent_settings (
    user_id, voice_ack_enabled, voice_ack_text, voice_ack_delay_ms
  )
  VALUES (
    (SELECT auth.uid()), p_enabled, p_text, p_delay_ms
  )
  ON CONFLICT (user_id) DO UPDATE SET
    voice_ack_enabled = EXCLUDED.voice_ack_enabled,
    voice_ack_text = EXCLUDED.voice_ack_text,
    voice_ack_delay_ms = EXCLUDED.voice_ack_delay_ms,
    updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION hub.save_agent_voice_ack(BOOLEAN, TEXT, INTEGER) TO authenticated;

------------------------------------------------------------
-- Service-role: read voice-ack settings (for MCP Worker)
------------------------------------------------------------
CREATE OR REPLACE FUNCTION hub.get_agent_voice_ack_admin(p_user_id UUID)
RETURNS TABLE(
  voice_ack_enabled BOOLEAN,
  voice_ack_text TEXT,
  voice_ack_delay_ms INTEGER
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT voice_ack_enabled, voice_ack_text, voice_ack_delay_ms
  FROM hub.agent_settings
  WHERE user_id = p_user_id;
$$;

GRANT EXECUTE ON FUNCTION hub.get_agent_voice_ack_admin(UUID) TO service_role;

------------------------------------------------------------
-- Replace user-facing get_agent_settings to include voice-ack fields
------------------------------------------------------------
CREATE OR REPLACE FUNCTION hub.get_agent_settings()
RETURNS TABLE(
  has_key BOOLEAN,
  system_prompt TEXT,
  voice_ack_enabled BOOLEAN,
  voice_ack_text TEXT,
  voice_ack_delay_ms INTEGER
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    (anthropic_key_encrypted IS NOT NULL) AS has_key,
    COALESCE(system_prompt, '') AS system_prompt,
    COALESCE(voice_ack_enabled, FALSE) AS voice_ack_enabled,
    COALESCE(voice_ack_text, 'Working on that…') AS voice_ack_text,
    COALESCE(voice_ack_delay_ms, 1200) AS voice_ack_delay_ms
  FROM hub.agent_settings
  WHERE user_id = (SELECT auth.uid())
$$;

GRANT EXECUTE ON FUNCTION hub.get_agent_settings() TO authenticated;
```

- [ ] **Step 1.2: Apply migration locally**

Run:

```bash
cd /home/jeremy/luna-hub-lite
supabase db push
```

Expected: migration applies cleanly. If it errors on `CHECK` constraint adding to a table with existing rows, investigate before re-running — the default values should satisfy the constraint for all rows.

- [ ] **Step 1.3: Run pgTAP suite**

Run:

```bash
cd /home/jeremy/luna-hub-lite
supabase test db
```

Expected: all existing tests still pass (no regressions). Should also pass if any new pgTAP tests happen to be present, but none are required by this plan (unit tests cover the RPCs indirectly through the UI integration path).

- [ ] **Step 1.4: Regenerate DB types**

Run:

```bash
cd /home/jeremy/luna-hub-lite
pnpm -F db-types gen
```

Expected: `packages/db-types/src/database.types.ts` updates. Verify new rows in the generated file reference `save_agent_voice_ack` and `get_agent_voice_ack_admin` Args + Returns types, and that `get_agent_settings` return type now includes the three new fields:

```bash
grep -n "voice_ack" packages/db-types/src/database.types.ts | head
```

Expected: multiple matches including `voice_ack_enabled: boolean`, `voice_ack_text: string`, `voice_ack_delay_ms: number`.

- [ ] **Step 1.5: Commit**

```bash
cd /home/jeremy/luna-hub-lite
git add supabase/migrations/20260416010000_agent_voice_ack.sql packages/db-types/src/database.types.ts
git commit -m "feat(db): voice-ack settings on hub.agent_settings

Adds voice_ack_enabled, voice_ack_text, voice_ack_delay_ms columns with
sensible defaults. New save_agent_voice_ack user RPC and
get_agent_voice_ack_admin service-role RPC. Extends get_agent_settings()
to expose the new fields to the UI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: SSE helpers module

**Files:**

- Create: `apps/mcp-worker/src/sse.ts`
- Create: `apps/mcp-worker/src/__tests__/sse.test.ts`

- [ ] **Step 2.1: Write failing tests**

Create `apps/mcp-worker/src/__tests__/sse.test.ts`:

```ts
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
```

- [ ] **Step 2.2: Add test file to vitest config and verify it fails**

Edit `apps/mcp-worker/vitest.config.ts` — add to `include` array:

```ts
include: [
  'src/__tests__/validate.test.ts',
  'src/__tests__/obsidian-parser.test.ts',
  'src/__tests__/tool-logger.test.ts',
  'src/__tests__/sse.test.ts',
],
```

Run:

```bash
cd /home/jeremy/luna-hub-lite/apps/mcp-worker
pnpm test
```

Expected: fails with `Cannot find module '../sse'` (or similar resolution error for `sse.test.ts`).

- [ ] **Step 2.3: Implement sse.ts**

Create `apps/mcp-worker/src/sse.ts`:

```ts
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
```

- [ ] **Step 2.4: Verify tests pass**

Run:

```bash
cd /home/jeremy/luna-hub-lite/apps/mcp-worker
pnpm test
```

Expected: all `sse.test.ts` tests pass (8 tests green), existing tests still pass.

- [ ] **Step 2.5: Commit**

```bash
cd /home/jeremy/luna-hub-lite
git add apps/mcp-worker/src/sse.ts apps/mcp-worker/src/__tests__/sse.test.ts apps/mcp-worker/vitest.config.ts
git commit -m "feat(mcp-worker): SSE helpers for streaming chat completions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Test helpers (fake Anthropic stream + SSE reader)

**Files:**

- Create: `apps/mcp-worker/src/__tests__/helpers/fake-anthropic.ts`
- Create: `apps/mcp-worker/src/__tests__/helpers/read-sse.ts`

- [ ] **Step 3.1: Create fake Anthropic stream helper**

Create `apps/mcp-worker/src/__tests__/helpers/fake-anthropic.ts`:

```ts
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
```

- [ ] **Step 3.2: Create SSE response reader helper**

Create `apps/mcp-worker/src/__tests__/helpers/read-sse.ts`:

```ts
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
```

- [ ] **Step 3.3: Commit**

No tests needed for test helpers themselves — they'll be exercised by the streaming tests in subsequent tasks.

```bash
cd /home/jeremy/luna-hub-lite
git add apps/mcp-worker/src/__tests__/helpers/fake-anthropic.ts apps/mcp-worker/src/__tests__/helpers/read-sse.ts
git commit -m "test(mcp-worker): helpers for fake Anthropic stream and SSE reader

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Voice-ack settings loader

**Files:**

- Create: `apps/mcp-worker/src/voice-ack.ts`
- Create: `apps/mcp-worker/src/__tests__/voice-ack.test.ts`

- [ ] **Step 4.1: Write failing tests**

Create `apps/mcp-worker/src/__tests__/voice-ack.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { loadVoiceAckSettings, DEFAULT_VOICE_ACK } from '../voice-ack';

function mockSupabase(rpcImpl: (name: string, args: unknown) => unknown) {
  return {
    schema: () => ({ rpc: vi.fn(rpcImpl) }),
  } as any;
}

describe('loadVoiceAckSettings', () => {
  it('returns DB row values when present', async () => {
    const supabase = mockSupabase(() => ({
      data: [{ voice_ack_enabled: true, voice_ack_text: 'One sec…', voice_ack_delay_ms: 800 }],
      error: null,
    }));
    const result = await loadVoiceAckSettings(supabase, 'user-1');
    expect(result).toEqual({ enabled: true, text: 'One sec…', delayMs: 800 });
  });

  it('returns defaults when no row exists', async () => {
    const supabase = mockSupabase(() => ({ data: [], error: null }));
    const result = await loadVoiceAckSettings(supabase, 'user-1');
    expect(result).toEqual(DEFAULT_VOICE_ACK);
  });

  it('returns defaults when RPC returns an error', async () => {
    const supabase = mockSupabase(() => ({ data: null, error: { message: 'boom' } }));
    const result = await loadVoiceAckSettings(supabase, 'user-1');
    expect(result).toEqual(DEFAULT_VOICE_ACK);
  });

  it('returns defaults when RPC throws', async () => {
    const supabase = mockSupabase(() => {
      throw new Error('network fail');
    });
    const result = await loadVoiceAckSettings(supabase, 'user-1');
    expect(result).toEqual(DEFAULT_VOICE_ACK);
  });
});

describe('DEFAULT_VOICE_ACK', () => {
  it('matches the DB migration defaults', () => {
    expect(DEFAULT_VOICE_ACK).toEqual({ enabled: false, text: 'Working on that…', delayMs: 1200 });
  });
});
```

Add `'src/__tests__/voice-ack.test.ts'` to `vitest.config.ts` include array.

Run:

```bash
cd /home/jeremy/luna-hub-lite/apps/mcp-worker
pnpm test
```

Expected: fails — `Cannot find module '../voice-ack'`.

- [ ] **Step 4.2: Implement voice-ack.ts**

Create `apps/mcp-worker/src/voice-ack.ts`:

```ts
export interface VoiceAckSettings {
  enabled: boolean;
  text: string;
  delayMs: number;
}

export const DEFAULT_VOICE_ACK: VoiceAckSettings = {
  enabled: false,
  text: 'Working on that…',
  delayMs: 1200,
};

/**
 * Load voice-ack settings for a user. Never throws — any error falls back to
 * DEFAULT_VOICE_ACK so the streaming request isn't blocked by an optional
 * setting lookup.
 */
export async function loadVoiceAckSettings(supabase: any, userId: string): Promise<VoiceAckSettings> {
  try {
    const { data, error } = await supabase.schema('hub').rpc('get_agent_voice_ack_admin', { p_user_id: userId });

    if (error || !data) return DEFAULT_VOICE_ACK;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return DEFAULT_VOICE_ACK;

    return {
      enabled: Boolean(row.voice_ack_enabled),
      text: row.voice_ack_text || DEFAULT_VOICE_ACK.text,
      delayMs: Number.isFinite(row.voice_ack_delay_ms) ? row.voice_ack_delay_ms : DEFAULT_VOICE_ACK.delayMs,
    };
  } catch {
    return DEFAULT_VOICE_ACK;
  }
}
```

- [ ] **Step 4.3: Verify tests pass**

```bash
cd /home/jeremy/luna-hub-lite/apps/mcp-worker
pnpm test -- voice-ack
```

Expected: all 5 tests pass.

- [ ] **Step 4.4: Commit**

```bash
cd /home/jeremy/luna-hub-lite
git add apps/mcp-worker/src/voice-ack.ts apps/mcp-worker/src/__tests__/voice-ack.test.ts apps/mcp-worker/vitest.config.ts
git commit -m "feat(mcp-worker): voice-ack settings loader with default fallback

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Streaming handler skeleton + direct-text test

**Files:**

- Create: `apps/mcp-worker/src/chat-streaming.ts`
- Create: `apps/mcp-worker/src/__tests__/chat-streaming.test.ts`

- [ ] **Step 5.1: Write failing test for direct text (no tools)**

Create `apps/mcp-worker/src/__tests__/chat-streaming.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
```

Add `'src/__tests__/chat-streaming.test.ts'` to `vitest.config.ts` include array.

Run:

```bash
cd /home/jeremy/luna-hub-lite/apps/mcp-worker
pnpm test -- chat-streaming
```

Expected: fails — module not found.

- [ ] **Step 5.2: Implement minimal chat-streaming.ts**

Create `apps/mcp-worker/src/chat-streaming.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition, ExtensionToolDefinition } from '@luna-hub/app-tools';
import { executeTool } from './tool-executor';
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
    controller.enqueue(encodeDataLine(encoder, buildChunk(completionId, created, model, delta, finish_reason)));
  };
  const writeError = (message: string) => {
    controller.enqueue(encodeDataLine(encoder, buildErrorChunk(message)));
  };
  const writeDone = () => {
    controller.enqueue(encodeDone(encoder));
  };

  // Initial role chunk
  writeChunk({ role: 'assistant', content: '' });

  let firstTextEmitted = false;
  let ackTimer: ReturnType<typeof setTimeout> | undefined;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  const emitAck = () => {
    if (firstTextEmitted) return;
    firstTextEmitted = true;
    writeChunk({ content: `${voiceAck.text} ` });
  };

  if (voiceAck.enabled) {
    ackTimer = setTimeout(emitAck, voiceAck.delayMs);
  }

  keepaliveTimer = setInterval(() => {
    try {
      controller.enqueue(encodeComment(encoder, 'keepalive'));
    } catch {
      /* stream already closed */
    }
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
              content: result.content
                .filter((c) => c.type === 'text')
                .map((c) => c.text)
                .join('\n'),
              is_error: result.isError ?? false,
            });
          } catch (err: any) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Tool error: ${err?.message ?? 'unknown'}`,
              is_error: true,
            });
          }
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
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    try {
      controller.close();
    } catch {
      /* already closed */
    }
  }
}

function formatAnthropicError(err: any): string {
  if (err?.status === 401) return 'Invalid Anthropic API key. Update it in Hub > AI Agent.';
  if (err?.status === 429) return 'Anthropic rate limit exceeded. Try again later.';
  return `Anthropic API error: ${err?.message ?? 'Unknown error'}`;
}
```

- [ ] **Step 5.3: Verify direct-text test passes**

```bash
cd /home/jeremy/luna-hub-lite/apps/mcp-worker
pnpm test -- chat-streaming
```

Expected: the one test passes.

- [ ] **Step 5.4: Commit**

```bash
cd /home/jeremy/luna-hub-lite
git add apps/mcp-worker/src/chat-streaming.ts apps/mcp-worker/src/__tests__/chat-streaming.test.ts apps/mcp-worker/vitest.config.ts
git commit -m "feat(mcp-worker): streaming handler skeleton with direct-text path

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Tool-round branch tests

**Files:**

- Modify: `apps/mcp-worker/src/__tests__/chat-streaming.test.ts`

- [ ] **Step 6.1: Write test for text + tool_use + text**

Append to `chat-streaming.test.ts`:

```ts
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

    let callIndex = 0;
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation(() => {
          callIndex++;
          if (callIndex === 1) {
            return createFakeStream({
              events: [
                { type: 'tool_use', id: 'tu_1', name: 'FOO', input: {} },
                { type: 'stop', reason: 'tool_use' },
              ],
            });
          }
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
  });

  it('handles unknown tool name with is_error tool_result, loop continues', async () => {
    let callIndex = 0;
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation(() => {
          callIndex++;
          if (callIndex === 1) {
            return createFakeStream({
              events: [
                { type: 'tool_use', id: 'tu_1', name: 'NOPE', input: {} },
                { type: 'stop', reason: 'tool_use' },
              ],
            });
          }
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
  });

  it('executes two parallel tool_use blocks serially and sends results in one user message', async () => {
    const calls: string[] = [];
    const userTools = {
      A: {
        name: 'A',
        description: '',
        inputSchema: { type: 'object' as const, properties: {} },
        handler: async () => {
          calls.push('A');
          return { content: [{ type: 'text' as const, text: 'a-result' }] };
        },
      },
      B: {
        name: 'B',
        description: '',
        inputSchema: { type: 'object' as const, properties: {} },
        handler: async () => {
          calls.push('B');
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
  });
});
```

- [ ] **Step 6.2: Run tests — expect pass**

```bash
cd /home/jeremy/luna-hub-lite/apps/mcp-worker
pnpm test -- chat-streaming
```

Expected: all 5 tests in the file pass (direct text + 4 tool-round tests). The tool-round logic is already implemented in Task 5.

- [ ] **Step 6.3: Commit**

```bash
cd /home/jeremy/luna-hub-lite
git add apps/mcp-worker/src/__tests__/chat-streaming.test.ts
git commit -m "test(mcp-worker): tool-round streaming behavior

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Max-tokens, max-rounds, and mid-stream error tests

**Files:**

- Modify: `apps/mcp-worker/src/__tests__/chat-streaming.test.ts`

- [ ] **Step 7.1: Write tests**

Append:

```ts
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
```

- [ ] **Step 7.2: Run and verify**

```bash
cd /home/jeremy/luna-hub-lite/apps/mcp-worker
pnpm test -- chat-streaming
```

Expected: all pass.

- [ ] **Step 7.3: Commit**

```bash
cd /home/jeremy/luna-hub-lite
git add apps/mcp-worker/src/__tests__/chat-streaming.test.ts
git commit -m "test(mcp-worker): stop-reason and error-path streaming behavior

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Voice ACK timer tests

**Files:**

- Modify: `apps/mcp-worker/src/__tests__/chat-streaming.test.ts`

- [ ] **Step 8.1: Write tests using fake timers**

Append:

```ts
describe('handleStreaming — voice ACK timer', () => {
  it('does NOT emit ACK when voice_ack_enabled=false even with long silence', async () => {
    const anthropic = {
      messages: {
        stream: vi.fn().mockImplementation(() =>
          createFakeStream({
            events: [
              { type: 'text', delta: 'slow', delayMs: 50 },
              { type: 'stop', reason: 'end_turn' },
            ],
          }),
        ),
      },
    } as any;

    const response = handleStreaming({ ...baseParams, anthropic, voiceAck: DEFAULT_VOICE_ACK });
    const chunks = dataChunks(await readSse(response));
    const contents = chunks.map((c: any) => c.choices[0]?.delta?.content).filter(Boolean);
    expect(contents).not.toContain('Working on that… ');
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
    const contents = chunks.map((c: any) => c.choices[0]?.delta?.content).filter((x: any) => typeof x === 'string');
    expect(contents[0]).toBe('One moment ');
    expect(contents).toContain('all set');
  });

  it('ACK fires at most once even if multiple tool rounds stay silent', async () => {
    const userTools = {
      X: {
        name: 'X',
        description: '',
        inputSchema: { type: 'object' as const, properties: {} },
        handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
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
    const contents = chunks.map((c: any) => c.choices[0]?.delta?.content).filter((x: any) => typeof x === 'string');
    expect(contents[0]).toBe('Thinking ');
  });
});
```

- [ ] **Step 8.2: Run tests**

```bash
cd /home/jeremy/luna-hub-lite/apps/mcp-worker
pnpm test -- chat-streaming
```

Expected: all voice-ack tests pass using real timers (the `delayMs` values in fake-anthropic are small — 10–250ms — so the tests complete quickly without needing vi.useFakeTimers).

- [ ] **Step 8.3: Commit**

```bash
cd /home/jeremy/luna-hub-lite
git add apps/mcp-worker/src/__tests__/chat-streaming.test.ts
git commit -m "test(mcp-worker): voice-ack timer behavior under fast and slow paths

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Client-disconnect abort test

**Files:**

- Modify: `apps/mcp-worker/src/__tests__/chat-streaming.test.ts`

- [ ] **Step 9.1: Write abort test**

Append:

```ts
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
```

- [ ] **Step 9.2: Run tests**

```bash
cd /home/jeremy/luna-hub-lite/apps/mcp-worker
pnpm test -- chat-streaming
```

Expected: passes (AbortController plumbed through in Task 5).

- [ ] **Step 9.3: Commit**

```bash
cd /home/jeremy/luna-hub-lite
git add apps/mcp-worker/src/__tests__/chat-streaming.test.ts
git commit -m "test(mcp-worker): client-disconnect aborts Anthropic stream

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Wire chat-streaming.ts into openai-compat.ts

**Files:**

- Modify: `apps/mcp-worker/src/openai-compat.ts`

- [ ] **Step 10.1: Read current openai-compat.ts**

Open `apps/mcp-worker/src/openai-compat.ts`. Identify:

- Lines 80–92: the `if (body.stream)` block that calls the local `handleStreaming(...)`.
- Lines 209–312: the local `handleStreaming` implementation (will be deleted).
- Lines 314–348: the local `emitSyntheticStream` implementation (will be deleted).

- [ ] **Step 10.2: Rewrite imports and streaming call-site**

Replace lines 1–6 with:

```ts
import Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition, ExtensionToolDefinition } from '@luna-hub/app-tools';
import { buildUserTools } from './registry';
import { executeTool } from './tool-executor';
import type { ChatCompletionRequest, ChatCompletionResponse, ChatMessage } from './openai-types';
import { CORS_HEADERS } from './cors';
import { handleStreaming } from './chat-streaming';
import { loadVoiceAckSettings } from './voice-ack';
```

(Adds two imports; `Anthropic` type is still used by `handleChatCompletion` for tool schema conversion.)

Replace the current `if (body.stream) { ... }` block (lines 80–92) with:

```ts
// 8. Check if streaming requested
if (body.stream) {
  const voiceAck = await loadVoiceAckSettings(supabase, userId);
  return handleStreaming({
    anthropic,
    model,
    system,
    initialMessages: anthropicMessages,
    tools: anthropicTools,
    maxTokens,
    userTools,
    userId,
    supabase,
    voiceAck,
  });
}
```

- [ ] **Step 10.3: Delete the now-unused local streaming functions**

Delete the entire `handleStreaming` function (original lines 209–312) and the entire `emitSyntheticStream` function (original lines 314–348) from `openai-compat.ts`.

- [ ] **Step 10.4: Delete now-unused imports**

After deletion, the imports of `executeTool` and `ToolDefinition`/`ExtensionToolDefinition` in `openai-compat.ts` may still be used by `handleChatCompletion` (they are — the non-streaming loop still calls `executeTool`). Leave those imports. Remove only if `tsc --noEmit` flags them unused.

- [ ] **Step 10.5: Typecheck**

```bash
cd /home/jeremy/luna-hub-lite/apps/mcp-worker
pnpm typecheck
```

Expected: clean. If unused-import warnings appear, remove them.

- [ ] **Step 10.6: Full test run**

```bash
cd /home/jeremy/luna-hub-lite/apps/mcp-worker
pnpm test
```

Expected: all tests across all files pass.

- [ ] **Step 10.7: Commit**

```bash
cd /home/jeremy/luna-hub-lite
git add apps/mcp-worker/src/openai-compat.ts
git commit -m "refactor(mcp-worker): delegate streaming to chat-streaming module

Removes synthetic single-chunk emission path. /v1/chat/completions with
stream:true now flows through the new token-streaming handler with
voice-ack timer and proper tool-round semantics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Hub UI — Voice Assist section

**Files:**

- Modify: `apps/web/src/pages/hub/AgentPage.tsx`

- [ ] **Step 11.1: Extend settings query to return voice-ack fields**

In `AgentPage.tsx`, update the `useQuery` block (around lines 33–49). Replace the `queryFn` and returned shape:

```tsx
const {
  data: settings,
  isLoading,
  isError,
} = useQuery({
  queryKey: queryKeys.agentSettings(user!.id),
  queryFn: async () => {
    const { data, error } = await supabase.schema('hub').rpc('get_agent_settings');
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return {
      hasKey: row?.has_key ?? false,
      systemPrompt: row?.system_prompt || '',
      voiceAckEnabled: row?.voice_ack_enabled ?? false,
      voiceAckText: row?.voice_ack_text ?? 'Working on that…',
      voiceAckDelayMs: row?.voice_ack_delay_ms ?? 1200,
    };
  },
  enabled: !!user,
});
```

- [ ] **Step 11.2: Add voice-ack local state**

After the existing `useState` declarations (around line 28), add:

```tsx
const [voiceAckEnabledDraft, setVoiceAckEnabledDraft] = useState<boolean | null>(null);
const [voiceAckTextDraft, setVoiceAckTextDraft] = useState<string | null>(null);
const [voiceAckDelayDraft, setVoiceAckDelayDraft] = useState<number | null>(null);
const [voiceAckSaveError, setVoiceAckSaveError] = useState<string | null>(null);
const [voiceAckSaveSuccess, setVoiceAckSaveSuccess] = useState(false);

const voiceAckEnabled = voiceAckEnabledDraft ?? settings?.voiceAckEnabled ?? false;
const voiceAckText = voiceAckTextDraft ?? settings?.voiceAckText ?? 'Working on that…';
const voiceAckDelayMs = voiceAckDelayDraft ?? settings?.voiceAckDelayMs ?? 1200;
```

- [ ] **Step 11.3: Add save mutation**

After `savePromptMutation` declaration, add:

```tsx
const saveVoiceAckMutation = useMutation({
  mutationFn: async (payload: { enabled: boolean; text: string; delayMs: number }) => {
    const { error } = await supabase.schema('hub').rpc('save_agent_voice_ack', {
      p_enabled: payload.enabled,
      p_text: payload.text,
      p_delay_ms: payload.delayMs,
    });
    if (error) throw error;
  },
  onSuccess: () => {
    setVoiceAckEnabledDraft(null);
    setVoiceAckTextDraft(null);
    setVoiceAckDelayDraft(null);
    setVoiceAckSaveSuccess(true);
    queryClient.invalidateQueries({ queryKey: queryKeys.agentSettings(user!.id) });
  },
  onError: (err: Error) => setVoiceAckSaveError(err.message),
});

const handleSaveVoiceAck = () => {
  setVoiceAckSaveError(null);
  setVoiceAckSaveSuccess(false);
  if (!voiceAckText.trim()) {
    setVoiceAckSaveError('Voice ACK text is required');
    return;
  }
  saveVoiceAckMutation.mutate({
    enabled: voiceAckEnabled,
    text: voiceAckText.trim(),
    delayMs: voiceAckDelayMs,
  });
};

const handleResetVoiceAck = () => {
  setVoiceAckEnabledDraft(false);
  setVoiceAckTextDraft('Working on that…');
  setVoiceAckDelayDraft(1200);
  setVoiceAckSaveSuccess(false);
};
```

- [ ] **Step 11.4: Add Voice Assist card UI**

Inside the returned JSX, after the System Prompt Card (around line 264, just before the closing `</div>` of `space-y-6`), add:

```tsx
{
  /* Voice Assist (filler during tool execution) */
}
<Card>
  <CardHeader>
    <div className="flex items-center justify-between">
      <CardTitle>Voice Assist</CardTitle>
      <Badge variant={voiceAckEnabled ? 'success' : 'default'}>{voiceAckEnabled ? 'Enabled' : 'Disabled'}</Badge>
    </div>
  </CardHeader>
  <CardContent className="space-y-3">
    <p className="text-sm text-text-secondary">
      When voice commands trigger tools that take a moment to run, Luna can speak a short filler phrase so your voice
      device isn't sitting in silence. Real responses stream as soon as they're ready — the filler is skipped when the
      answer comes back quickly.
    </p>

    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={voiceAckEnabled}
        onChange={(e) => {
          setVoiceAckEnabledDraft(e.target.checked);
          setVoiceAckSaveSuccess(false);
        }}
      />
      Speak a filler phrase while tools run
    </label>

    <Input
      label="Filler phrase"
      type="text"
      maxLength={200}
      value={voiceAckText}
      onChange={(e) => {
        setVoiceAckTextDraft(e.target.value);
        setVoiceAckSaveSuccess(false);
      }}
      placeholder="Working on that…"
    />

    <Input
      label="Delay before filler (milliseconds)"
      type="number"
      min={0}
      max={5000}
      step={100}
      value={voiceAckDelayMs}
      onChange={(e) => {
        setVoiceAckDelayDraft(Math.max(0, Math.min(5000, Number(e.target.value) || 0)));
        setVoiceAckSaveSuccess(false);
      }}
    />

    <div className="flex gap-2">
      <Button
        onClick={handleSaveVoiceAck}
        loading={saveVoiceAckMutation.isPending}
        disabled={saveVoiceAckMutation.isPending}
        size="sm"
      >
        Save
      </Button>
      <Button variant="secondary" size="sm" onClick={handleResetVoiceAck} disabled={saveVoiceAckMutation.isPending}>
        Reset to Defaults
      </Button>
    </div>
    {voiceAckSaveError && <Alert variant="error">{voiceAckSaveError}</Alert>}
    {voiceAckSaveSuccess && <Alert variant="success">Voice Assist saved</Alert>}
  </CardContent>
</Card>;
```

- [ ] **Step 11.5: Typecheck the web app**

```bash
cd /home/jeremy/luna-hub-lite
pnpm -F web typecheck
```

Expected: clean.

- [ ] **Step 11.6: Start dev server and smoke-test**

```bash
cd /home/jeremy/luna-hub-lite
pnpm -F web dev
```

Open the URL printed (typically `http://localhost:5173`), navigate to `/hub/agent`. Verify:

- The new "Voice Assist" card renders below System Prompt.
- The badge shows "Disabled" initially.
- Toggling the checkbox flips the badge to "Enabled".
- Editing text and delay fields updates state.
- "Save" triggers the mutation; success Alert appears on success.
- Reloading the page persists the saved values.

Stop the dev server (Ctrl+C) after smoke test.

- [ ] **Step 11.7: Commit**

```bash
cd /home/jeremy/luna-hub-lite
git add apps/web/src/pages/hub/AgentPage.tsx
git commit -m "feat(hub): voice-assist settings UI on agent page

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Documentation updates

**Files:**

- Modify: `docs/mcp/guide.md`
- Modify: `docs/architecture/database.md`
- Modify: `docs/apps/hub.md`

- [ ] **Step 12.1: Update docs/mcp/guide.md**

Open `docs/mcp/guide.md`. Find the section describing Home Assistant setup (near the `AI Agent API` / `Home Assistant Setup` heading). Replace the Home Assistant portion with:

```markdown
## Home Assistant Voice Preview

Luna Hub's `/v1/chat/completions` endpoint is OpenAI-compatible. Home Assistant's HACS `extended_openai_conversation` integration consumes it directly, which lets the Home Assistant Voice Preview Edition (VoicePE) speak through Luna.

### Setup

1. Install `extended_openai_conversation` from HACS in your Home Assistant instance.
2. Add the integration (Settings → Devices & Services → Add Integration → Extended OpenAI Conversation).
3. Set:
   - **Base URL**: `https://mcp.lunahub.dev/v1`
   - **API Key**: a Luna Hub API key (create one at `/hub/settings` → MCP API Keys). OAuth/JWT also works.
   - **Model**: any string (the endpoint always uses Claude Haiku 4.5).
4. In Settings → Voice Assistants, create or edit your Assist pipeline and set the Conversation Agent to the new Extended OpenAI entry.
5. Assign the pipeline to your Voice PE device.

### How streaming works

The endpoint emits standard OpenAI SSE chunks token-by-token as Claude generates them. Server-side tool execution is invisible to HA — it appears as a normal streaming response with occasional keepalive comments.

### Voice ACK (optional filler)

Voice commands that require tool execution ("turn on the kitchen lights") can cause a perceptible 1–2 s silence before TTS speaks, because Luna needs to call Home Assistant, get the result, then ask Claude to phrase the reply. You can opt into a short filler phrase ("Working on that…") that plays only when the first real token is late.

Configure in Luna Hub → AI Agent → Voice Assist:

- **Enabled**: off by default. Turn on for voice use.
- **Filler phrase**: any short string (≤200 chars). Default "Working on that…".
- **Delay**: how long to wait (ms) before emitting the filler. Default 1200 ms. Fast responses cancel the filler; you'll never hear it on a direct answer.
```

- [ ] **Step 12.2: Update docs/architecture/database.md**

Find the `hub.agent_settings` table section. Add to the column list:

```markdown
| `voice_ack_enabled` | BOOLEAN NOT NULL DEFAULT FALSE | Opt-in filler phrase for voice streaming |
| `voice_ack_text` | TEXT NOT NULL DEFAULT 'Working on that…' | Filler phrase (≤200 chars) |
| `voice_ack_delay_ms` | INT NOT NULL DEFAULT 1200 (0–5000) | Delay before emitting filler (ms) |
```

And in the RPC list for the hub schema, add:

```markdown
- `hub.save_agent_voice_ack(p_enabled BOOLEAN, p_text TEXT, p_delay_ms INT)` — user-facing voice-ack update
- `hub.get_agent_voice_ack_admin(p_user_id UUID)` — service-role read for the MCP Worker
- `hub.get_agent_settings()` — now also returns voice-ack fields
```

- [ ] **Step 12.3: Update docs/apps/hub.md**

Find the Agent page documentation. Add a section:

```markdown
### Voice Assist

A card on the Agent page that controls optional filler phrases for voice streaming:

- **Enable** toggles filler emission during slow tool execution.
- **Filler phrase** (≤200 chars) is emitted verbatim when the delay expires without a real token having been streamed.
- **Delay** (0–5000 ms) is the silence threshold. Keep it long enough that fast responses skip the filler, short enough that voice users don't perceive a hang.

The filler is only ever spoken via `POST /v1/chat/completions` streaming responses. It has no effect on non-streaming requests or on the Luna chat UI.
```

- [ ] **Step 12.4: Commit docs**

```bash
cd /home/jeremy/luna-hub-lite
git add docs/mcp/guide.md docs/architecture/database.md docs/apps/hub.md
git commit -m "docs: voice-ack settings and Home Assistant Voice Preview walkthrough

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Test quality review

**Files:**

- None (skill dispatch)

- [ ] **Step 13.1: Dispatch test-quality-review**

Invoke the `test-quality-review` skill per project convention in `CLAUDE.md`. Provide the reviewer with the context:

> Reviewing new tests in `apps/mcp-worker/src/__tests__/chat-streaming.test.ts`, `sse.test.ts`, and `voice-ack.test.ts` added for the streaming rewrite (spec: `docs/superpowers/specs/2026-04-16-agent-streaming-design.md`). Focus on:
>
> 1. **Would these tests fail if I regressed to synthetic single-chunk emission?** (If not, a test is a false positive.)
> 2. **Would these tests fail if I removed the ACK timer entirely?** (Tests 8.x must.)
> 3. **Would these tests fail if I skipped client-disconnect abort plumbing?** (Test 9.1 must.)
> 4. Weak assertions: any test asserting only length/truthy that should assert shape?
> 5. Tautologies: any test that mocks something and then asserts on the mock?
> 6. Missing coverage: keepalive comments, SSE comment round-tripping in read-sse helper, and the `refusal` stop_reason path are uncovered in tests. Decide whether to add.

Apply any reviewer feedback inline. Commit fixes separately.

- [ ] **Step 13.2: Commit any review fixes**

```bash
cd /home/jeremy/luna-hub-lite
git add apps/mcp-worker/src/__tests__/
git commit -m "test(mcp-worker): address test-quality-review feedback

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

If no fixes are needed, skip the commit step.

---

## Task 14: Full verification + deploy

**Files:**

- None (commands + manual verification)

- [ ] **Step 14.1: Full suite**

```bash
cd /home/jeremy/luna-hub-lite
supabase test db
pnpm -F mcp-worker test
pnpm -F mcp-worker typecheck
pnpm -F web typecheck
pnpm -F web build
```

Expected: all green.

- [ ] **Step 14.2: Deploy Worker to staging / prod**

Per project convention (CLAUDE.md does not mandate a staging Worker; deploy directly if that's the workflow):

```bash
cd /home/jeremy/luna-hub-lite/apps/mcp-worker
pnpm deploy
```

Expected: `wrangler deploy` completes, routes confirmed on `mcp.lunahub.dev`.

- [ ] **Step 14.3: Deploy web**

```bash
cd /home/jeremy/luna-hub-lite
vercel deploy --prod
```

(Or per project's deployment convention.)

- [ ] **Step 14.4: Smoke test against production endpoint**

From a shell with a test Luna Hub API key in `$LUNA_HUB_KEY`:

```bash
curl -N -H "Authorization: Bearer $LUNA_HUB_KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"claude-haiku","messages":[{"role":"user","content":"Say hi in three words."}],"stream":true}' \
     https://mcp.lunahub.dev/v1/chat/completions
```

Expected output: multiple `data: {...}` lines streaming over >100 ms (not all-at-once), ending with `data: {...finish_reason:"stop"}` and `data: [DONE]`. Confirms real streaming is live.

- [ ] **Step 14.5: Optional — HA end-to-end acceptance**

If a test Home Assistant instance is available, point `extended_openai_conversation` at the production endpoint with the API key, assign to Assist pipeline, speak "what's the weather" via VoicePE. Confirm:

- TTS begins before the full answer is synthesized (streaming audible).
- Toggling Voice Assist on in Luna Hub → AI Agent and using a tool-triggering command ("start a 5-minute workout timer") plays the filler once if the tool is slow enough.

---

## Task 15: Update memory

**Files:**

- Modify: `~/.claude/projects/-home-jeremy-luna-hub-lite/memory/current-task.md`
- Modify: `~/.claude/projects/-home-jeremy-luna-hub-lite/memory/decisions.md`
- Modify: `~/.claude/projects/-home-jeremy-luna-hub-lite/memory/MEMORY.md`

- [ ] **Step 15.1: Update current-task.md**

Replace contents with a new idle-state entry documenting this phase's completion:

```markdown
# Current Task

**Status:** Idle — HA voice-preview streaming shipped.

**Last completed:** Agent API streaming rewrite for Home Assistant Voice Preview. Real token-by-token OpenAI SSE replacing synthetic single-chunk emission on `/v1/chat/completions`. Optional per-user voice-ACK filler. Migration + 3 new columns + 2 RPCs. Hub UI Voice Assist card. Docs + smoke test confirmed.

**Next action:** Awaiting direction.
```

- [ ] **Step 15.2: Append to decisions.md**

Append a new entry:

```markdown
## 2026-04-16 — HA voice-preview streaming

- **Streamed error chunks on mid-stream Anthropic failures** (401/429/5xx): once SSE is open we emit `{error:{message,type}}` + `[DONE]` rather than change HTTP status. Standard OpenAI streaming behavior; HA's OpenAI client raises `APIError` on this shape. Non-streaming callers still get JSON 401/429.
- **Serial tool execution** in the streaming loop matches existing non-streaming path. Parallel execution deliberately not adopted — debugging and ordering guarantees outweigh the small voice-latency gain.
- **Voice ACK arm-at-stream-open** (not arm-on-first-tool-use). Simpler; covers cold-path Anthropic latency too. Rare slow-first-token-no-tool cases hear ACK unnecessarily — acceptable given it's opt-in.
- **DB failure → defaults (disabled)** for voice-ack settings. Never block a streaming request on a secondary config lookup.
- **Keepalive every 15 s regardless of stream activity**. Simpler than reset-on-write; SSE comments are benign for the OpenAI client.
- **ACK text trailing space**: always appended. Guarantees clean concatenation regardless of what user configured.
- **RPC placement**: new RPCs live in the `hub.` schema to match existing pattern (`save_agent_anthropic_key`, `save_agent_system_prompt`), not `private.` — the spec's initial placement was corrected during implementation.
```

- [ ] **Step 15.3: Update MEMORY.md Current State**

Edit `MEMORY.md` Current State block:

- `Working on:` Idle — HA voice-preview streaming shipped
- `Last completed:` Agent API streaming rewrite for HA Voice Preview (real token SSE + voice-ACK filler + Hub UI + docs)
- `Post-MVP done:` append `HA voice-preview streaming` to the list

- [ ] **Step 15.4: No commit needed — memory files are user-local**

Memory files live under `~/.claude/`, outside the repo. No git action required.

---

## Self-Review Checklist

After writing the plan, verified against the spec:

1. **Spec §3 (target behavior)** — covered by Tasks 5–9 (streaming loop, tool rounds, voice-ack, errors). ✓
2. **Spec §5.1 (ReadableStream + cancel)** — Task 5 (handleStreaming) + Task 9 (disconnect test). ✓
3. **Spec §5.2 (messages.stream + finalMessage)** — Task 5 implementation. ✓
4. **Spec §5.3 (tool-round loop, serial exec)** — Task 6 tests including parallel-blocks-serial-exec. ✓
5. **Spec §5.4 (SSE chunk mapping)** — Task 2 sse.ts + Task 5 implementation. ✓
6. **Spec §5.5 (ACK semantics)** — Task 4 loader + Task 5 timer + Task 8 tests (4 cases covering enabled/disabled/cancel/fire-once/trailing-space). ✓
7. **Spec §5.6 (error matrix)** — Task 7 tests (max_tokens, max_rounds, 401, 429) + Task 9 (disconnect). ✓
8. **Spec §5.7 (thinking blocks)** — preserved by pushing `finalMessage.content` into `currentMessages` verbatim (Task 5 implementation). ✓
9. **Spec §5.8 (single-round-trip settings load)** — Task 4 loader in parallel-eligible position inside `handleChatCompletion` streaming branch. Defaults-on-error verified by Task 4 tests. ✓
10. **Spec §6 (database)** — Task 1, with corrected schema placement (`hub.` not `private.`). ✓
11. **Spec §7 (UI)** — Task 11. ✓
12. **Spec §8 (testing)** — Tasks 5–9 cover the 12 golden cases from the spec. Integration test not included (flagged as deferred — Task 13 gives reviewer the opportunity to add). ✓
13. **Spec §9 (docs)** — Task 12. ✓
14. **Spec §10 (rollout)** — Tasks 14–15. ✓
15. **Spec §11 (flagged decisions)** — recorded in Task 15.2. ✓

**Placeholder scan:** No TBD/TODO/implement-later strings. Every code block is complete. File paths are exact. Commands show expected output. ✓

**Type consistency:** `VoiceAckSettings` shape (`{enabled, text, delayMs}`) consistent across `voice-ack.ts`, `chat-streaming.ts`, and UI (which uses camelCase `voiceAckEnabled/Text/DelayMs` for JSX state but sends snake_case to the RPC — intentional). `HandleStreamingParams` interface referenced in Task 5 is the same signature called from Task 10. ✓

**Scope:** Single feature (streaming + voice-ack), one PR-worth of work, ~15 commits. Focused. ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-16-agent-streaming-ha-voice.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
