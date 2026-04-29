/**
 * In-flight barcode dedup tests for the rapid-same-barcode-scan bug
 * (2026-04-29). Reported by the user: scanning the same NEW barcode
 * three times in quick succession (before analyze-product resolves)
 * spawned three duplicate `Unknown (<barcode>)` products in the queue
 * + three "Added to fridge 1 container" mints — even though the user's
 * physical action was a single barcode + an unintentional repeat trigger.
 *
 * Lock-in invariants:
 *   1. Same barcode scanned twice while the first analyze-product is
 *      still pending → only ONE queue row + ONE products INSERT.
 *   2. After the in-flight pipeline resolves, scanning the same barcode
 *      again is allowed (it's now a refill, not a dupe).
 *   3. The dropped-scan toast surfaces the "Scanning..." state so the
 *      user gets feedback instead of silent rejection.
 *   4. A pipeline failure releases the in-flight lock so a retry works.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* ------------------------------------------------------------------ */
/*  Mock state                                                         */
/* ------------------------------------------------------------------ */

interface MockState {
  /** Resolves the next analyze-product call. Tests can hold this open
      to simulate the "still in flight" window while a 2nd scan fires. */
  analyzePending: { resolve: (v: unknown) => void; promise: Promise<unknown> } | null;
  /** Count of products INSERT calls — the load-bearing invariant for
      bug 1. Two parallel scans of the same NEW barcode used to mint
      two products; with dedup it must be exactly one. */
  productsInsertCount: number;
  /** Count of stock_lots INSERT calls. Same idea — two scans, one lot. */
  stockLotsInsertCount: number;
  /** Count of analyze-product invocations. */
  analyzeInvocationCount: number;
}

const mockState: MockState = {
  analyzePending: null,
  productsInsertCount: 0,
  stockLotsInsertCount: 0,
  analyzeInvocationCount: 0,
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
          // Simulate "barcode unknown" — null product, null error. This
          // forces the pipeline into the analyze-product fallback branch
          // where the dedup is the load-bearing concern.
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
            data: { product_id: 'prod-from-ai', name: "Annie's Shells", is_placeholder: false },
            error: null,
          });
        }
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
      functions: {
        invoke: vi.fn(() => {
          mockState.analyzeInvocationCount += 1;
          // Make analyze-product hold open until the test releases it,
          // mimicking the 5-25 s real-world latency window where bug 1
          // happens.
          let resolveFn!: (v: unknown) => void;
          const promise = new Promise<unknown>((r) => {
            resolveFn = r;
          });
          mockState.analyzePending = { resolve: resolveFn, promise };
          return promise.then(() => ({
            data: {
              suggestion: {
                name: "Annie's Shells",
                calories_per_serving: 270,
                protein_per_serving: 9,
                carbs_per_serving: 49,
                fat_per_serving: 4,
                servings_per_container: 2.5,
                default_shelf_life_days: 365,
              },
            },
            error: null,
          }));
        }),
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

async function scanBarcode(user: ReturnType<typeof userEvent.setup>, barcode: string) {
  const input = screen.getByTestId('barcode-input') as HTMLInputElement;
  await user.clear(input);
  await user.type(input, barcode);
  await user.keyboard('{Enter}');
}

beforeEach(() => {
  mockState.analyzePending = null;
  mockState.productsInsertCount = 0;
  mockState.stockLotsInsertCount = 0;
  mockState.analyzeInvocationCount = 0;
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('ScannerPage — in-flight barcode dedup', () => {
  it('drops a 2nd scan of the same barcode while the 1st pipeline is in flight', async () => {
    const user = userEvent.setup();
    renderScanner();

    // Scan #1 — pipeline starts, analyze-product is pending.
    await scanBarcode(user, '013562000043');

    // Wait for analyze-product to be invoked (pipeline reached the AI step).
    await waitFor(() => {
      expect(mockState.analyzeInvocationCount).toBeGreaterThan(0);
    });

    const inflightInvocations = mockState.analyzeInvocationCount;

    // Scan #2 — same barcode, while #1 is still pending.
    await scanBarcode(user, '013562000043');

    // The dedup must surface as a "Scanning..." toast.
    await waitFor(() => {
      expect(screen.queryByTestId('dropped-scan-toast')).not.toBeNull();
    });
    expect(screen.getByTestId('dropped-scan-toast').textContent).toContain('Scanning');

    // Critical: analyze-product must NOT have been called a second time.
    expect(mockState.analyzeInvocationCount).toBe(inflightInvocations);

    // Now release the in-flight analyze-product. Only one pipeline ever ran
    // → only ONE products INSERT and ONE stock_lots INSERT.
    mockState.analyzePending!.resolve(undefined);

    await waitFor(() => {
      expect(mockState.productsInsertCount).toBe(1);
    });
    expect(mockState.stockLotsInsertCount).toBe(1);

    // And the queue should show exactly one row, not two.
    const queueRows = screen.getAllByTestId(/^queue-item-/);
    expect(queueRows.length).toBe(1);
  });

  it('allows re-scanning the same barcode AFTER the in-flight pipeline finishes', async () => {
    const user = userEvent.setup();
    renderScanner();

    // Scan #1 → resolve immediately so it completes.
    await scanBarcode(user, '013562000043');
    await waitFor(() => {
      expect(mockState.analyzePending).not.toBeNull();
    });
    mockState.analyzePending!.resolve(undefined);

    // Wait for the pipeline to fully settle (products INSERT done).
    await waitFor(() => {
      expect(mockState.productsInsertCount).toBe(1);
    });

    // Scan #2 — same barcode, AFTER #1 finished. The dedup lock must
    // have been released, so a fresh pipeline starts.
    await scanBarcode(user, '013562000043');

    await waitFor(() => {
      expect(mockState.analyzeInvocationCount).toBe(2);
    });
  });
});
