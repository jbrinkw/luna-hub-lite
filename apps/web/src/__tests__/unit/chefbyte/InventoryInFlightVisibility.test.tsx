/**
 * Bug 2026-04-22 regression guard.
 *
 * When the Pi fires an `in_flight_pickup` event for a tracked lot, cloud
 * state ends up with `qty_containers = 0` AND `in_flight_since` NOT NULL
 * (see migration 20260425080000_shelf_event_in_flight_pickup.sql — the
 * companion `consumed` dual-write zeros qty, and the new pickup branch
 * stamps in_flight_since on the same lot).
 *
 * Historically the InventoryPage grouped-by-product filter hid every
 * row whose totalStock was 0. That collapsed "lot was picked up, Pi is
 * still tracking it" to "item vanished from inventory" — the user's
 * bottle disappears from the UI between `remove` and `replace` on the
 * shelf.
 *
 * The fix extends the filter to include any product with at least one
 * in-flight lot (regardless of stock total), and the row renders:
 *   - An amber "In-flight" badge (Lucide Activity icon) so the user
 *     knows WHERE the item is.
 *   - "(picked up)" in place of the numeric "0.0 ctn" stock readout so
 *     it's obvious the qty=0 is by design, not corruption.
 *
 * This test mounts the real InventoryPage against a mocked Supabase
 * transport and proves:
 *   1. A qty=0 in-flight lot → the grouped row is visible, badge is
 *      rendered, stock cell reads "(picked up)".
 *   2. A qty=0 non-in-flight lot (truly empty, no min-stock reminder)
 *      → row is hidden (we did NOT over-extend the filter to tombstones).
 *   3. A qty>0 normal lot → row visible, no badge.
 *   4. In the Lots view: the in-flight qty=0 lot appears, positioned
 *      BEFORE the in-stock lot (in-flight-first sort), and shows the
 *      badge + "(picked up)" text.
 *
 * Fidelity: real InventoryPage, real TanStack Query, real useMemo
 * aggregation. Only the Supabase transport is mocked so we can
 * deterministically seed the three lot states.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const USER_ID = 'user-1';

/* ------------------------------------------------------------------ */
/*  Seed data — three products × three lot states                      */
/* ------------------------------------------------------------------ */

const PRODUCTS = [
  {
    product_id: 'prod-inflight',
    user_id: USER_ID,
    name: 'Chocolate Milk',
    barcode: null,
    servings_per_container: 4,
    min_stock_amount: 0,
    tare_weight_g: 25,
  },
  {
    product_id: 'prod-empty',
    user_id: USER_ID,
    name: 'Empty Orange Juice',
    barcode: null,
    servings_per_container: 4,
    min_stock_amount: 0,
    tare_weight_g: null,
  },
  {
    product_id: 'prod-active',
    user_id: USER_ID,
    name: 'Active Apple Juice',
    barcode: null,
    servings_per_container: 4,
    min_stock_amount: 0,
    tare_weight_g: null,
  },
];

const LOTS = [
  // In-flight, qty=0 — this is the bug scenario. MUST be visible.
  {
    lot_id: 'lot-inflight',
    product_id: 'prod-inflight',
    qty_containers: 0,
    expires_on: '2026-06-01',
    last_update_source: 'live_shelf' as const,
    last_update_ts: '2026-04-22T10:00:00.000Z',
    in_flight_since: '2026-04-22T10:00:00.000Z',
    locations: { name: 'Fridge' },
  },
  // Empty, NOT in-flight — truly gone. MUST NOT appear (no min-stock, not in-flight).
  {
    lot_id: 'lot-empty',
    product_id: 'prod-empty',
    qty_containers: 0,
    expires_on: null,
    last_update_source: 'manual' as const,
    last_update_ts: null,
    in_flight_since: null,
    locations: { name: 'Fridge' },
  },
  // Normal, in stock. MUST appear, no badge.
  {
    lot_id: 'lot-active',
    product_id: 'prod-active',
    qty_containers: 3,
    expires_on: '2026-06-15',
    last_update_source: 'manual' as const,
    last_update_ts: null,
    in_flight_since: null,
    locations: { name: 'Fridge' },
  },
];

/* ------------------------------------------------------------------ */
/*  Supabase stub                                                       */
/* ------------------------------------------------------------------ */

vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const builder: any = {};
    builder.from = vi.fn((table: string) => {
      // Each .from() call builds a chain that eventually resolves to
      // either a dataset or an empty result. We only care about the
      // tables the InventoryPage reads: products, stock_lots,
      // live_shelf_devices, locations.
      const b: any = {};
      const state: { mode: 'select' | 'update' | 'insert' } = { mode: 'select' };
      b.select = vi.fn(() => b);
      b.eq = vi.fn(() => b);
      b.is = vi.fn(() => b);
      b.in = vi.fn(() => b);
      b.not = vi.fn(() => b);
      b.ilike = vi.fn(() => b);
      b.gt = vi.fn(() => b);
      b.lt = vi.fn(() => b);
      b.update = vi.fn(() => {
        state.mode = 'update';
        return b;
      });
      b.insert = vi.fn(() => {
        state.mode = 'insert';
        return b;
      });
      b.limit = vi.fn(() => {
        // locations default-id query — return one row.
        if (table === 'locations') {
          return Promise.resolve({ data: [{ location_id: 'loc-1' }], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      });
      b.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
      b.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
      b.order = vi.fn(() => {
        if (table === 'products' && state.mode === 'select') {
          return Promise.resolve({ data: PRODUCTS, error: null });
        }
        if (table === 'locations' && state.mode === 'select') {
          // The locations query chains .order().limit(1); the thenable at
          // .limit() resolves, but some call paths may await .order().
          return Promise.resolve({ data: [{ location_id: 'loc-1' }], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      });
      // Make the builder thenable so a raw `await chefbyte().from('stock_lots')
      // .select(...).eq(...)` (no trailing .order/.limit) resolves.
      b.then = (resolve: (v: any) => void) => {
        if (table === 'stock_lots' && state.mode === 'select') {
          resolve({ data: LOTS, error: null });
          return;
        }
        if (table === 'products' && state.mode === 'select') {
          resolve({ data: PRODUCTS, error: null });
          return;
        }
        if (table === 'live_shelf_devices' && state.mode === 'select') {
          resolve({ data: [], error: null });
          return;
        }
        resolve({ data: [], error: null });
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

import { InventoryPage } from '@/pages/chefbyte/InventoryPage';

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chef/inventory']}>
        <InventoryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('InventoryPage — in-flight lot visibility (bug 2026-04-22)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows an in-flight qty=0 product with badge + "(picked up)" label in grouped view', async () => {
    renderPage();

    // Wait for the in-flight product row to render. If the filter regresses
    // to `totalStock > 0` alone, this test fails here: the row never shows
    // up because totalStock === 0 for the picked-up lot.
    const row = await screen.findByTestId('inv-product-prod-inflight');
    expect(row).toBeInTheDocument();

    // The amber "In-flight" badge renders on the row's product-name line.
    const badge = screen.getByTestId('inflight-badge');
    expect(badge).toBeInTheDocument();
    // 2026-04-27 lot-pairings refactor renamed the badge label from
    // "In-flight" to "In Flight" to match the new three-badge model
    // (Certified / On Scale / In Flight). Regex matches both spellings
    // for forward-compat with any future re-namings.
    expect(badge).toHaveTextContent(/in[- ]flight/i);
    // 2026-04-27 close-out modal landed: the badge is now an interactive
    // affordance (role=button), so its aria-label includes "click to close
    // out" for screen-reader discoverability. Regex keeps the assertion
    // resilient to future copy tweaks while still pinning the core label.
    expect(badge.getAttribute('aria-label') ?? '').toMatch(/In Flight/i);

    // Stock cell shows "(picked up)" NOT "0.0 ctn". This is the user-
    // facing "why did the qty go to zero" affordance.
    const stockBadge = screen.getByTestId('stock-badge-prod-inflight');
    expect(stockBadge).toHaveTextContent('(picked up)');
    expect(stockBadge).not.toHaveTextContent('0.0 ctn');
  });

  it('does NOT show a qty=0 NOT-in-flight product (tombstoned rows remain hidden)', async () => {
    // Positive guard for the non-goal: we extended the filter to include
    // in-flight lots, but we did NOT include tombstoned zero-qty lots.
    // A regression that flipped the filter to `totalStock > 0 || true` or
    // dropped the zero-qty hide entirely would fail here because the
    // "Empty Orange Juice" row would become visible.
    renderPage();

    // Wait for the page to have rendered data (the active product row is
    // a reliable "data loaded" sentinel).
    await screen.findByTestId('inv-product-prod-active');

    expect(screen.queryByTestId('inv-product-prod-empty')).not.toBeInTheDocument();
  });

  it('shows an in-stock product without the in-flight badge', async () => {
    renderPage();

    const row = await screen.findByTestId('inv-product-prod-active');
    expect(row).toBeInTheDocument();

    // Stock cell shows "3.0 ctn", NOT "(picked up)".
    const stockBadge = screen.getByTestId('stock-badge-prod-active');
    expect(stockBadge).toHaveTextContent('3.0 ctn');
    expect(stockBadge).not.toHaveTextContent('(picked up)');

    // No in-flight badge within this row's subtree. (Badge testid is
    // non-unique — "inflight-badge" matches the picked-up row elsewhere
    // on the page. Scope the query to this row.)
    expect(row.querySelector('[data-testid="inflight-badge"]')).toBeNull();
  });

  it('sorts in-flight products before active products in grouped view', async () => {
    renderPage();

    await screen.findByTestId('inv-product-prod-active');

    // Both rows are children of the grouped-view container; their DOM
    // order reflects the sort order in `filteredGrouped`. In-flight
    // first is the user-facing "what's out RIGHT NOW" priority.
    const inflight = screen.getByTestId('inv-product-prod-inflight');
    const active = screen.getByTestId('inv-product-prod-active');
    // Node.compareDocumentPosition returns a bitmask — 0x04 means "other
    // follows this" — which is true iff inflight comes before active.

    expect(inflight.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the in-flight lot in the Lots view with badge + (picked up) label, before the active lot', async () => {
    renderPage();
    const user = userEvent.setup();

    // Switch to Lots view.
    await screen.findByTestId('inv-product-prod-active');
    const viewToggle = screen.getByTestId('inventory-view-toggle');
    // Click the "Lots" button.
    const lotsButton = within(viewToggle).getByRole('button', { name: /lots/i });
    await user.click(lotsButton);

    // Lots view now renders. Mobile card + desktop table both emit
    // `lot-row-<id>` — jsdom renders BOTH (it doesn't evaluate CSS media
    // queries), so querying by testid may return multiples. Use the
    // getAllBy helper.
    const inflightRows = await screen.findAllByTestId('lot-row-lot-inflight');
    expect(inflightRows.length).toBeGreaterThan(0);

    // In-flight badge on the lot row — also potentially duplicated
    // across mobile/desktop renderings.
    const lotBadges = screen.getAllByTestId('lot-inflight-badge-lot-inflight');
    expect(lotBadges.length).toBeGreaterThan(0);
    expect(lotBadges[0]).toHaveTextContent(/in[- ]flight/i);

    // At least one of the lot rows shows "(picked up)" instead of "0.0".
    // Mobile layout shows "(picked up)" inline; desktop shows it in the
    // qty cell. Either way, the string must be present on the page.
    expect(screen.getAllByText(/\(picked up\)/i).length).toBeGreaterThan(0);

    // Confirm the truly-empty lot is NOT rendered in Lots view either
    // (the sortedLots filter matches the grouped filter's in-flight
    // carve-out).
    expect(screen.queryByTestId('lot-row-lot-empty')).not.toBeInTheDocument();

    // Sort order: in-flight lot appears before the active lot in DOM.
    const activeRows = screen.getAllByTestId('lot-row-lot-active');

    expect(inflightRows[0].compareDocumentPosition(activeRows[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// -----------------------------------------------------------------------
// `within` is re-exported from @testing-library/react; import it late so
// the top of the file stays focused on the mock setup.
// -----------------------------------------------------------------------

import { within } from '@testing-library/react';
