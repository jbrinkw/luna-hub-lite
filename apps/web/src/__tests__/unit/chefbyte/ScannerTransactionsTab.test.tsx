import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { invokeMock, sampleRows } = vi.hoisted(() => {
  const invokeMock = vi.fn((..._args: any[]) => Promise.resolve({ data: { ok: true }, error: null }));
  const sampleRows = [
    {
      transaction_id: 'tx-1',
      barcode: '111',
      product_id: 'p-1',
      mode: 'purchase',
      qty: 1,
      unit: 'container',
      status: 'applied',
      source: 'pi_usb',
      error_msg: null,
      logical_date: '2026-05-03',
      created_at: '2026-05-03T00:00:00Z',
    },
    {
      transaction_id: 'tx-2',
      barcode: '222',
      product_id: 'p-2',
      mode: 'consume_macros',
      qty: 1,
      unit: 'serving',
      status: 'errored',
      source: 'web',
      error_msg: 'No location configured',
      logical_date: '2026-05-03',
      created_at: '2026-05-03T00:01:00Z',
    },
  ];
  return { invokeMock, sampleRows };
});

vi.mock('@/shared/supabase', async () => {
  const actual = await vi.importActual<typeof import('@/shared/supabase')>('@/shared/supabase');
  return {
    ...actual,
    supabase: { ...actual.supabase, functions: { invoke: invokeMock } },
    chefbyte: () => ({
      from: (table: string) => {
        if (table === 'scan_transactions') {
          return {
            select: () => ({
              eq: () => ({
                order: () => Promise.resolve({ data: sampleRows, error: null }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) };
      },
    }),
  };
});

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'u-1' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

import { ScannerTransactionsTab } from '@/pages/chefbyte/ScannerTransactionsTab';

describe('ScannerTransactionsTab', () => {
  it('lists transactions and allows void', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ScannerTransactionsTab />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('111')).toBeInTheDocument();
    });
    expect(screen.getByText('222')).toBeInTheDocument();

    // Void only on applied row.
    expect(screen.queryByTestId('void-tx-1')).toBeInTheDocument();
    expect(screen.queryByTestId('void-tx-2')).not.toBeInTheDocument(); // errored has no void btn

    await user.click(screen.getByTestId('void-tx-1'));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'shelf-ingest/scan-transaction/tx-1/void',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });
});
