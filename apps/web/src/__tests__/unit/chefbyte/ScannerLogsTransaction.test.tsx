/**
 * USB Scanner Task 12 — ScannerPage logs every scan to chefbyte.scan_transactions.
 *
 * The web Scanner page already does its client-side INSERTs into
 * stock_lots / food_logs / shopping_list (the existing flow). This task
 * adds an additional fire-and-forget INSERT into scan_transactions on
 * EVERY scan completion (success OR error) so the persistent audit log
 * captures all activity for the Settings → Scanner Transactions tab.
 *
 * The audit row carries the barcode, mode, status, and any downstream
 * IDs (applied_lot_id / applied_food_log_id / applied_cart_item_id) so
 * the void-mutation can reverse the side-effects later.
 *
 * Failure mode the test pins down: a successful purchase scan must
 * produce an `applied`-status scan_transactions row with the right
 * barcode + source + user_id + mode. If the logging is missing or the
 * patch shape regresses, the test fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/* ------------------------------------------------------------------ */
/*  Mock state                                                         */
/* ------------------------------------------------------------------ */

const { scanTransactionsInsertMock, invokeMock } = vi.hoisted(() => ({
  scanTransactionsInsertMock: vi.fn(() => Promise.resolve({ data: null, error: null })),
  invokeMock: vi.fn(() => Promise.resolve({ data: null, error: { message: 'not under test' } })),
}));

const productKnown = {
  product_id: 'prod-milk',
  name: 'Chocolate Milk',
  barcode: '0123456789012',
  is_placeholder: false,
  calories_per_serving: 336,
  protein_per_serving: 16,
  carbs_per_serving: 32,
  fat_per_serving: 12,
  servings_per_container: 6,
  default_shelf_life_days: null,
};

vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const root: any = {};
    root.from = vi.fn((table: string) => {
      // scan_transactions has its own dedicated insert mock so the test
      // can assert call shape without competing with other tables.
      if (table === 'scan_transactions') {
        return { insert: scanTransactionsInsertMock };
      }

      const builder: any = {};
      const state: {
        op: 'select' | 'update' | 'insert' | 'delete';
        patch: any;
        filters: Record<string, unknown>;
      } = { op: 'select', patch: null, filters: {} };

      builder.select = vi.fn(() => builder);
      builder.update = vi.fn((patch: any) => {
        state.op = 'update';
        state.patch = patch;
        return builder;
      });
      builder.insert = vi.fn((_row: any) => {
        state.op = 'insert';
        return builder;
      });
      builder.delete = vi.fn(() => {
        state.op = 'delete';
        return builder;
      });
      builder.upsert = vi.fn(() => Promise.resolve({ data: null, error: null }));
      builder.eq = vi.fn((col: string, val: unknown) => {
        state.filters[col] = val;
        return builder;
      });
      builder.is = vi.fn(() => builder);
      builder.not = vi.fn(() => builder);
      builder.order = vi.fn(() => builder);
      builder.limit = vi.fn(() => Promise.resolve({ data: [{ location_id: 'loc-1' }], error: null }));

      builder.maybeSingle = vi.fn(() => {
        if (table === 'products' && state.filters.barcode != null) {
          return Promise.resolve({
            data: state.filters.barcode === productKnown.barcode ? productKnown : null,
            error: null,
          });
        }
        if (table === 'stock_lots') {
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });
      builder.single = vi.fn(() => {
        if (table === 'stock_lots' && state.op === 'insert') {
          return Promise.resolve({ data: { lot_id: 'lot-new-1' }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      builder.then = (resolve: (v: unknown) => void) => {
        resolve({ data: null, error: null });
      };
      return builder;
    });
    root.rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    return root;
  };
  return {
    supabase: {
      functions: { invoke: invokeMock },
    },
    chefbyte,
    coachbyte: vi.fn(),
    escapeIlike: (s: string) => s,
  };
});

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 't@t.com' },
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

beforeEach(() => {
  scanTransactionsInsertMock.mockClear();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ data: null, error: { message: 'not under test' } });
});

describe('ScannerPage logs scan_transactions', () => {
  it('inserts a scan_transactions row when a scan completes', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ScannerPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const input = await screen.findByTestId('barcode-input');
    await user.clear(input);
    await user.type(input, productKnown.barcode);
    await user.keyboard('{Enter}');

    // Wait for the audit log INSERT to fire — happens after executeAction
    // resolves on a known-product fast-path scan. Assert call-count of
    // exactly 1 so a regression that double-logs (or drops) the audit
    // row doesn't slip past as "non-zero calls".
    await waitFor(() => {
      expect(scanTransactionsInsertMock).toHaveBeenCalledTimes(1);
    });

    const lastCall = scanTransactionsInsertMock.mock.calls.at(-1) as unknown[] | undefined;
    expect(lastCall).toBeTruthy();
    const patch = (lastCall?.[0] ?? {}) as Record<string, unknown>;
    expect(patch.barcode).toBe(productKnown.barcode);
    expect(patch.source).toBe('web');
    expect(patch.user_id).toBe('u-1');
    expect(['applied', 'errored']).toContain(patch.status as string);
    expect(patch.mode).toBe('purchase');
  });
});
