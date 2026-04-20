/**
 * Mutation-hardening tests for the ScannerPage numeric keypad.
 *
 * The pure `src/__tests__/unit/pure/keypad-logic.test.ts` tests a REPLICA of
 * the algorithm copied into the test file — it does NOT import the real
 * component. That means a bug introduced in ScannerPage.handleKeypadClick
 * (backspace-to-'0' fallback, double-decimal guard, overwriteNext semantics)
 * would never be caught by those tests.
 *
 * These tests mount the real ScannerPage and drive the keypad via its rendered
 * buttons, asserting the DOM's `screen-value` display state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ScannerPage } from '@/pages/chefbyte/ScannerPage';

/* ------------------------------------------------------------------ */
/*  Supabase mock (minimal — keypad tests don't hit DB)                */
/* ------------------------------------------------------------------ */

vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const builder: any = {};
    builder.from = vi.fn(() => {
      const tb: any = {};
      for (const m of ['select', 'eq', 'is', 'order', 'limit', 'update', 'insert']) {
        tb[m] = vi.fn(() => tb);
      }
      tb.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
      return tb;
    });
    builder.rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    return builder;
  };
  return {
    supabase: { functions: { invoke: vi.fn(() => Promise.resolve({ data: null, error: null })) } },
    chefbyte,
    coachbyte: vi.fn(),
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

vi.mock('@/hooks/useSettingsAlerts', () => ({
  useSettingsAlerts: () => false,
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function renderScanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chef/scanner']}>
        <ScannerPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function screenValue(): string {
  return screen.getByTestId('screen-value').textContent?.trim() ?? '';
}

async function clickKey(user: ReturnType<typeof userEvent.setup>, label: string) {
  // Back arrow is a special key — data-testid="key-backspace".
  const testId = label === '\u2190' ? 'key-backspace' : `key-${label}`;
  await user.click(screen.getByTestId(testId));
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('ScannerPage keypad — backspace fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("backspace on a 1-char value falls back to '0' (not '' or '1')", async () => {
    // Default screen starts at '1' with overwriteNext=true.
    // First digit overwrites, then backspace leaves an empty slice → fallback.
    // A mutation that changes the `|| '0'` fallback to `|| '1'` or removes it
    // would be invisible to the pure keypad-logic test (which tests a replica).
    const user = userEvent.setup();
    renderScanner();

    // Type '5' — overwrites the initial '1' → screen shows '5'.
    await clickKey(user, '5');
    expect(screenValue()).toBe('5');

    // Backspace — slice leaves '' → fallback should produce '0'.
    await clickKey(user, '\u2190');
    expect(screenValue()).toBe('0');
  });

  it("backspace on '0' remains '0' (does not fall through to '' or loop)", async () => {
    const user = userEvent.setup();
    renderScanner();

    // Drive the screen to '0' first.
    await clickKey(user, '5');
    await clickKey(user, '\u2190');
    expect(screenValue()).toBe('0');

    // Another backspace must not produce '' or crash.
    await clickKey(user, '\u2190');
    expect(screenValue()).toBe('0');
  });
});

describe('ScannerPage keypad — double-decimal guard', () => {
  it('pressing decimal twice leaves a single "." (no "3..5" drift)', async () => {
    const user = userEvent.setup();
    renderScanner();

    // Start fresh: overwrite '1' with '3', then '.', '5' → '3.5'.
    await clickKey(user, '3');
    await clickKey(user, '.');
    await clickKey(user, '5');
    expect(screenValue()).toBe('3.5');

    // A second '.' must be dropped. A mutation that removes the
    // `!current.includes('.')` guard would append and produce '3.5.'.
    await clickKey(user, '.');
    expect(screenValue()).toBe('3.5');
  });
});

describe('ScannerPage keypad — overwriteNext on first entry', () => {
  it("first digit after load REPLACES the default '1' instead of appending", async () => {
    // Default screen: '1' with overwriteNext=true. If a mutation flipped the
    // overwriteNext initial to `false`, the first click would append and
    // produce '17' instead of '7'.
    const user = userEvent.setup();
    renderScanner();
    expect(screenValue()).toBe('1');

    await clickKey(user, '7');
    expect(screenValue()).toBe('7');
  });

  it("decimal with overwriteNext starts '0.' (not '1.')", async () => {
    // Mutating the `if (overwriteNext)` branch of the decimal handler to
    // append (`.` to the existing '1') would yield '1.' instead of '0.'.
    const user = userEvent.setup();
    renderScanner();
    expect(screenValue()).toBe('1');

    await clickKey(user, '.');
    expect(screenValue()).toBe('0.');
  });
});
