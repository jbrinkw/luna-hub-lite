/**
 * Unit tests for the In-Flight badge → close-out modal flow on the
 * Inventory page.
 *
 * Coverage:
 *   1. Clicking the In-Flight badge opens the modal scoped to the lot.
 *   2. Each of the three resolution buttons (discarded / consumed /
 *      returned) calls supabase.rpc('close_in_flight_lot', ...) with
 *      the right p_resolution argument.
 *   3. The note textarea content is forwarded as p_note.
 *   4. On RPC error, the modal stays open with the error message rendered.
 *   5. Cancel button dismisses the modal without firing the RPC.
 *   6. Standalone CloseInFlightModal smoke render — exercises the
 *      component in isolation so a regression in its own JSX is caught
 *      independently of the InventoryPage wiring.
 *
 * Approach:
 *   - InventoryPage is rendered with the same mocked Supabase transport
 *     used by the existing InventoryBadges + InventoryInFlightVisibility
 *     suites, so we don't drift from established patterns.
 *   - The supabase rpc mock is captured per-test so we can assert on
 *     call-arguments and force errors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const USER_ID = 'user-1';

// One in-flight lot + one normal lot to verify only the in-flight one
// surfaces a clickable badge.
const PRODUCTS = [
  {
    product_id: 'prod-flying',
    user_id: USER_ID,
    name: 'Flying Chocolate Milk',
    barcode: null,
    servings_per_container: 4,
    min_stock_amount: 0,
    tare_weight_g: null,
    certified: false,
  },
];

const LOTS = [
  {
    lot_id: 'lot-flying',
    product_id: 'prod-flying',
    qty_containers: 1,
    expires_on: '2026-06-01',
    last_update_source: 'live_shelf' as const,
    last_update_ts: '2026-04-27T10:00:00.000Z',
    in_flight_since: '2026-04-27T10:30:00.000Z',
    locations: { name: 'Counter' },
  },
];

const PAIRINGS: Array<{ product_id: string; lot_id: string | null; kind: string }> = [];

// Capture the rpc spy so each test can read its calls (and override
// behaviour with mockImplementation).
const rpcSpy = vi.fn();

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
    builder.rpc = rpcSpy;
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
import { CloseInFlightModal } from '@/components/chefbyte/CloseInFlightModal';

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

describe('CloseInFlightModal — badge → modal flow', () => {
  beforeEach(() => {
    rpcSpy.mockReset();
    rpcSpy.mockResolvedValue({ data: null, error: null });
  });

  it('clicking the In-Flight badge opens the modal scoped to the lot', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('inv-product-prod-flying');

    // Modal not yet visible
    expect(screen.queryByTestId('close-in-flight-modal')).toBeNull();

    // Click the per-product badge in the grouped view
    await user.click(screen.getByTestId('inflight-badge'));

    const modal = await screen.findByTestId('close-in-flight-modal');
    expect(modal).toBeInTheDocument();
    expect(within(modal).getByText(/Close out in-flight lot/i)).toBeInTheDocument();
    // Subtitle reflects the pickup timestamp
    expect(within(modal).getByTestId('close-modal-subtitle').textContent).toMatch(/picked up at/i);
  });

  it('Mark as discarded fires RPC with p_resolution="discarded"', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('inv-product-prod-flying');
    await user.click(screen.getByTestId('inflight-badge'));
    await screen.findByTestId('close-in-flight-modal');

    await user.click(screen.getByTestId('close-modal-discarded'));

    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(rpcSpy).toHaveBeenCalledWith('close_in_flight_lot', {
      p_lot_id: 'lot-flying',
      p_resolution: 'discarded',
      p_note: null,
    });
  });

  it('Mark as consumed fires RPC with p_resolution="consumed"', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('inv-product-prod-flying');
    await user.click(screen.getByTestId('inflight-badge'));
    await screen.findByTestId('close-in-flight-modal');

    await user.click(screen.getByTestId('close-modal-consumed'));

    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(rpcSpy).toHaveBeenCalledWith(
      'close_in_flight_lot',
      expect.objectContaining({ p_resolution: 'consumed', p_lot_id: 'lot-flying' }),
    );
  });

  it('Mark as returned fires RPC with p_resolution="returned"', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('inv-product-prod-flying');
    await user.click(screen.getByTestId('inflight-badge'));
    await screen.findByTestId('close-in-flight-modal');

    await user.click(screen.getByTestId('close-modal-returned'));

    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(rpcSpy).toHaveBeenCalledWith(
      'close_in_flight_lot',
      expect.objectContaining({ p_resolution: 'returned', p_lot_id: 'lot-flying' }),
    );
  });

  it('forwards the note textarea content as p_note', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('inv-product-prod-flying');
    await user.click(screen.getByTestId('inflight-badge'));
    await screen.findByTestId('close-in-flight-modal');

    await user.type(screen.getByTestId('close-modal-note'), 'spilled in fridge');
    await user.click(screen.getByTestId('close-modal-discarded'));

    expect(rpcSpy).toHaveBeenCalledWith(
      'close_in_flight_lot',
      expect.objectContaining({ p_note: 'spilled in fridge' }),
    );
  });

  it('on RPC error: modal stays open and error message is rendered', async () => {
    rpcSpy.mockResolvedValueOnce({ data: null, error: { message: 'lot is not in-flight' } });
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('inv-product-prod-flying');
    await user.click(screen.getByTestId('inflight-badge'));
    await screen.findByTestId('close-in-flight-modal');

    await user.click(screen.getByTestId('close-modal-discarded'));

    // Modal still mounted
    expect(screen.getByTestId('close-in-flight-modal')).toBeInTheDocument();
    // Error callout rendered with the server message
    const callout = await screen.findByTestId('close-modal-error');
    expect(callout.textContent).toMatch(/lot is not in-flight/i);
  });

  it('Cancel button dismisses the modal WITHOUT calling the RPC', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('inv-product-prod-flying');
    await user.click(screen.getByTestId('inflight-badge'));
    await screen.findByTestId('close-in-flight-modal');

    await user.click(screen.getByTestId('close-modal-cancel'));

    expect(rpcSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('close-in-flight-modal')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Standalone modal — smoke / direct prop wiring                      */
/* ------------------------------------------------------------------ */

describe('CloseInFlightModal — direct prop wiring', () => {
  it('does not render when isOpen is false', () => {
    const onResolve = vi.fn();
    render(
      <CloseInFlightModal
        isOpen={false}
        lotId="lot-x"
        productName="Test Product"
        pickupTs="2026-04-27T10:00:00Z"
        onClose={() => {}}
        onResolve={onResolve}
      />,
    );
    expect(screen.queryByTestId('close-in-flight-modal')).toBeNull();
  });

  it('renders product name in the title and pickup time in subtitle', () => {
    render(
      <CloseInFlightModal
        isOpen={true}
        lotId="lot-x"
        productName="Funky Mango Juice"
        pickupTs="2026-04-27T10:00:00Z"
        onClose={() => {}}
        onResolve={vi.fn()}
      />,
    );
    expect(screen.getByText(/Funky Mango Juice/)).toBeInTheDocument();
    expect(screen.getByTestId('close-modal-subtitle').textContent).toMatch(/picked up at/i);
  });

  it('renders fallback subtitle when pickupTs is null', () => {
    render(
      <CloseInFlightModal
        isOpen={true}
        lotId="lot-x"
        productName="Test Product"
        pickupTs={null}
        onClose={() => {}}
        onResolve={vi.fn()}
      />,
    );
    expect(screen.getByTestId('close-modal-subtitle').textContent).toMatch(/Choose how to resolve/i);
    expect(screen.getByTestId('close-modal-subtitle').textContent).not.toMatch(/picked up at/i);
  });
});
