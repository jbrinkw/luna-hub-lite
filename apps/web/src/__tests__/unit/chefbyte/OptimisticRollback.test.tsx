/**
 * Audit recommendation #15 (MEDIUM).
 *
 * Optimistic-update rollback regression guard.
 *
 * Several ChefByte pages apply optimistic updates via TanStack Query's
 * `onMutate → onError` pattern. If the mutation throws after the
 * optimistic state is written, `onError` restores `context.previous`
 * and the UI rolls back to the pre-mutation server state. A bug in the
 * rollback branch (missing `queryClient.setQueryData` call, returning
 * a stale snapshot, forgetting to cancel outbound queries) would ship
 * as ghost rows that never disappear — the checkbox stays green, the
 * item stays in the purchased section, but the DB says otherwise.
 *
 * We pick the ShoppingPage `toggleMutation` because:
 *   - The optimistic state is directly observable as a checked/unchecked
 *     checkbox + the item moving between the "To Buy" and "Purchased"
 *     sections, so we don't need to inspect TanStack Query internals.
 *   - It is a pure client-side mutation (no RPC roundtrip), so the only
 *     thing between an optimistic write and a rollback is the two
 *     TanStack callbacks we care about.
 *
 * Fidelity:
 *   - Real `ShoppingPage` component, real TanStack Query client, real
 *     `useMutation`, real `useQuery`, real `onMutate`/`onError`.
 *   - ONLY the Supabase transport layer is mocked: `select` resolves
 *     normally with a single unpurchased item; `update` rejects. No
 *     stub of the mutation under test.
 *   - Realtime invalidation hook is neutralized (we don't need a WS for
 *     this test — rollback is purely client state).
 *
 * Assertions (in order):
 *   1. Initial render: checkbox unchecked, item in "To Buy" section.
 *   2. User clicks checkbox — `onMutate` applies the optimistic patch,
 *      the mutation promise rejects, `onError` restores `previous`.
 *   3. After the rejection settles, the UI is back to the PRE-mutation
 *      state: checkbox unchecked, item in "To Buy", purchased empty.
 *
 * Intermediate-state visibility: we also hook into the mutation cycle
 * via a spy on `QueryClient.setQueryData` to prove the optimistic write
 * actually happened (it flipped the row to `purchased: true`) before
 * the rollback write restored the original snapshot. This catches a
 * broken `onMutate` that silently swallows the optimistic update — if
 * the only `setQueryData` observed is the one in `onError`, the
 * "optimistic" behavior is missing and the test fails.
 *
 * If `onError` regresses (e.g., someone deletes the
 * `queryClient.setQueryData(key, context?.previous)` line), the final
 * UI assertions fail because the checkbox stays checked.
 * If `onMutate` regresses, the setQueryData spy assertion fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* ------------------------------------------------------------------ */
/*  In-memory "server" state                                           */
/* ------------------------------------------------------------------ */

const CART_ID = 'cart-item-1';
const USER_ID = 'user-1';
const PRODUCT_ID = 'product-1';

const shoppingListRow = {
  cart_item_id: CART_ID,
  user_id: USER_ID,
  product_id: PRODUCT_ID,
  qty_containers: 2,
  purchased: false,
  created_at: '2026-01-01T00:00:00Z',
  products: {
    name: 'Test Bananas',
    barcode: null,
    price: null,
    walmart_link: null,
    is_placeholder: false,
  },
};

// When true, update() rejects. Drives the "mutation fails" path.
let updateShouldReject = false;

/* ------------------------------------------------------------------ */
/*  Supabase stub — .select() resolves normally; .update() rejects     */
/*  when flag is set. No stub of the mutation logic itself.            */
/* ------------------------------------------------------------------ */

vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const builder: any = {};
    builder.from = vi.fn((table: string) => {
      const b: any = {};
      const state: {
        mode: 'select' | 'update' | 'delete' | 'insert';
        patch: Record<string, unknown> | null;
      } = { mode: 'select', patch: null };

      b.select = vi.fn(() => b);
      b.eq = vi.fn(() => b);
      b.in = vi.fn(() => b);
      b.is = vi.fn(() => b);
      b.not = vi.fn(() => b);
      b.ilike = vi.fn(() => b);
      b.gt = vi.fn(() => b);
      b.order = vi.fn(() => {
        if (table === 'shopping_list' && state.mode === 'select') {
          return Promise.resolve({ data: [shoppingListRow], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      });
      b.limit = vi.fn(() => Promise.resolve({ data: [], error: null }));
      b.upsert = vi.fn(() => Promise.resolve({ data: null, error: null }));
      b.insert = vi.fn(() => {
        state.mode = 'insert';
        return b;
      });
      b.update = vi.fn((patch: Record<string, unknown>) => {
        state.mode = 'update';
        state.patch = patch;
        return b;
      });
      b.delete = vi.fn(() => {
        state.mode = 'delete';
        return b;
      });
      b.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
      // Make the builder thenable so `await chefbyte().from(..).update(..).eq(..)`
      // resolves to the `{ error }` shape the page expects.
      b.then = (resolve: (v: any) => void) => {
        if (table === 'shopping_list' && state.mode === 'update') {
          if (updateShouldReject) {
            resolve({ error: { message: 'simulated network failure' } });
          } else {
            // Mutate the server row on a successful update so a
            // post-`onSettled` invalidation doesn't reset the state.
            shoppingListRow.purchased =
              (state.patch?.purchased as boolean | undefined) ?? shoppingListRow.purchased;
            resolve({ error: null });
          }
          return;
        }
        resolve({ error: null });
      };
      return b;
    });
    builder.rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    return builder;
  };
  return {
    supabase: {
      channel: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn((cb?: (status: string) => void) => {
          // Resolve asynchronously so the hook's Promise handlers run.
          setTimeout(() => cb?.('SUBSCRIBED'), 0);
          return { unsubscribe: vi.fn() };
        }),
        unsubscribe: vi.fn(),
      })),
      removeChannel: vi.fn(),
      realtime: {
        stateChangeCallbacks: { close: [] },
        connect: vi.fn(),
      },
      functions: { invoke: vi.fn(() => Promise.resolve({ data: null, error: null })) },
    },
    chefbyte,
    coachbyte: vi.fn(),
    escapeIlike: (s: string) => s,
  };
});

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: USER_ID, email: 'test@test.com' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock('@/shared/useRealtimeInvalidation', () => ({
  useRealtimeInvalidation: vi.fn(),
}));

vi.mock('@/hooks/useSettingsAlerts', () => ({
  useSettingsAlerts: () => false,
}));

import { ShoppingPage } from '@/pages/chefbyte/ShoppingPage';

function renderShopping(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/chef/shopping']}>
        <ShoppingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ShoppingPage optimistic rollback on toggle-purchased', () => {
  beforeEach(() => {
    shoppingListRow.purchased = false;
    updateShouldReject = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rolls back the checkbox + section move when the mutation rejects', async () => {
    updateShouldReject = true;

    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
        mutations: { retry: false },
      },
    });

    // Observe every write to the shopping-list cache entry via the
    // QueryCache subscription. Each mutation of a query's data fires an
    // event on the cache; we capture the `purchased` value of the row
    // after each write. A correct optimistic round-trip produces at
    // least one write with purchased=true (the optimistic patch) and a
    // subsequent write with purchased=false (the rollback).
    type ListRow = { cart_item_id: string; purchased: boolean };
    const purchasedSequence: boolean[] = [];
    const unsubscribe = qc.getQueryCache().subscribe((event) => {
      const key = event.query.queryKey as unknown[];
      if (!Array.isArray(key) || key[0] !== 'shopping-list') return;
      const data = event.query.state.data as ListRow[] | undefined;
      if (!data || !data.length) return;
      const row = data.find((r) => r.cart_item_id === CART_ID);
      if (!row) return;
      // Only record distinct transitions so an n-query-refetch storm
      // doesn't explode the sequence.
      if (
        purchasedSequence.length === 0 ||
        purchasedSequence[purchasedSequence.length - 1] !== row.purchased
      ) {
        purchasedSequence.push(row.purchased);
      }
    });

    const user = userEvent.setup();
    renderShopping(qc);

    // 1. Wait for the item to render in the "To Buy" section, unchecked.
    const checkbox = (await screen.findByTestId(`check-${CART_ID}`)) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    const toBuySection = screen.getByTestId('to-buy-section');
    const purchasedSection = screen.getByTestId('purchased-section');
    expect(toBuySection).toHaveTextContent('Test Bananas');
    expect(purchasedSection.textContent ?? '').toContain('No purchased items');

    // Reset observed sequence so we only record post-click writes.
    purchasedSequence.length = 0;

    // 2. Click checkbox — fires the mutation cycle (onMutate + onError).
    await user.click(checkbox);

    // 3. Let every queued microtask + the rejected update promise + the
    //    onSettled invalidation settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    // 4. Final UI: rolled back to unchecked / in To Buy.
    await waitFor(() => {
      const rolledBack = screen.getByTestId(`check-${CART_ID}`) as HTMLInputElement;
      expect(rolledBack.checked).toBe(false);
    });
    expect(screen.getByTestId('to-buy-section')).toHaveTextContent('Test Bananas');
    expect(screen.getByTestId('purchased-section').textContent ?? '').toContain('No purchased items');

    // 5. Cache subscription: prove the optimistic write actually fired.
    //    Expected sequence: [true, false] — onMutate wrote purchased=true
    //    (optimistic), then onError restored purchased=false (rollback).
    //    A regression in onMutate produces []; a regression in onError
    //    produces [true] (stuck on the optimistic state).
    unsubscribe();
    expect(
      purchasedSequence.includes(true),
      `Expected at least one optimistic write with purchased=true. Got sequence: ${JSON.stringify(purchasedSequence)}`,
    ).toBe(true);
    expect(
      purchasedSequence[purchasedSequence.length - 1],
      `Expected final cache state purchased=false (rollback). Got sequence: ${JSON.stringify(purchasedSequence)}`,
    ).toBe(false);

    // 6. Server state was never actually updated.
    expect(shoppingListRow.purchased).toBe(false);
  });

  it('does NOT roll back when the mutation succeeds (success-path guard)', async () => {
    // Control test: if this ever starts "rolling back" on success, the
    // rollback test above loses meaning because it would pass even with
    // broken code that rolls back unconditionally.
    updateShouldReject = false;

    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
        mutations: { retry: false },
      },
    });
    const user = userEvent.setup();
    renderShopping(qc);

    const checkbox = (await screen.findByTestId(`check-${CART_ID}`)) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    await user.click(checkbox);

    // Let the success path run (onMutate → update() resolves ok → onSettled
    // invalidates → refetch returns the updated row).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    await waitFor(() => {
      const after = screen.getByTestId(`check-${CART_ID}`) as HTMLInputElement;
      expect(after.checked).toBe(true);
    });
    // Row now in purchased section.
    expect(screen.getByTestId('purchased-section')).toHaveTextContent('Test Bananas');
  });
});
