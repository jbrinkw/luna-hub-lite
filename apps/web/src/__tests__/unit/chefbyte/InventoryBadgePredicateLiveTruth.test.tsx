/**
 * Inventory live-scale badge predicate — keys off LIVE truth, not historical tags.
 *
 * Bug history (2026-04-27, commit 0e7866a):
 *   `pickLatestAutomatedSource` (and the per-row `shouldShowLotSourcePill`
 *   sibling) used to key the "live scale" pill purely off
 *   `stock_lots.last_update_source = 'live_scale'`. That field is a
 *   permanent historical tag — once any live_scale event ever touched a
 *   lot, it stayed on the row forever. After the user removed the
 *   pairing, the badge stayed lit indefinitely (chicken on 4-22 still
 *   showing the pill on 4-27). The fix gates the badge on BOTH the
 *   historical tag AND a current `scale_pairings WHERE kind='live_scale'`
 *   row for the product (the LIVE truth-source).
 *
 * What this test pins:
 *   InventoryPage RENDERS the per-product source pill driven by
 *   `pickLatestAutomatedSource`. We seed exactly the bug shape — a lot
 *   with `last_update_source='live_scale'` AND no matching scale_pairings
 *   row — and assert the live-scale pill does NOT appear on that row.
 *   We complement with the inverse positive control (same lot tag PLUS a
 *   pairing) so a mutation that broke BOTH branches in opposite
 *   directions wouldn't pass by symmetry.
 *
 * Mutation guard (mutation discipline):
 *   Reverting `pickLatestAutomatedSource` to drop the
 *     `if (l.last_update_source === 'live_scale' && !liveScalePaired) continue;`
 *   line in apps/web/src/pages/chefbyte/InventoryPage.tsx (~line 280)
 *   makes the stale-tag case once again surface the badge → the
 *   negative assertion fails with `expect(...).not.toBeInTheDocument()
 *   received: ⚖ live scale`.
 *
 * Why this file is separate from `InventoryBadges.test.tsx`:
 *   That suite exercises the THREE-badge model (Certified / On Scale /
 *   In Flight) that derives from `scale_pairings.lot_id` directly. The
 *   live-scale SOURCE pill is a distinct UI element (rendered in the
 *   per-product header) that derives from `last_update_source` filtered
 *   by the paired set. Conflating the two test suites obscures the
 *   bug being guarded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const USER_ID = 'user-livetruth';

// --- Test fixtures -----------------------------------------------------
//
// Two lots, two products. Both lots carry the historical
// `last_update_source='live_scale'` tag. The fixture diverges only in
// the `scale_pairings` set:
//
//   prod-stale-tag  → tag='live_scale' BUT no pairing  → badge MUST hide
//   prod-still-paired → tag='live_scale' AND pairing  → badge MUST show
//
// Mutation that drops the gate would surface the badge on
// `prod-stale-tag` — first assertion fails.
// Mutation that broadened the gate (e.g. always hide live_scale) would
// drop the badge on `prod-still-paired` — second assertion fails.

const PRODUCTS = [
  {
    product_id: 'prod-stale-tag',
    user_id: USER_ID,
    name: 'Stale Live-Scale Tag (no pairing)',
    barcode: null,
    servings_per_container: 4,
    min_stock_amount: 0,
    tare_weight_g: 25,
    certified: true,
  },
  {
    product_id: 'prod-still-paired',
    user_id: USER_ID,
    name: 'Active Live-Scale (paired)',
    barcode: null,
    servings_per_container: 4,
    min_stock_amount: 0,
    tare_weight_g: 25,
    certified: true,
  },
];

const LOTS = [
  {
    lot_id: 'lot-stale-tag',
    product_id: 'prod-stale-tag',
    qty_containers: 1,
    expires_on: '2026-08-01',
    last_update_source: 'live_scale' as const,
    last_update_ts: '2026-04-22T14:39:00.000Z', // ancient — pairing torn down since
    in_flight_since: null,
    locations: { name: 'Counter' },
  },
  {
    lot_id: 'lot-still-paired',
    product_id: 'prod-still-paired',
    qty_containers: 1,
    expires_on: '2026-08-01',
    last_update_source: 'live_scale' as const,
    last_update_ts: '2026-04-27T20:00:00.000Z',
    in_flight_since: null,
    locations: { name: 'Counter' },
  },
];

// scale_pairings — only the SECOND product has a current row. The first
// is the bug shape (tag survives but pairing was torn down).
const PAIRINGS = [
  {
    pairing_id: 'pair-still-paired',
    product_id: 'prod-still-paired',
    lot_id: 'lot-still-paired',
    kind: 'live_scale' as const,
  },
];

// --- Supabase mock -----------------------------------------------------

vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const builder: any = {};
    builder.from = vi.fn((table: string) => {
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
          return Promise.resolve({ data: [{ location_id: 'loc-1' }], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      });
      // Thenable so `await ...from(...).select(...).eq(...)` works.
      b.then = (resolve: (v: any) => void) => {
        if (table === 'stock_lots' && state.mode === 'select') {
          resolve({ data: LOTS, error: null });
          return;
        }
        if (table === 'products' && state.mode === 'select') {
          resolve({ data: PRODUCTS, error: null });
          return;
        }
        if (table === 'scale_pairings' && state.mode === 'select') {
          resolve({ data: PAIRINGS, error: null });
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

describe('InventoryPage — live-scale badge keys off LIVE scale_pairings, not the historical lot tag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT render the "live scale" pill on a product whose lot tag is "live_scale" but has no current scale_pairings row', async () => {
    // The bug: a 5-day-old historical tag from a torn-down pairing kept
    // the badge lit forever. The fix gates `live_scale` pill rendering
    // on the product being present in the live-scale paired set
    // (`scale_pairings WHERE kind='live_scale'`). With no pairing row,
    // the pill MUST hide.
    renderPage();

    const staleHeader = await screen.findByText(/Stale Live-Scale Tag/i);
    expect(staleHeader).toBeInTheDocument();

    // The product header / row for the stale-tag product MUST NOT show
    // any "live scale" pill. We grep the entire rendered tree for the
    // text — the pill text in InventoryPage is the literal string
    // `live scale` (the SOURCE_LABELS map). On the negative-control
    // product (`prod-stale-tag`) it must not appear, even though
    // `last_update_source` says it did once.
    //
    // To make the assertion specific, we scope to the row containing
    // the stale product's name. If the predicate is reverted, the pill
    // text will appear next to the product name and the
    // `queryByText` will return a node — failing.
    const staleRow = staleHeader.closest('div');
    expect(staleRow).not.toBeNull();

    // We use a regex anchored on the SOURCE_LABELS literal to avoid
    // false negatives from nearby strings (e.g. headings).
    const pillsInStaleRow = staleRow!.querySelectorAll('[data-testid], [class*="badge"], [class*="pill"], span');
    let foundLiveScalePill = false;
    pillsInStaleRow.forEach((node) => {
      if (/^\s*live scale\s*$/i.test(node.textContent || '')) {
        foundLiveScalePill = true;
      }
    });
    expect(
      foundLiveScalePill,
      [
        'BUG REGRESSION: the "live scale" pill rendered on a product with',
        'last_update_source=live_scale BUT no scale_pairings row — exactly',
        'the stale-tag bug pickLatestAutomatedSource is supposed to suppress.',
        'Check apps/web/src/pages/chefbyte/InventoryPage.tsx ~line 280 for the',
        "`if (l.last_update_source === 'live_scale' && !liveScalePaired) continue;`",
        'guard.',
      ].join(' '),
    ).toBe(false);
  });

  it('DOES render the "live scale" pill on a product whose lot tag is "live_scale" AND has a current scale_pairings row (positive control)', async () => {
    // Symmetry guard: a mutation that broadened the suppression to ALL
    // live_scale tags (not just unpaired ones) would still pass the
    // negative test above. This positive control catches that direction
    // — a paired product MUST keep its pill.
    renderPage();

    const liveHeader = await screen.findByText(/Active Live-Scale/i);
    const liveRow = liveHeader.closest('div');
    expect(liveRow).not.toBeNull();

    // Walk all spans in the row and look for the literal pill text.
    const allSpans = liveRow!.querySelectorAll('span');
    let foundLiveScalePill = false;
    allSpans.forEach((node) => {
      if (/^\s*live scale\s*$/i.test(node.textContent || '')) {
        foundLiveScalePill = true;
      }
    });
    expect(
      foundLiveScalePill,
      [
        'BUG REGRESSION (opposite direction): the "live scale" pill must',
        'render on a product that IS currently in scale_pairings for kind=',
        "'live_scale'. If you broke this, the gate became too aggressive",
        'and is suppressing legitimate badges.',
      ].join(' '),
    ).toBe(true);
  });
});
