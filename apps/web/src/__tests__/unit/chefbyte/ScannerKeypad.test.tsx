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
import { render, screen, fireEvent, act } from '@testing-library/react';
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

describe('ScannerPage keypad — commits on every press into nutrition field', () => {
  it('each digit press appends to the active nutrition field (no Enter required)', async () => {
    // Regression guard for the "keypad should auto update without an enter
    // key or moving to a new field" complaint. Before the fix, rapid-fire
    // presses in the same React batch all read the stale render-time
    // `overwriteNext=true` closure, so each press replaced the prior digit
    // and 3 presses of 5-0-0 collapsed to '0' instead of appending to '500'.
    // The functional-setter + ref rewrite makes each press read the latest
    // committed value. Assert 3 distinct intermediate snapshots.
    const user = userEvent.setup();
    renderScanner();

    // Focus the calories field (a nutrition field, not the screen).
    const calories = screen.getByTestId('nut-calories') as HTMLInputElement;
    await user.click(calories);
    expect(calories.value).toBe('');

    await user.click(screen.getByTestId('key-5'));
    expect(calories.value).toBe('5'); // snapshot 1

    await user.click(screen.getByTestId('key-0'));
    expect(calories.value).toBe('50'); // snapshot 2

    await user.click(screen.getByTestId('key-0'));
    expect(calories.value).toBe('500'); // snapshot 3
  });

  it('rapid-fire presses batched in the same tick each append (no stale-closure collapse)', async () => {
    // Stress version: fire 3 clicks synchronously inside a single `act()` so
    // React batches them and no re-render runs between clicks. The fix uses
    // functional state updaters + a ref for overwriteNext, so each click
    // still sees the previous click's output. A regression (reverting to
    // closure reads) would collapse this to '0' or '5'.
    renderScanner();
    const calories = screen.getByTestId('nut-calories') as HTMLInputElement;
    act(() => {
      fireEvent.click(calories);
    });
    act(() => {
      fireEvent.click(screen.getByTestId('key-5'));
      fireEvent.click(screen.getByTestId('key-0'));
      fireEvent.click(screen.getByTestId('key-0'));
    });
    expect(calories.value).toBe('500');
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
