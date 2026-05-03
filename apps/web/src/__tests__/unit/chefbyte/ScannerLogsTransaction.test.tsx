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
 * Failure modes pinned down here:
 *
 *  1. A successful purchase scan must produce an `applied`-status
 *     scan_transactions row with the right barcode + source + user_id +
 *     mode.
 *
 *  2. (Audit 2026-05-03 regression guard) When the purchase scan
 *     MERGES into an existing lot (same product + location +
 *     expires_on), `applied_lot_id` MUST be null. private.void_scan_transaction
 *     unconditionally DELETEs the referenced lot — recording a merge's
 *     lot_id would destroy inventory contributed by other scans /
 *     manual entry / Pi USB. Only fresh-lot scans (wasNewLot=true) get
 *     the lot id recorded.
 *
 *  3. (Audit 2026-05-03 direct call-site coverage — Gap A3) The
 *     ScannerPage has 6 logTransaction call sites and only the
 *     happy-path purchase one was directly covered. Three more sites
 *     are pinned here:
 *       - shopping mode applied scan must surface
 *         `applied_cart_item_id` (the cart row id) so void can DELETE
 *         it. If a refactor ever forgets to thread `recordId` into
 *         the audit payload, a manual void would fail to reverse.
 *       - consume_macros mode must surface `applied_food_log_id` for
 *         the same reason — void's path through private.void_scan_transaction
 *         needs the log row id to reverse the macro entry.
 *       - errored purchase (executeAction returns `error: '...'`)
 *         must still log the audit row with `status: 'errored'` and
 *         carry `error_msg`. Without this assertion an early-return
 *         introduced before the audit insert would silently drop the
 *         observability signal — which is exactly how the original
 *         applied_lot_id bug went undetected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/* ------------------------------------------------------------------ */
/*  Mock state                                                         */
/* ------------------------------------------------------------------ */

const { scanTransactionsInsertMock, invokeMock, existingLotState, stockLotsInsertError } = vi.hoisted(() => ({
  scanTransactionsInsertMock: vi.fn(() => Promise.resolve({ data: null, error: null })),
  invokeMock: vi.fn(() => Promise.resolve({ data: null, error: { message: 'not under test' } })),
  // Mutable holder so individual tests can flip the stock_lots
  // maybeSingle() result between "no existing lot" (insert path) and
  // "existing lot" (merge path). The merge-path test asserts that
  // applied_lot_id stays null in the audit log so void doesn't
  // destroy a multi-scan pile via private.void_scan_transaction's
  // unconditional DELETE.
  existingLotState: { current: null as { lot_id: string; qty_containers: number } | null },
  // Mutable holder for the executeAction-error test: when set, the
  // stock_lots insert path returns a write error so executeAction
  // surfaces `error: 'Stock insert failed: ...'` and the queue row
  // turns red. The audit-log call MUST still fire with
  // status: 'errored' and carry the error_msg — this pins the call
  // site at line ~720 in ScannerPage.tsx (the known-product +
  // executeAction-error branch). Without this guard, an early-return
  // introduced before the audit insert would silently drop the row
  // (same shape of bug as the original applied_lot_id misuse).
  stockLotsInsertError: { current: null as { message: string } | null },
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
      builder.limit = vi.fn(() => {
        // The locations bootstrap query (`.limit(1)` as the terminal
        // call) needs the awaited array shape directly; the consume_macros
        // food_logs query uses `.limit(1).maybeSingle()` so .limit must
        // return the builder for chaining. Differentiate by table to keep
        // both paths working.
        if (table === 'food_logs') return builder;
        return Promise.resolve({ data: [{ location_id: 'loc-1' }], error: null });
      });

      builder.maybeSingle = vi.fn(() => {
        if (table === 'products' && state.filters.barcode != null) {
          return Promise.resolve({
            data: state.filters.barcode === productKnown.barcode ? productKnown : null,
            error: null,
          });
        }
        if (table === 'stock_lots') {
          // Read from the shared holder so each test can opt into
          // either the insert (null) or merge (non-null) branch.
          return Promise.resolve({ data: existingLotState.current, error: null });
        }
        if (table === 'food_logs') {
          // executeAction's consume_macros branch reads the most-
          // recent food_log row to get the log_id for undoInfo.
          // Return a stable id so the test can assert the audit
          // payload's applied_food_log_id matches what executeAction
          // returned via undoInfo.logId.
          return Promise.resolve({ data: { log_id: 'log-1' }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });
      builder.single = vi.fn(() => {
        if (table === 'stock_lots' && state.op === 'insert') {
          // Honor the shared error-injection holder so the
          // executeAction-error test can flip the insert into a
          // failure without affecting other branches' default
          // happy-path behavior.
          if (stockLotsInsertError.current) {
            return Promise.resolve({ data: null, error: stockLotsInsertError.current });
          }
          return Promise.resolve({ data: { lot_id: 'lot-new-1' }, error: null });
        }
        if (table === 'stock_lots' && state.op === 'update') {
          // The merge branch updates qty_containers and returns the
          // pre-existing lot's id. Mirror that shape so executeAction
          // populates undoInfo.recordId correctly even though the test
          // asserts the audit log ignores it.
          return Promise.resolve({
            data: { lot_id: existingLotState.current?.lot_id ?? 'lot-existing-1' },
            error: null,
          });
        }
        if (table === 'shopping_list' && state.op === 'insert') {
          // Mirror the executeAction shopping branch's
          // `.insert(...).select('cart_item_id').single()` shape so
          // undoInfo.recordId carries the cart item id and the audit
          // row's applied_cart_item_id can be asserted.
          return Promise.resolve({ data: { cart_item_id: 'cart-1' }, error: null });
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
  // Default to "no existing lot" — tests opt into the merge branch
  // explicitly by setting `existingLotState.current` to a row.
  existingLotState.current = null;
  // Default to "stock_lots insert succeeds" — tests opt into the
  // executeAction-error branch by setting a non-null message.
  stockLotsInsertError.current = null;
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
    // Tightened from `expect(['applied','errored']).toContain(...)` —
    // a happy-path purchase scan with all writes mocked to succeed
    // MUST land at status='applied'. The looser assertion would have
    // silently passed even if the scan had errored under the hood.
    expect(patch.status).toBe('applied');
    expect(patch.mode).toBe('purchase');
    // Insert path (no existing lot) → fresh lot was minted by the
    // mocked stock_lots.insert → applied_lot_id MUST carry the new
    // lot id so void can clean up.
    expect(patch.applied_lot_id).toBe('lot-new-1');
  });

  it('leaves applied_lot_id null when the purchase MERGES into an existing lot', async () => {
    // Audit 2026-05-03: when (product, location, expires_on) match an
    // existing stock_lot, executeAction UPDATEs (merges) instead of
    // INSERTing. private.void_scan_transaction unconditionally
    // DELETEs the lot referenced by applied_lot_id, so recording the
    // merged lot's id would destroy inventory contributed by other
    // scans / manual entry / Pi USB. The fix: only record
    // applied_lot_id when a fresh lot was minted (wasNewLot=true).
    // Merges leave it null, making void a status-flip-only.
    existingLotState.current = { lot_id: 'lot-existing-1', qty_containers: 2 };

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

    await waitFor(() => {
      expect(scanTransactionsInsertMock).toHaveBeenCalledTimes(1);
    });

    const lastCall = scanTransactionsInsertMock.mock.calls.at(-1) as unknown[] | undefined;
    const patch = (lastCall?.[0] ?? {}) as Record<string, unknown>;
    expect(patch.status).toBe('applied');
    expect(patch.mode).toBe('purchase');
    // The audit row exists — no destructive DELETE target attached.
    expect(patch.applied_lot_id).toBeNull();
  });

  it('records applied_cart_item_id when the scan is logged in shopping mode', async () => {
    // Direct-call-site coverage for the shopping branch of
    // logTransaction (line ~720 in ScannerPage.tsx). The call site
    // threads `result.undoInfo.recordId` (cart_item_id) into
    // `applied_cart_item_id` ONLY for shopping mode — every other
    // mode leaves it null. Without this assertion, a refactor that
    // accidentally drops the mode check would silently route
    // stock_lot ids into the cart_item field, breaking
    // private.void_scan_transaction's reverse path.
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ScannerPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Switch to shopping mode BEFORE the barcode submit so
    // handleBarcodeSubmit closes over `mode === 'shopping'`.
    await user.click(await screen.findByTestId('mode-shopping'));

    const input = await screen.findByTestId('barcode-input');
    await user.clear(input);
    await user.type(input, productKnown.barcode);
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(scanTransactionsInsertMock).toHaveBeenCalledTimes(1);
    });
    const lastCall = scanTransactionsInsertMock.mock.calls.at(-1) as unknown[] | undefined;
    const patch = (lastCall?.[0] ?? {}) as Record<string, unknown>;
    expect(patch.status).toBe('applied');
    expect(patch.mode).toBe('shopping');
    expect(patch.barcode).toBe(productKnown.barcode);
    // executeAction's shopping branch INSERTs into shopping_list and
    // returns `recordId: cart_item_id`. The audit payload must
    // surface it as `applied_cart_item_id` so void can DELETE the
    // cart row. The other applied_* IDs MUST stay null in this mode
    // so the reverse path doesn't double-delete unrelated rows.
    expect(patch.applied_cart_item_id).toBe('cart-1');
    expect(patch.applied_lot_id).toBeNull();
    expect(patch.applied_food_log_id).toBeNull();
  });

  it('records applied_food_log_id when the scan is logged in consume_macros mode', async () => {
    // Direct-call-site coverage for the consume_macros branch of
    // logTransaction (line ~720 in ScannerPage.tsx). Mirrors the
    // shopping test above — only applied_food_log_id should be set,
    // and only because executeAction's consume_macros branch reads
    // the most-recent food_logs row and returns its log_id via
    // undoInfo.logId.
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ScannerPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await user.click(await screen.findByTestId('mode-consume_macros'));

    const input = await screen.findByTestId('barcode-input');
    await user.clear(input);
    await user.type(input, productKnown.barcode);
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(scanTransactionsInsertMock).toHaveBeenCalledTimes(1);
    });
    const lastCall = scanTransactionsInsertMock.mock.calls.at(-1) as unknown[] | undefined;
    const patch = (lastCall?.[0] ?? {}) as Record<string, unknown>;
    expect(patch.status).toBe('applied');
    expect(patch.mode).toBe('consume_macros');
    // The food_logs maybeSingle stub returns log_id 'log-1', which
    // executeAction surfaces via undoInfo.logId. The call site only
    // threads it into applied_food_log_id when mode is consume_macros
    // — pinning that here so a future refactor that accidentally
    // gates on `mode === 'consume_no_macros'` instead won't slip
    // through.
    expect(patch.applied_food_log_id).toBe('log-1');
    expect(patch.applied_lot_id).toBeNull();
    expect(patch.applied_cart_item_id).toBeNull();
  });

  it('logs status=errored with error_msg when executeAction returns a write error', async () => {
    // Direct-call-site coverage for the executeAction-error branch:
    // logTransaction MUST still fire even though the user-visible
    // queue row turns red. The call site at line ~720 expresses this
    // as `status: result.error ? 'errored' : 'applied'` + `errorMsg:
    // result.error ?? null` — pin the active assertion so an early
    // return (e.g. `if (result.error) return;` introduced before the
    // logTransaction call) is caught immediately. That regression
    // would silently kill the audit signal, and is exactly the
    // shape of bug that let the applied_lot_id misuse ride to prod.
    stockLotsInsertError.current = { message: 'duplicate key violates unique constraint' };

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

    await waitFor(() => {
      expect(scanTransactionsInsertMock).toHaveBeenCalledTimes(1);
    });
    const lastCall = scanTransactionsInsertMock.mock.calls.at(-1) as unknown[] | undefined;
    const patch = (lastCall?.[0] ?? {}) as Record<string, unknown>;
    expect(patch.status).toBe('errored');
    expect(patch.mode).toBe('purchase');
    expect(patch.barcode).toBe(productKnown.barcode);
    // Failed insert → no lot_id minted → applied_lot_id MUST be null
    // so void doesn't try to DELETE a non-existent row.
    expect(patch.applied_lot_id).toBeNull();
    // The error message MUST round-trip into error_msg so
    // Settings → Scanner Transactions can render the failure
    // reason. A regression that drops `errorMsg: result.error` (or
    // forwards `result.error?.message` thinking it's an Error
    // instance) would surface here as null/undefined.
    expect(patch.error_msg).toContain('duplicate key');
  });
});
