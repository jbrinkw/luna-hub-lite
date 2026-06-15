/**
 * A2-09 — CoachByte Settings must accept an explicit 0 for Default Rest /
 * Bar Weight.
 *
 * Bug: the inputs used `Number(e.target.value) || 90` (and `|| 45`). Because
 * 0 is falsy, typing "0" (a legitimate value — "no rest timer", or a
 * bodyweight / bar-only setup) was silently coerced back to the default. The
 * user could never store 0.
 *
 * Fix: the onChange now routes through exported pure parsers
 * (`parseRestInput` / `parseWeightInput`) that preserve a real 0 and only
 * fall back to the default on an empty/invalid (or negative) value.
 *
 * Two layers of coverage:
 *   1. Pure: the parsers keep 0, fall back on '' / NaN / negative.
 *   2. Component: render the real SettingsPage, type 0 + blur, assert the
 *      persisted update payload carries `default_rest_seconds: 0` (not 90).
 *      The pre-fix `|| 90` would persist 90 here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { parseRestInput, parseWeightInput } from '@/pages/coachbyte/SettingsPage';

describe('SettingsPage parsers — preserve explicit 0 (A2-09, pure)', () => {
  it('parseRestInput keeps a real 0', () => {
    expect(parseRestInput('0')).toBe(0);
  });

  it('parseWeightInput keeps a real 0', () => {
    expect(parseWeightInput('0')).toBe(0);
  });

  it('keeps ordinary positive values', () => {
    expect(parseRestInput('120')).toBe(120);
    expect(parseWeightInput('35')).toBe(35);
    expect(parseWeightInput('2.5')).toBe(2.5);
  });

  it('falls back to the default on empty input', () => {
    expect(parseRestInput('')).toBe(90);
    expect(parseRestInput('   ')).toBe(90);
    expect(parseWeightInput('')).toBe(45);
  });

  it('falls back to the default on non-numeric / negative input', () => {
    expect(parseRestInput('abc')).toBe(90);
    expect(parseWeightInput('not-a-number')).toBe(45);
    // min="0" inputs disallow negatives in the browser, but guard anyway.
    expect(parseRestInput('-5')).toBe(90);
    expect(parseWeightInput('-1')).toBe(45);
  });
});

/* ------------------------------------------------------------------ */
/*  Component-level: typing 0 persists 0, not the default             */
/* ------------------------------------------------------------------ */

interface UpdateCall {
  table: string;
  payload: Record<string, unknown>;
}
const updateCalls: UpdateCall[] = [];

// Seed the settings query with non-zero values so the initial state is well
// defined; the test then drives the rest input to 0.
const settingsRow = { default_rest_seconds: 90, bar_weight_lbs: 45, available_plates: [45, 35, 25, 10, 5, 2.5] };

vi.mock('@/shared/supabase', () => {
  const buildSchemaClient = () => {
    const root: any = {};
    root.rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    root.from = vi.fn((table: string) => {
      const builder: any = {};
      let pendingUpdate: Record<string, unknown> | null = null;

      builder.select = vi.fn(() => builder);
      builder.or = vi.fn(() => builder);
      builder.order = vi.fn(() => Promise.resolve({ data: [], error: null }));
      builder.eq = vi.fn(() => {
        // For an update chain, .eq() is terminal — record the payload.
        if (pendingUpdate) {
          updateCalls.push({ table, payload: pendingUpdate });
          pendingUpdate = null;
          return Promise.resolve({ data: null, error: null });
        }
        return builder;
      });
      builder.update = vi.fn((payload: Record<string, unknown>) => {
        pendingUpdate = payload;
        return builder;
      });
      builder.insert = vi.fn(() => Promise.resolve({ data: null, error: null }));
      builder.single = vi.fn(() => {
        if (table === 'user_settings') {
          return Promise.resolve({ data: settingsRow, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });
      return builder;
    });
    return root;
  };

  const supabase: any = {
    schema: vi.fn(() => buildSchemaClient()),
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn(() => ({ state: 'SUBSCRIBED' })) })),
    removeChannel: vi.fn(),
    functions: { invoke: vi.fn(() => Promise.resolve({ data: null, error: null })) },
  };

  return {
    supabase,
    chefbyte: () => buildSchemaClient(),
    coachbyte: () => buildSchemaClient(),
    escapeIlike: (s: string) => s,
  };
});

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 't@t.com' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

import { SettingsPage } from '@/pages/coachbyte/SettingsPage';

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/coach/settings']}>
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SettingsPage — typing 0 persists 0, not the default (A2-09, component)', () => {
  beforeEach(() => {
    updateCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('Default Rest set to 0 saves default_rest_seconds: 0', async () => {
    renderSettings();

    const input = (await screen.findByTestId('default-rest-input')) as HTMLInputElement;

    // Drive the controlled input's onChange to "0". With the pre-fix
    // `Number(value) || 90`, the state would snap to 90 and the input would
    // re-render showing 90; with the fix it holds 0.
    fireEvent.change(input, { target: { value: '0' } });
    await waitFor(() => expect(input.value).toBe('0'));

    // Blur triggers saveSettings → user_settings update.
    fireEvent.blur(input);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    const settingsUpdate = updateCalls.find((c) => c.table === 'user_settings');
    expect(settingsUpdate).toBeDefined();
    expect(settingsUpdate!.payload).toMatchObject({ default_rest_seconds: 0 });
    // Regression guard: must NOT have been coerced to the default.
    expect(settingsUpdate!.payload.default_rest_seconds).not.toBe(90);
  });

  it('Bar Weight set to 0 saves bar_weight_lbs: 0', async () => {
    renderSettings();

    const input = (await screen.findByTestId('bar-weight-input')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0' } });
    await waitFor(() => expect(input.value).toBe('0'));

    fireEvent.blur(input);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    const settingsUpdate = updateCalls.find((c) => c.table === 'user_settings');
    expect(settingsUpdate).toBeDefined();
    expect(settingsUpdate!.payload).toMatchObject({ bar_weight_lbs: 0 });
    expect(settingsUpdate!.payload.bar_weight_lbs).not.toBe(45);
  });
});
