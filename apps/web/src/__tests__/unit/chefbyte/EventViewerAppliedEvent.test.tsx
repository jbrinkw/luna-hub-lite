/**
 * EventViewerPage — applied event rendering (regression for filter bug).
 *
 * Previously a filter `!!payload.product_id || !!classifier_status` caused
 * normal applied events with null classifier_status to be silently dropped,
 * resulting in an empty list. This test asserts that an applied event with
 * a product_id in payload renders correctly in the event list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

// Mutable state so each test can configure event rows.
let _eventRows: any[] = [];

vi.mock('@/shared/supabase', () => {
  const makeTableBuilder = (rows: () => any[]) => {
    const b: any = {};
    b.select = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.order = vi.fn(() => b);
    b.limit = vi.fn(() => b);
    b.gte = vi.fn(() => b);
    b.then = (resolve: any, reject?: any) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
    b.catch = (reject: any) => Promise.resolve({ data: rows(), error: null }).catch(reject);
    return b;
  };

  const chef = () => ({
    from: vi.fn((table: string) => {
      if (table === 'shelf_event_log') return makeTableBuilder(() => _eventRows);
      return makeTableBuilder(() => []);
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

function appliedEvent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    event_id: 'evt-applied-1',
    client_event_id: 'client-applied-1',
    pi_event_id: null,
    applied: true,
    reason: null,
    created_at: '2026-04-30T10:00:00.000Z',
    classifier_status: null,
    classification: null,
    payload: {
      product_id: 'prod-abc',
      event_kind: 'consumed',
      delta_g: -200,
      occurred_at: '2026-04-30T10:00:00.000Z',
    },
    before_image_url: null,
    after_image_url: null,
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
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('EventViewerPage — applied event visibility', () => {
  it('renders an applied event with product_id in payload (was silently dropped by old filter)', async () => {
    _eventRows = [appliedEvent()];

    renderPage();

    // Wait for the event row to appear in the DOM
    await waitFor(() => {
      expect(screen.queryByTestId('event-row-client-applied-1')).not.toBeNull();
    });

    // event-list wrapper exists and no-events placeholder is gone
    expect(screen.getByTestId('event-list')).toBeTruthy();
    expect(screen.queryByTestId('no-events')).toBeNull();
  });

  it('shows empty state when there are genuinely no events', async () => {
    _eventRows = [];

    renderPage();

    await waitFor(() => {
      expect(screen.queryByTestId('no-events')).not.toBeNull();
    });

    expect(screen.queryByTestId('event-list')).toBeNull();
  });

  it('renders event with null product_id in payload (Pi event awaiting classification)', async () => {
    _eventRows = [
      appliedEvent({
        client_event_id: 'client-null-prod-1',
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

    renderPage();

    await waitFor(() => {
      expect(screen.queryByTestId('event-row-client-null-prod-1')).not.toBeNull();
    });

    expect(screen.queryByTestId('no-events')).toBeNull();
  });
});
