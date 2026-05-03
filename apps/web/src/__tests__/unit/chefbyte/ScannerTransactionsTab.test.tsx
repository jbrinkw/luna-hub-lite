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

// Stub the realtime hook so the tab mounts cleanly under jsdom (the real
// hook reaches into `supabase.realtime.stateChangeCallbacks` which the
// test mock doesn't provide).
vi.mock('@/shared/useRealtimeInvalidation', () => ({ useRealtimeInvalidation: vi.fn() }));

import { ScannerTransactionsTab } from '@/pages/chefbyte/ScannerTransactionsTab';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';
import { queryKeys } from '@/shared/queryKeys';

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

  it('subscribes to realtime postgres_changes for chefbyte.scan_transactions', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ScannerTransactionsTab />
      </QueryClientProvider>,
    );

    expect(useRealtimeInvalidation).toHaveBeenCalledWith(
      'scan-transactions-tab',
      expect.arrayContaining([
        expect.objectContaining({
          schema: 'chefbyte',
          table: 'scan_transactions',
          queryKeys: [queryKeys.scanTransactions('u-1')],
        }),
      ]),
    );
    const calls = (useRealtimeInvalidation as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const tabCall = calls.find((c) => c[0] === 'scan-transactions-tab');
    const subs = tabCall![1] as Array<{ schema: string; table: string; queryKeys: readonly (readonly unknown[])[] }>;
    // Exactly one sub registered (no extras silently added).
    expect(subs).toHaveLength(1);
  });

  it('void mutation invalidates downstream caches (stockLots, shoppingList, dailyMacros, foodLogs, products)', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    render(
      <QueryClientProvider client={qc}>
        <ScannerTransactionsTab />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('111')).toBeInTheDocument();
    });

    invalidateSpy.mockClear();
    await user.click(screen.getByTestId('void-tx-1'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'shelf-ingest/scan-transaction/tx-1/void',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // Wait for onSuccess to fire (mutation resolves async).
    await waitFor(() => {
      const calls = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey?: readonly unknown[] }).queryKey);
      // Primary: scanTransactions list refresh.
      expect(calls).toContainEqual(queryKeys.scanTransactions('u-1'));
      // Defensive downstream:
      expect(calls).toContainEqual(queryKeys.products('u-1'));
      expect(calls).toContainEqual(queryKeys.stockLots('u-1'));
      expect(calls).toContainEqual(queryKeys.shoppingList('u-1'));
      // dailyMacros + foodLogs invalidated by tuple prefix (date-keyed).
      expect(calls).toContainEqual(['daily-macros', 'u-1']);
      expect(calls).toContainEqual(['food-logs', 'u-1']);
    });
  });
});
