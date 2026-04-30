/**
 * EventViewerPage — default range filter shows all events.
 *
 * Regression for bug 2026-04-30: page defaulted to range='week', silently
 * hiding every event older than 7 days. The ChefLayout tab badge counts
 * shelf_event_log rows with NO range filter, so when only old events
 * existed (e.g. user came back after a week away from the Pi), the badge
 * advertised hundreds of events and the page rendered "no events".
 *
 * Fix: default range to 'all' so what users click matches what they see.
 *
 * The test mocks Supabase such that `.gte('created_at', cutoff)` actually
 * filters the returned rows by the cutoff — that way we can prove the
 * default range produces no cutoff (i.e., all rows pass through). The
 * other EventViewer tests don't honor `.gte`, so they couldn't catch this.
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

/**
 * Mutable state so each test can configure event rows. The mock Supabase
 * builder honors `.gte('created_at', cutoff)` so that range-cutoff bugs
 * are exercised (default range → cutoff → filtered rows → empty list).
 */
let _eventRows: any[] = [];

vi.mock('@/shared/supabase', () => {
  const makeShelfEventBuilder = () => {
    const filters: { gte?: { col: string; value: string } } = {};
    const b: any = {};
    b.select = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.order = vi.fn(() => b);
    b.limit = vi.fn(() => b);
    b.gte = vi.fn((col: string, value: string) => {
      filters.gte = { col, value };
      return b;
    });
    const resolve = () => {
      let rows = _eventRows;
      if (filters.gte && filters.gte.col === 'created_at') {
        const cutoff = filters.gte.value;
        rows = rows.filter((r) => r.created_at >= cutoff);
      }
      return Promise.resolve({ data: rows, error: null });
    };
    b.then = (onResolve: any, onReject?: any) => resolve().then(onResolve, onReject);
    b.catch = (onReject: any) => resolve().catch(onReject);
    return b;
  };

  const makeEmptyBuilder = () => {
    const b: any = {};
    b.select = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.order = vi.fn(() => b);
    b.limit = vi.fn(() => b);
    b.gte = vi.fn(() => b);
    b.then = (onResolve: any, onReject?: any) => Promise.resolve({ data: [], error: null }).then(onResolve, onReject);
    b.catch = (onReject: any) => Promise.resolve({ data: [], error: null }).catch(onReject);
    return b;
  };

  const chef = () => ({
    from: vi.fn((table: string) => {
      if (table === 'shelf_event_log') return makeShelfEventBuilder();
      return makeEmptyBuilder();
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

function eventRow(createdAtIso: string, suffix: string): Record<string, unknown> {
  return {
    event_id: `evt-${suffix}`,
    client_event_id: `client-${suffix}`,
    pi_event_id: null,
    applied: true,
    reason: null,
    created_at: createdAtIso,
    classifier_status: null,
    classification: null,
    payload: {
      product_id: 'prod-abc',
      event_kind: 'consumed',
      delta_g: -200,
      occurred_at: createdAtIso,
    },
    before_image_url: null,
    after_image_url: null,
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

describe('EventViewerPage — default range shows old events', () => {
  it('renders events older than 7 days on first load (default range no longer hides them)', async () => {
    // Two events, both older than the previous 'week' default cutoff.
    const elevenDaysAgo = new Date(Date.now() - 11 * 24 * 60 * 60 * 1000).toISOString();
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    _eventRows = [eventRow(elevenDaysAgo, 'old-11d'), eventRow(twentyDaysAgo, 'old-20d')];

    renderPage();

    await waitFor(() => {
      expect(screen.queryByTestId('event-row-client-old-11d')).not.toBeNull();
    });
    expect(screen.queryByTestId('event-row-client-old-20d')).not.toBeNull();
    expect(screen.queryByTestId('no-events')).toBeNull();
  });

  it('the All-time range button is rendered as the active filter on initial load', async () => {
    _eventRows = [];
    renderPage();

    await waitFor(() => {
      expect(screen.queryByTestId('range-all')).not.toBeNull();
    });

    const allBtn = screen.getByTestId('range-all');
    const weekBtn = screen.getByTestId('range-week');
    const todayBtn = screen.getByTestId('range-today');

    expect(allBtn.getAttribute('aria-pressed')).toBe('true');
    expect(weekBtn.getAttribute('aria-pressed')).toBe('false');
    expect(todayBtn.getAttribute('aria-pressed')).toBe('false');
  });
});
