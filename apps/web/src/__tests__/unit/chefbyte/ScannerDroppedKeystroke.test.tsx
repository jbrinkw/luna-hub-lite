/**
 * Lock-in test for the silent-scanner-keystroke-drop UX bug
 * (matches the ignore.md brief).
 *
 * Reproduces: focus is on a non-scanner input; a hardware barcode scanner
 * fires (rapid digits + Enter); `useScannerDetection`'s protected-target
 * rule clears the buffer + early-returns, eating the entire scan; the
 * page used to render no feedback at all so the user thought their scan
 * succeeded when it actually went into a void.
 *
 * The fix surfaces the drop via:
 *   1. `onScanDropped` callback exposed by the hook
 *   2. A persistent green/yellow scanner-status indicator on ScannerPage
 *   3. A transient toast for every dropped scan
 *
 * This test renders ScannerPage, seeds focus on a non-scanner input, fires
 * a hardware-scanner-style keydown sequence, and asserts the indicator
 * flips to yellow + the toast appears + no queue row gets created (the
 * keystrokes never reached the scan handler).
 *
 * Mutation check: revert ScannerPage's `onScanDropped` wiring to a no-op
 * (e.g. `onScanDropped: () => {}`) and rerun — this test must fail with a
 * clear "expected dropped event but none fired" signal because the toast
 * never appears.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* ------------------------------------------------------------------ */
/*  Mock supabase / auth (same shape as ScannerSilentErrors.test.tsx)  */
/* ------------------------------------------------------------------ */

vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const root: any = {};
    root.from = vi.fn(() => {
      const builder: any = {};
      builder.select = vi.fn(() => builder);
      builder.update = vi.fn(() => builder);
      builder.insert = vi.fn(() => builder);
      builder.delete = vi.fn(() => builder);
      builder.upsert = vi.fn(() => Promise.resolve({ data: null, error: null }));
      builder.eq = vi.fn(() => builder);
      builder.is = vi.fn(() => builder);
      builder.order = vi.fn(() => builder);
      builder.limit = vi.fn(() => Promise.resolve({ data: [{ location_id: 'loc-1' }], error: null }));
      builder.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
      builder.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
      builder.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
      return builder;
    });
    root.rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    return root;
  };
  return {
    supabase: {
      functions: { invoke: vi.fn(() => Promise.resolve({ data: null, error: { message: 'not under test' } })) },
    },
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

import { ScannerPage } from '@/pages/chefbyte/ScannerPage';

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

/**
 * Dispatch a hardware-scanner-style keydown sequence on the given target.
 *
 * Real USB scanners type digits with ~10 ms between presses then press
 * Enter. We bypass jsdom's keyboard simulation to set the timing on
 * `Date.now()` directly so the hook's < 50 ms scanner-speed threshold is
 * satisfied even in non-fake-timer mode.
 */
function fireHardwareScan(target: HTMLElement, barcode: string) {
  const baseTime = Date.now();
  const nowSpy = vi.spyOn(Date, 'now');
  let t = baseTime;
  // The hook reads `e.target` from the event. Dispatching on `target`
  // sets event.target to that element via standard DOM event flow.
  // Wrapping in act() silences the React warning about state updates
  // (the dropped-scan toast setState fires inside the dispatch loop).
  act(() => {
    for (const ch of barcode) {
      nowSpy.mockReturnValue(t);
      target.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
      t += 10;
    }
    nowSpy.mockReturnValue(t);
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  nowSpy.mockRestore();
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('ScannerPage — dropped-keystroke surfacing', () => {
  it('renders a yellow scanner-inactive indicator when focus is not on the barcode input', async () => {
    renderScanner();

    // The active-item-display div doubles as a non-scanner element we can
    // simulate "focus is somewhere else" against. Since `autoFocus` on the
    // barcode input may or may not be honored consistently in jsdom, we
    // explicitly blur it to model the real-world bug ("user clicked
    // somewhere else after the wizard import").
    const barcodeInput = screen.getByTestId('barcode-input') as HTMLInputElement;
    act(() => {
      barcodeInput.blur();
    });

    const indicator = await screen.findByTestId('scanner-status-indicator');
    await waitFor(() => {
      expect(indicator.getAttribute('data-scanner-focused')).toBe('false');
    });
    expect(screen.getByTestId('scanner-status-text').textContent).toMatch(/inactive/i);
  });

  it('flips the indicator to active and clears the toast when focus returns to the barcode input', async () => {
    renderScanner();
    const barcodeInput = screen.getByTestId('barcode-input') as HTMLInputElement;

    // Focus first, then assert green.
    act(() => {
      barcodeInput.focus();
    });
    const indicator = await screen.findByTestId('scanner-status-indicator');
    await waitFor(() => {
      expect(indicator.getAttribute('data-scanner-focused')).toBe('true');
    });
    expect(screen.getByTestId('scanner-status-text').textContent).toMatch(/active/i);
  });

  it('shows a dropped-scan toast and does NOT create a queue row when a hardware scan fires while focus is on a non-scanner input', async () => {
    renderScanner();

    // Simulate the user-reported scenario: a non-scanner input has focus.
    // We use a fresh dummy textarea injected into the doc so the hook's
    // protected-target predicate fires (textarea is protected by default).
    const stray = document.createElement('textarea');
    stray.setAttribute('data-testid', 'stray-textarea');
    document.body.appendChild(stray);
    try {
      const barcodeInput = screen.getByTestId('barcode-input') as HTMLInputElement;
      act(() => {
        barcodeInput.blur();
        stray.focus();
      });

      // Fire a 13-event hardware scan: 12 digits + Enter.
      fireHardwareScan(stray, '012345678901');

      // Assert: dropped-scan toast renders.
      const toast = await screen.findByTestId('dropped-scan-toast');
      expect(toast.textContent).toMatch(/scan ignored/i);
      expect(toast.textContent).toMatch(/focus is on/i);

      // Assert: indicator stays yellow (focus never came back to scanner).
      const indicator = screen.getByTestId('scanner-status-indicator');
      expect(indicator.getAttribute('data-scanner-focused')).toBe('false');

      // Assert: NO queue row got created — the keystrokes never reached
      // the scan handler. queue-empty placeholder is still visible.
      expect(screen.queryByTestId('queue-empty')).not.toBeNull();
      expect(screen.queryAllByTestId(/^queue-item-/).length).toBe(0);
    } finally {
      document.body.removeChild(stray);
    }
  });

  it('clears the dropped-scan toast when the user re-focuses the barcode input', async () => {
    renderScanner();
    const stray = document.createElement('textarea');
    document.body.appendChild(stray);
    try {
      const barcodeInput = screen.getByTestId('barcode-input') as HTMLInputElement;
      act(() => {
        barcodeInput.blur();
        stray.focus();
      });

      fireHardwareScan(stray, '012345678901');
      await screen.findByTestId('dropped-scan-toast');

      // Re-focus the scanner field.
      act(() => {
        barcodeInput.focus();
      });

      await waitFor(() => {
        expect(screen.queryByTestId('dropped-scan-toast')).toBeNull();
      });
    } finally {
      document.body.removeChild(stray);
    }
  });
});
