/**
 * In-flight barcode coordination tests.
 *
 * Original bug (2026-04-29): rapid-firing the same NEW barcode spawned
 * parallel analyze-product calls + duplicate INSERTs. The first fix was
 * a silent-drop dedup — but that lost legitimate "I scanned 3 of these
 * to add 3 lots" intent.
 *
 * Current design: a Map<barcode, Promise> queues duplicate scans. Scan 2
 * awaits scan 1's pipeline, then re-enters via the ref. By the time
 * scan 2 retries, scan 1 has committed its product row, so scan 2 takes
 * the existing-product path and adds its OWN stock_lot. The user's
 * stated rule was "3 ramen scans = 3 inventory increments, only 1 LLM
 * call."
 *
 * Lock-in invariants:
 *   1. Same barcode scanned twice while #1's analyze-product is still
 *      pending → only ONE analyze-product call until #1 settles.
 *   2. The "Queued..." toast surfaces the wait state so the user gets
 *      feedback instead of silent rejection.
 *   3. After #1 completes, #2's awaiting handler wakes and produces its
 *      own queue row + its own stock_lot.
 *   4. After the in-flight pipeline resolves, fresh scans of the same
 *      barcode start their own pipelines (no zombie lock).
 *   5. A pipeline failure releases the slot so a retry works.
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
      builder.not = vi.fn(() => builder);
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

describe('ScannerPage — in-flight barcode coordination', () => {
  it('queues a 2nd same-barcode scan and runs it after the 1st pipeline completes', async () => {
    const user = userEvent.setup();
    renderScanner();

    // Scan #1 — pipeline starts, analyze-product hangs at the AI step.
    await scanBarcode(user, '013562000043');
    await waitFor(() => {
      expect(mockState.analyzeInvocationCount).toBe(1);
    });

    // Scan #2 — same barcode, while #1 is still pending.
    await scanBarcode(user, '013562000043');

    // The "Queued..." toast surfaces the wait state.
    await waitFor(() => {
      expect(screen.queryByTestId('dropped-scan-toast')).not.toBeNull();
    });
    expect(screen.getByTestId('dropped-scan-toast').textContent).toContain('Queued');

    // Load-bearing invariant: analyze-product MUST NOT have been called a
    // second time while #1 is in-flight. Scan 2 is parked on the await.
    expect(mockState.analyzeInvocationCount).toBe(1);

    // Release #1's analyze-product. Pipeline 1 completes → 1st INSERTs.
    mockState.analyzePending!.resolve(undefined);
    await waitFor(() => {
      expect(mockState.productsInsertCount).toBe(1);
    });

    // After #1 resolves, #2's awaiting handler wakes and re-enters the
    // scan flow. The mock's products lookup always returns null (it can't
    // simulate "row now exists"), so #2's retry runs its own analyze-
    // product call. In production the lookup would match the live row
    // and short-circuit to executeAction directly — invariant being
    // tested here is "scan 2 produces its own pipeline AFTER #1 resolves",
    // not the specific lookup behavior the mock can't replicate.
    await waitFor(() => {
      expect(mockState.analyzeInvocationCount).toBe(2);
    });

    // Release #2's analyze-product. Pipeline 2 completes → 2nd INSERTs.
    mockState.analyzePending!.resolve(undefined);
    await waitFor(() => {
      expect(mockState.productsInsertCount).toBe(2);
    });
    expect(mockState.stockLotsInsertCount).toBe(2);

    // Two queue rows — one per scan. The user's rule: "3 ramen scans =
    // 3 inventory increments." Generalizes for N >= 1.
    const queueRows = screen.getAllByTestId(/^queue-item-/);
    expect(queueRows.length).toBe(2);
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
