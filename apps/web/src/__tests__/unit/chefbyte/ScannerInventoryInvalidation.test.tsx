/**
 * Inventory invalidation tests for the "successful scan never appears
 * in inventory" bug (2026-04-29).
 *
 * Reported alongside the rapid-same-barcode dedup bug — the user saw
 * "Added to fridge 1 container" toast for `Annie's Shells & White
 * Cheddar` and `Barilla Mini Farfalle` but the Inventory page didn't
 * reflect them after navigating back.
 *
 * Lock-in invariants:
 *   1. After a successful purchase scan inserts a stock_lot, the
 *      `stockLots` query key must be invalidated so the next subscriber
 *      (or a remount of /chef/inventory) refetches.
 *   2. Same invariant for the `products` key — a freshly AI-imported
 *      product needs its row in the products query.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { queryKeys } from '@/shared/queryKeys';

/* ------------------------------------------------------------------ */
/*  Mock state                                                         */
/* ------------------------------------------------------------------ */

interface MockState {
  productsInsertCount: number;
  stockLotsInsertCount: number;
}

const mockState: MockState = {
  productsInsertCount: 0,
  stockLotsInsertCount: 0,
};

vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const root: any = {};
    root.from = vi.fn((table: string) => {
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
        if (table === 'products') mockState.productsInsertCount += 1;
        if (table === 'stock_lots') mockState.stockLotsInsertCount += 1;
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
      builder.order = vi.fn(() => builder);
      builder.limit = vi.fn(() => Promise.resolve({ data: [{ location_id: 'loc-1' }], error: null }));

      builder.maybeSingle = vi.fn(() => {
        if (table === 'products') {
          // unknown barcode → null product so we hit the analyze-product path
          return Promise.resolve({ data: null, error: null });
        }
        if (table === 'stock_lots') {
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });
      builder.single = vi.fn(() => {
        if (table === 'products' && state.op === 'insert') {
          return Promise.resolve({
            data: {
              product_id: 'prod-annies',
              name: "Annie's Shells & White Cheddar",
              is_placeholder: false,
              servings_per_container: 2.5,
              calories_per_serving: 270,
              protein_per_serving: 9,
              carbs_per_serving: 49,
              fat_per_serving: 4,
              default_shelf_life_days: 365,
            },
            error: null,
          });
        }
        if (table === 'stock_lots' && state.op === 'insert') {
          return Promise.resolve({ data: { lot_id: 'lot-annies-1' }, error: null });
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
      functions: {
        invoke: vi.fn(() =>
          Promise.resolve({
            data: {
              suggestion: {
                name: "Annie's Shells & White Cheddar",
                calories_per_serving: 270,
                protein_per_serving: 9,
                carbs_per_serving: 49,
                fat_per_serving: 4,
                servings_per_container: 2.5,
                default_shelf_life_days: 365,
              },
            },
            error: null,
          }),
        ),
      },
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

function renderScannerWith(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chef/scanner']}>
        <ScannerPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function scanBarcode(user: ReturnType<typeof userEvent.setup>, barcode: string) {
  const input = screen.getByTestId('barcode-input') as HTMLInputElement;
  await user.clear(input);
  await user.type(input, barcode);
  await user.keyboard('{Enter}');
}

beforeEach(() => {
  mockState.productsInsertCount = 0;
  mockState.stockLotsInsertCount = 0;
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('ScannerPage — inventory invalidation after successful scan', () => {
  it('invalidates stockLots + products queries after a successful purchase scan', async () => {
    const userId = 'user-1';
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // Pre-seed stockLots and products as fresh data so we can detect the
    // post-scan invalidation. Without seeding, `getQueryState` returns
    // undefined and we can't observe the stale-flip.
    qc.setQueryData(queryKeys.stockLots(userId), []);
    qc.setQueryData(queryKeys.products(userId), []);

    // Sanity: both queries start fresh (not invalidated).
    expect(qc.getQueryState(queryKeys.stockLots(userId))?.isInvalidated).toBe(false);
    expect(qc.getQueryState(queryKeys.products(userId))?.isInvalidated).toBe(false);

    const user = userEvent.setup();
    renderScannerWith(qc);

    await scanBarcode(user, '013562000043');

    // Wait for the pipeline: products INSERT (analyze-product result
    // creates the product) AND stock_lots INSERT (executeAction purchase).
    await waitFor(() => {
      expect(mockState.productsInsertCount).toBe(1);
      expect(mockState.stockLotsInsertCount).toBe(1);
    });

    // CRITICAL: both InventoryPage query keys must be marked invalidated
    // — that's what triggers the refetch when the user navigates back to
    // /chef/inventory. Before the fix, the invalidate() call lived after
    // the early-return inside the purchase case, so it never fired.
    await waitFor(() => {
      expect(qc.getQueryState(queryKeys.stockLots(userId))?.isInvalidated).toBe(true);
      expect(qc.getQueryState(queryKeys.products(userId))?.isInvalidated).toBe(true);
    });
  });
});
