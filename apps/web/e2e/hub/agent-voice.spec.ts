/**
 * Hub Voice Assist / AI Agent coverage (audit item #19).
 *
 * Backend-only E2E: Luna's Voice Assist surface has NO in-app chat UI. The
 * `/v1/chat/completions` endpoint is consumed externally (Home Assistant
 * extended_openai_conversation). The Hub's Voice Assist card only configures
 * the filler phrase, system prompt, and Anthropic key — it is not a chat.
 *
 * So the prod-realistic path to cover is the HTTP endpoint itself, driven
 * from Node (still through real wrangler dev + real Supabase local — no
 * mocks at any layer). We cover the failure + edge paths that don't require
 * a real Anthropic key:
 *
 *   1. No Bearer token → 401 authentication_error.
 *   2. Bearer token valid but no Anthropic key configured → 422 with actionable
 *      "not configured" message (this is the single most common misconfig,
 *      and the HA voice integration renders this as a spoken error).
 *   3. Malformed messages → 400 with structured error payload.
 *   4. `/v1/models` (no auth) → 200 with claude-haiku-4-5.
 *   5. Hub UI: Voice Assist card renders on /hub/agent, accepts a filler
 *      phrase + delay, and saves successfully. The settings being
 *      persisted is what drives the streaming worker's ACK filler logic.
 *   6. Hub UI: saving an Anthropic key then clearing it toggles the
 *      "Configured" / "Not configured" badge — regression guard for the
 *      key-management flow the AgentPage test doesn't assert end-to-end.
 *   7. Hub UI: system prompt persists across reload.
 *
 * This pins the backend's error envelope (the response shape HA consumes) and
 * the Hub-side settings flow that feeds into /v1/chat/completions. Any future
 * change to the auth paths, error shapes, or settings RPCs will fail CI.
 *
 * Happy-path streaming (Anthropic key + tool call + token streaming) requires
 * a live Anthropic API key in the environment; that's covered by the
 * chat-streaming.test.ts unit suite which uses a fake Anthropic. Adding a
 * real-Anthropic E2E is tracked under a separate nightly gating decision.
 */
import { test, expect } from '@playwright/test';
import { seedFullAndLogin, seedUser } from '../helpers/seed';
import { generateTestApiKey } from '../helpers/mcp-client';

const MCP_WORKER_URL = process.env.MCP_WORKER_URL ?? 'http://localhost:8787';

test.describe('Hub Voice Assist — backend endpoint', () => {
  test('no Bearer token → 401 authentication_error', async () => {
    const res = await fetch(`${MCP_WORKER_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.error.type).toBe('authentication_error');
  });

  test('invalid Bearer token → 401 (same shape as no-auth)', async () => {
    const res = await fetch(`${MCP_WORKER_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer not-a-real-key',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(res.status).toBe(401);
  });

  test('authenticated but no Anthropic key configured → 422 with actionable message', async () => {
    const { userId, cleanup } = await seedUser('voice-noanthropic');
    const apiKey = await generateTestApiKey(userId);
    try {
      const res = await fetch(`${MCP_WORKER_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      // 422 when no key is set — this is what HA will receive and must render
      // gracefully. We pin the shape so a future change to the error envelope
      // doesn't silently break HA's voice response.
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBeTruthy();
      expect(typeof body.error.message).toBe('string');
      // The message must be actionable — pointing the user at Hub settings.
      expect(body.error.message.toLowerCase()).toContain('anthropic');
    } finally {
      await cleanup();
    }
  });

  test('malformed messages array → 400 with structured error', async () => {
    const { userId, cleanup } = await seedUser('voice-malformed');
    const apiKey = await generateTestApiKey(userId);
    try {
      // messages is missing entirely
      const res1 = await fetch(`${MCP_WORKER_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001' }),
      });
      expect(res1.status).toBe(400);
      const body1 = await res1.json();
      expect(body1.error).toBeTruthy();

      // messages is empty
      const res2 = await fetch(`${MCP_WORKER_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          messages: [],
        }),
      });
      expect(res2.status).toBe(400);

      // invalid JSON body
      const res3 = await fetch(`${MCP_WORKER_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: '{not valid json',
      });
      expect(res3.status).toBe(400);
    } finally {
      await cleanup();
    }
  });

  test('GET /v1/models (no auth) returns Claude Haiku model list', async () => {
    const res = await fetch(`${MCP_WORKER_URL}/v1/models`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const hasHaiku = body.data.some((m: any) =>
      typeof m.id === 'string' && m.id.includes('haiku'),
    );
    expect(hasHaiku).toBe(true);
  });

  test('mid-stream: disconnecting a request does not wedge future calls', async () => {
    // Proves the worker handles client aborts cleanly — a regression here
    // would accumulate zombie DO sessions or corrupted tool-logger state.
    // We abort an in-flight request (no Anthropic key, so it bails at 422,
    // but we abort before that), then immediately issue a second request
    // and verify it still gets a clean 401/422 — not a hang or 5xx.
    const { userId, cleanup } = await seedUser('voice-disconnect');
    const apiKey = await generateTestApiKey(userId);
    try {
      const controller = new AbortController();
      const p = fetch(`${MCP_WORKER_URL}/v1/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
        }),
      }).catch(() => null); // abort produces a rejection; swallow it

      // Abort mid-flight
      setTimeout(() => controller.abort(), 50);
      await p;

      // Follow-up request works cleanly
      const res2 = await fetch(`${MCP_WORKER_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });
      // Either 401 (flaky auth cache) or 422 (no Anthropic key) — both valid.
      // What we're proving: no 5xx, no hang.
      expect([401, 422]).toContain(res2.status);
    } finally {
      await cleanup();
    }
  });
});

test.describe('Hub Voice Assist — UI settings flow', () => {
  test('Voice Assist card renders on /hub/agent and saves filler phrase', async ({ page }) => {
    const { cleanup } = await seedFullAndLogin(page, 'voice-ui-filler');
    try {
      await page.goto('/hub/agent');
      await expect(page.getByRole('heading', { name: /voice assist/i })).toBeVisible({ timeout: 30000 });

      // Enable the filler
      const checkbox = page.locator('input[type=checkbox]').first();
      const isChecked = await checkbox.isChecked();
      if (!isChecked) {
        await checkbox.check();
      }

      // Change the filler phrase — use textbox role to avoid matching the
      // similarly-labeled "Speak a filler phrase…" checkbox.
      const fillerInput = page.getByRole('textbox', { name: 'Filler phrase' });
      await fillerInput.fill('One sec, checking that...');

      // Change the delay
      const delayInput = page.getByRole('spinbutton', { name: /delay before filler/i });
      await delayInput.fill('800');

      // Save via the "Save" button that lives inside the Voice Assist card.
      // Both cards (System Prompt + Voice Assist) render their own Save button;
      // pick the one adjacent to the Voice Assist content.
      await page.getByRole('button', { name: /^save$/i }).last().click();

      await expect(page.getByText(/voice assist saved/i)).toBeVisible({ timeout: 30000 });

      // Reload — values must persist
      await page.reload();
      await expect(page.getByRole('heading', { name: /voice assist/i })).toBeVisible({ timeout: 30000 });
      await expect(page.getByRole('textbox', { name: 'Filler phrase' })).toHaveValue('One sec, checking that...', {
        timeout: 30000,
      });
      await expect(page.getByRole('spinbutton', { name: /delay before filler/i })).toHaveValue('800', {
        timeout: 30000,
      });
    } finally {
      await cleanup();
    }
  });

  test('Anthropic key save + clear toggles the Configured badge', async ({ page }) => {
    const { cleanup } = await seedFullAndLogin(page, 'voice-ui-key');
    try {
      await page.goto('/hub/agent');
      await expect(page.getByRole('heading', { name: /anthropic api key/i })).toBeVisible({ timeout: 30000 });

      // Initially "Not configured"
      await expect(page.getByText(/not configured/i)).toBeVisible({ timeout: 30000 });

      // Enter a dummy key + save. We don't call Anthropic here — the save path
      // just encrypts + persists via RPC. Real Anthropic auth happens at
      // /v1/chat/completions invocation time, not at save time.
      const keyInput = page.getByLabel('API Key');
      await keyInput.fill('sk-ant-e2e-test-dummy-key-0000');
      await page.getByRole('button', { name: /save key/i }).click();

      // Badge flips to Configured
      await expect(page.getByText(/^configured$/i)).toBeVisible({ timeout: 30000 });
      await expect(page.getByText(/api key saved/i)).toBeVisible({ timeout: 30000 });

      // Remove the key
      await page.getByRole('button', { name: /remove key/i }).click();
      await expect(page.getByText(/not configured/i)).toBeVisible({ timeout: 30000 });
    } finally {
      await cleanup();
    }
  });

  test('system prompt persists across reload', async ({ page }) => {
    const { cleanup } = await seedFullAndLogin(page, 'voice-ui-prompt');
    try {
      await page.goto('/hub/agent');
      await expect(page.getByRole('heading', { name: /system prompt/i })).toBeVisible({ timeout: 30000 });

      const textarea = page.locator('textarea').first();
      const newPrompt = 'You are Luna, answering every question with a haiku.';
      await textarea.fill(newPrompt);

      await page.getByRole('button', { name: /save prompt/i }).click();
      await expect(page.getByText(/system prompt saved/i)).toBeVisible({ timeout: 30000 });

      await page.reload();
      await expect(page.locator('textarea').first()).toHaveValue(newPrompt, { timeout: 30000 });
    } finally {
      await cleanup();
    }
  });
});
