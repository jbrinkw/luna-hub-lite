/**
 * UX Audit R2 #3 — Inventory legend regression guard.
 *
 * R1 shipped the legend always-rendered above the view-toggle and search
 * box. On a phone-at-fridge first paint that pushed the actual inventory
 * data below the fold. R2 fix:
 *   1. Legend is collapsed by default behind a single
 *      "What do these badges mean?" trigger.
 *   2. Legend lives BELOW the view-toggle + search row, not above them.
 *   3. After "Got it" dismissal the trigger stops appearing and the
 *      preference persists per-user via a user-scoped localStorage key.
 *
 * Tests mount the real InventoryPage with a minimal Supabase mock —
 * no products needed; we're only exercising the legend chrome.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const USER_ID = 'user-legend';

vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const builder: any = {};
    builder.from = vi.fn((_table: string) => {
      const b: any = {};
      const state: { mode: 'select' | 'update' | 'insert' } = { mode: 'select' };
      b.select = vi.fn(() => b);
      b.eq = vi.fn(() => b);
      b.is = vi.fn(() => b);
      b.in = vi.fn(() => b);
      b.not = vi.fn(() => b);
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
      b.limit = vi.fn(() => Promise.resolve({ data: [{ location_id: 'loc-1' }], error: null }));
      b.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
      b.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
      b.order = vi.fn(() => Promise.resolve({ data: [], error: null }));
      b.then = (resolve: (v: any) => void) => resolve({ data: [], error: null });
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
      realtime: { stateChangeCallbacks: { close: [] }, connect: vi.fn() },
      functions: { invoke: vi.fn(() => Promise.resolve({ data: null, error: null })) },
    },
    chefbyte,
    coachbyte: vi.fn(),
    escapeIlike: (s: string) => s,
  };
});

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: USER_ID, email: 't@t.com' },
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
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chef/inventory']}>
        <InventoryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('InventoryPage — legend (R2 collapse-by-default)', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
    vi.clearAllMocks();
  });
  afterEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('shows the toggle trigger but NOT the panel on first paint', async () => {
    renderPage();
    // Trigger appears once we've initialised
    await screen.findByTestId('inventory-legend-toggle');
    // Panel is collapsed — content NOT rendered.
    expect(screen.queryByTestId('inventory-legend')).toBeNull();
  });

  it('clicking the trigger expands the panel; clicking again collapses it', async () => {
    const user = userEvent.setup();
    renderPage();
    const toggle = await screen.findByTestId('inventory-legend-toggle');

    await user.click(toggle);
    expect(screen.getByTestId('inventory-legend')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);
    expect(screen.queryByTestId('inventory-legend')).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('"Got it" dismissal hides the trigger entirely AND persists per-user in localStorage', async () => {
    const user = userEvent.setup();
    renderPage();
    const toggle = await screen.findByTestId('inventory-legend-toggle');

    await user.click(toggle);
    const dismiss = screen.getByTestId('inventory-legend-dismiss');
    await user.click(dismiss);

    // Trigger AND panel both gone after dismissal.
    expect(screen.queryByTestId('inventory-legend-toggle')).toBeNull();
    expect(screen.queryByTestId('inventory-legend')).toBeNull();

    // Per-user storage key (the audit explicitly called out the global
    // key as a shared-device bug). The key MUST include the user id.
    const stored = localStorage.getItem(`chefbyte_inv_legend_dismissed:${USER_ID}`);
    expect(stored).toBe('1');
  });

  it('legend lives below the search box (not above the view toggle) — DOM order check', async () => {
    renderPage();
    const toggle = await screen.findByTestId('inventory-view-toggle');
    const search = screen.getByTestId('inventory-search');
    const legendToggle = screen.getByTestId('inventory-legend-toggle');

    // Helper: index in document order via compareDocumentPosition.
    const isAfter = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

    expect(isAfter(toggle, search)).toBe(true); // toggle precedes search
    expect(isAfter(search, legendToggle)).toBe(true); // search precedes legend
  });
});
