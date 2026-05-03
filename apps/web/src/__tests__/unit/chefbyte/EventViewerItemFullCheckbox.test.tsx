/**
 * EventViewerPage — "Item is full" checkbox (manual measured_full_at stamp).
 *
 * Spec (Task 12 of catch-all auto-import plan):
 *   - When a user expands an event with a non-null product_id, the editor
 *     panel shows an "Item is full" checkbox.
 *   - When measured_full_at is null on the product, the checkbox is
 *     unchecked + enabled.
 *   - Clicking the checkbox issues an UPDATE on chefbyte.products that
 *     sets measured_full_at to an ISO timestamp, scoped to the event's
 *     product_id + the current user_id, with a `.is('measured_full_at',
 *     null)` guard so the write is set-once at the client layer too.
 *   - When measured_full_at is already non-null, the checkbox is checked +
 *     disabled (set-once).
 *
 * The mutation patch shape is the load-bearing assertion. Page-level mocks
 * for the rest of the queries (devices, overrides, etc.) are intentionally
 * minimal — the test asserts on what the user sees + what hits Supabase.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EventViewerPage } from '@/pages/chefbyte/EventViewerPage';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user-abc', email: 't@t.com' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock('@/shared/AppProvider', () => ({
  useAppContext: () => ({ online: true, activeApps: ['chefbyte'] }),
}));

vi.mock('@/hooks/useSettingsAlerts', () => ({
  useSettingsAlerts: () => false,
}));

vi.mock('@/shared/useRealtimeInvalidation', () => ({
  useRealtimeInvalidation: () => {},
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});

/* ------------------------------------------------------------------ */
/*  Mutable mock state                                                 */
/* ------------------------------------------------------------------ */

let _eventRows: any[] = [];
let _productRows: any[] = [];
const updateCalls: any[] = [];
const eqCallsForUpdate: Array<[string, any]> = [];
const isCallsForUpdate: Array<[string, any]> = [];

vi.mock('@/shared/supabase', () => {
  /**
   * Builds a chained query object that supports both:
   *   - read selects (returning rows when awaited)
   *   - update chains (recording the patch + the .eq/.is filters)
   */
  const makeBuilder = (
    rowsFn: () => any[],
    onUpdate?: (patch: any, filters: { eqs: typeof eqCallsForUpdate; iss: typeof isCallsForUpdate }) => void,
  ) => {
    let updatePatch: any = null;
    const localEqs: typeof eqCallsForUpdate = [];
    const localIss: typeof isCallsForUpdate = [];
    const b: any = {};
    b.select = vi.fn(() => b);
    b.eq = vi.fn((col: string, val: any) => {
      if (updatePatch !== null) {
        localEqs.push([col, val]);
      }
      return b;
    });
    b.is = vi.fn((col: string, val: any) => {
      if (updatePatch !== null) {
        localIss.push([col, val]);
      }
      return b;
    });
    b.order = vi.fn(() => b);
    b.limit = vi.fn(() => b);
    b.gte = vi.fn(() => b);
    b.update = vi.fn((patch: any) => {
      updatePatch = patch;
      updateCalls.push(patch);
      return b;
    });
    b.then = (resolve: any, reject?: any) => {
      if (updatePatch !== null) {
        // Update path: copy the eq/is calls for this update into the global lists.
        eqCallsForUpdate.push(...localEqs);
        isCallsForUpdate.push(...localIss);
        onUpdate?.(updatePatch, { eqs: localEqs, iss: localIss });
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: rowsFn(), error: null }).then(resolve, reject);
    };
    b.catch = (reject: any) => Promise.resolve({ data: rowsFn(), error: null }).catch(reject);
    return b;
  };

  const chef = () => ({
    from: vi.fn((table: string) => {
      if (table === 'shelf_event_log') return makeBuilder(() => _eventRows);
      if (table === 'products') return makeBuilder(() => _productRows);
      return makeBuilder(() => []);
    }),
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  });

  return {
    chefbyte: chef,
    supabase: { schema: () => ({ rpc: vi.fn(() => Promise.resolve({ data: null, error: null })) }) },
  };
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const PRODUCT_ID = 'prod-empty-1';

function event(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    event_id: 'evt-1',
    client_event_id: 'client-evt-1',
    pi_event_id: null,
    applied: true,
    reason: null,
    created_at: '2026-04-30T10:00:00.000Z',
    classifier_status: null,
    classification: null,
    payload: {
      product_id: PRODUCT_ID,
      event_kind: 'consumed',
      delta_g: -200,
      occurred_at: '2026-04-30T10:00:00.000Z',
    },
    before_image_url: null,
    after_image_url: null,
    ...overrides,
  };
}

function product(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    product_id: PRODUCT_ID,
    name: 'Test Product',
    net_weight_g: 500,
    servings_per_container: 5,
    calories_per_serving: 100,
    carbs_per_serving: 10,
    protein_per_serving: 5,
    fat_per_serving: 2,
    tare_weight_g: 50,
    measured_full_at: null,
    ...overrides,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chef/events']}>
        <EventViewerPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  _eventRows = [];
  _productRows = [];
  updateCalls.length = 0;
  eqCallsForUpdate.length = 0;
  isCallsForUpdate.length = 0;
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('EventViewerPage — Item is full checkbox', () => {
  it("checking the box stamps measured_full_at on the event's product", async () => {
    _eventRows = [event()];
    _productRows = [product({ measured_full_at: null })];

    const u = userEvent.setup();
    renderPage();

    // Wait for the row, then expand it via the Edit button.
    await waitFor(() => {
      expect(screen.queryByTestId('event-row-client-evt-1')).not.toBeNull();
    });

    await u.click(screen.getByTestId('toggle-edit-btn'));

    // Editor panel renders the Item-is-full checkbox; it starts unchecked.
    const checkbox = await screen.findByTestId('event-item-full-checkbox');
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect((checkbox as HTMLInputElement).disabled).toBe(false);

    await u.click(checkbox);

    // The mutation must have called .update({ measured_full_at: <ISO> }) on
    // chefbyte.products. Find the matching update call.
    await waitFor(() => {
      const patch = updateCalls.find((p) => p && Object.prototype.hasOwnProperty.call(p, 'measured_full_at'));
      expect(patch).toBeTruthy();
      expect(patch.measured_full_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    // The update was scoped by product_id and user_id (RLS-friendly).
    const eqCols = eqCallsForUpdate.map(([c]) => c);
    expect(eqCols).toContain('product_id');
    expect(eqCols).toContain('user_id');
    const productEq = eqCallsForUpdate.find(([c]) => c === 'product_id');
    expect(productEq?.[1]).toBe(PRODUCT_ID);

    // Set-once guard at the client layer: .is('measured_full_at', null).
    const isCols = isCallsForUpdate.map(([c]) => c);
    expect(isCols).toContain('measured_full_at');
    const isCall = isCallsForUpdate.find(([c]) => c === 'measured_full_at');
    expect(isCall?.[1]).toBeNull();
  });

  it('renders checked + disabled when measured_full_at is already set', async () => {
    _eventRows = [event()];
    _productRows = [product({ measured_full_at: '2026-04-29T12:00:00.000Z' })];

    const u = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.queryByTestId('event-row-client-evt-1')).not.toBeNull();
    });

    await u.click(screen.getByTestId('toggle-edit-btn'));

    const checkbox = (await screen.findByTestId('event-item-full-checkbox')) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);

    // Clicking a disabled checkbox is a no-op.
    await u.click(checkbox);
    expect(updateCalls.length).toBe(0);
  });

  it('does not render the checkbox when the event has no product_id', async () => {
    _eventRows = [
      event({
        client_event_id: 'client-no-prod-1',
        applied: false,
        classifier_status: 'classifying',
        payload: {
          product_id: null,
          event_kind: 'consumed',
          delta_g: -100,
          occurred_at: '2026-04-30T10:00:00.000Z',
        },
      }),
    ];
    _productRows = [];

    const u = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.queryByTestId('event-row-client-no-prod-1')).not.toBeNull();
    });

    await u.click(screen.getByTestId('toggle-edit-btn'));

    // Edit panel may or may not render (review path), but if it does, no checkbox.
    expect(screen.queryByTestId('event-item-full-checkbox')).toBeNull();
  });
});
