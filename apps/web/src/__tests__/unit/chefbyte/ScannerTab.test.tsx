import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const invokeMock = vi.fn((..._args: any[]) => Promise.resolve({ data: null, error: null }));
vi.mock('@/shared/supabase', async () => {
  const actual = await vi.importActual<typeof import('@/shared/supabase')>('@/shared/supabase');
  return {
    ...actual,
    supabase: { ...actual.supabase, functions: { invoke: invokeMock } },
  };
});
vi.mock('@/shared/scannerStateApi', () => ({
  pushScannerMode: (patch: any) => invokeMock('shelf-ingest/scanner-state', { body: patch }).then(() => undefined),
  fetchScannerState: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'u-1' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

import { ScannerTab } from '@/pages/chefbyte/ScannerTab';

describe('ScannerTab', () => {
  it('toggling lock + selecting mode + saving POSTs locked_mode', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ScannerTab />
      </QueryClientProvider>,
    );
    await user.click(screen.getByTestId('scanner-lock-toggle'));
    await user.selectOptions(screen.getByTestId('scanner-locked-mode-select'), 'shopping');
    await user.click(screen.getByTestId('scanner-save-lock'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'shelf-ingest/scanner-state',
        expect.objectContaining({ body: { locked_mode: 'shopping' } }),
      );
    });
  });

  it('toggling lock OFF and saving POSTs locked_mode=null', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ScannerTab />
      </QueryClientProvider>,
    );
    // Toggle ON then OFF.
    await user.click(screen.getByTestId('scanner-lock-toggle'));
    await user.click(screen.getByTestId('scanner-lock-toggle'));
    await user.click(screen.getByTestId('scanner-save-lock'));

    await waitFor(() => {
      const call = invokeMock.mock.calls.find((c) => (c[1] as any)?.body?.locked_mode === null);
      expect(call).toBeDefined();
    });
  });
});
