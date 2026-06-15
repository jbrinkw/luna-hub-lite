/**
 * Spec-vs-implementation tests — Hub
 *
 * Each test drives a REAL imported production component/symbol so it can turn
 * RED when that symbol regresses. Earlier revisions asserted in-file booleans
 * (`!onlineState`, `initialLoadComplete && session === null && ...`) and string
 * literals — copies of the spec that could never fail for a production change.
 * Those were removed/rewired.
 *
 * Spec claims with a real web hook (pinned here):
 *   • ModuleSwitcher filters by activations  → <ModuleSwitcher /> (real render)
 *   • OfflineIndicator shown when offline      → <OfflineIndicator /> (real render)
 *   • Session expiry → toast (not on SIGNED_OUT) → <AuthProvider /> (real render)
 *
 * Spec claims with NO falsifiable web symbol (intentionally NOT faked):
 *   • API key show-once / SHA-256 hash (hub.md): the hash is computed in the DB
 *     (`hub` schema, SHA-256) and shown once client-side; there is no web
 *     function to import. Asserting `typeof rawKey === 'string'` is a tautology.
 *     Covered by the api-key-lifecycle integration + pgTAP suites.
 *   • dayStartHour-from-profile (hub.md): resolved inside AppProvider's profile
 *     queryFn closure (`data?.day_start_hour ?? 0`), not an exported helper.
 *     Covered by integration/pages/hub-app-provider.test.ts.
 *   • Extension-without-credentials returns isError:true (hub.md:33): this is an
 *     MCP-worker / extension-tool runtime behaviour (first tool call), NOT web
 *     code — the web ExtensionsPage only renders settings + a "Credentials
 *     configured" boolean. Covered by app-tools/mcp-worker tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ---------------------------------------------------------------------------
// AuthProvider needs a supabase mock whose onAuthStateChange callback we can
// fire by hand. vi.hoisted so the reference is available inside the (hoisted)
// vi.mock factory. (Mirrors unit/hub/AuthProvider.test.tsx.)
// ---------------------------------------------------------------------------
const { mockSupabase, authCallbacks } = vi.hoisted(() => {
  const authCallbacks = { current: null as ((event: string, session: unknown) => void) | null };
  const mockSupabase = {
    auth: {
      onAuthStateChange: vi.fn((cb: (event: string, session: unknown) => void) => {
        authCallbacks.current = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      signInWithPassword: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      signUp: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
  };
  return { mockSupabase, authCallbacks };
});

vi.mock('@/shared/supabase', () => ({
  supabase: mockSupabase,
  chefbyte: vi.fn(),
  coachbyte: vi.fn(),
  escapeIlike: (s: string) => s,
}));

vi.mock('@/shared/useRealtimeInvalidation', () => ({
  useRealtimeInvalidation: vi.fn(),
}));

// `@/shared/AppProvider` is mocked globally by setup.ts (useAppContext is a
// vi.fn returning sensible defaults). We override its return value per-test.
import { useAppContext } from '@/shared/AppProvider';
import { ModuleSwitcher } from '@/components/ModuleSwitcher';
import { OfflineIndicator } from '@/components/OfflineIndicator';
import { AuthProvider } from '@/shared/auth/AuthProvider';

const mockUseAppContext = vi.mocked(useAppContext);

function makeCtx(overrides: Partial<ReturnType<typeof useAppContext>> = {}) {
  return {
    activations: { coachbyte: true, chefbyte: true },
    online: true,
    lastSynced: new Date(),
    dayStartHour: 0,
    timezone: 'America/New_York',
    refreshActivations: vi.fn(),
    realtimeDegraded: false,
    reconnectRealtime: vi.fn(async () => {}),
    ...overrides,
  } as ReturnType<typeof useAppContext>;
}

beforeEach(() => {
  vi.clearAllMocks();
  authCallbacks.current = null;
  mockSupabase.auth.onAuthStateChange.mockImplementation((cb: (event: string, session: unknown) => void) => {
    authCallbacks.current = cb;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
});

// =========================================================================
// ModuleSwitcher: Hub always visible; CoachByte/ChefByte require activation.
//   Renders the REAL <ModuleSwitcher>, which does:
//     allModules.filter(m => m.appName === null || activations[m.appName])
//   If that filter regresses, the visible button set changes → RED.
// =========================================================================

describe('spec: ModuleSwitcher filters by activations (real component)', () => {
  function renderSwitcher() {
    return render(
      <MemoryRouter initialEntries={['/hub']}>
        <ModuleSwitcher />
      </MemoryRouter>,
    );
  }

  it('shows only Hub when no app is activated', () => {
    mockUseAppContext.mockReturnValue(makeCtx({ activations: { coachbyte: false, chefbyte: false } }));
    renderSwitcher();
    expect(screen.getByRole('button', { name: 'Hub' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'CoachByte' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ChefByte' })).not.toBeInTheDocument();
  });

  it('shows an activated module alongside the always-on Hub', () => {
    mockUseAppContext.mockReturnValue(makeCtx({ activations: { coachbyte: true, chefbyte: false } }));
    renderSwitcher();
    expect(screen.getByRole('button', { name: 'Hub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CoachByte' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ChefByte' })).not.toBeInTheDocument();
  });
});

// =========================================================================
// OfflineIndicator: renders the offline banner only when online === false.
//   Renders the REAL <OfflineIndicator>. If the `if (!online)` gate regresses
//   (e.g. inverted, or banner removed), these assertions go RED.
// =========================================================================

describe('spec: OfflineIndicator shown when offline (real component)', () => {
  it('renders the "No connection" banner when online=false', () => {
    mockUseAppContext.mockReturnValue(makeCtx({ online: false }));
    render(<OfflineIndicator />);
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
    expect(screen.getByText(/No connection/)).toBeInTheDocument();
  });

  it('renders nothing when online=true and realtime is healthy', () => {
    mockUseAppContext.mockReturnValue(makeCtx({ online: true, realtimeDegraded: false }));
    const { container } = render(<OfflineIndicator />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('offline-banner')).not.toBeInTheDocument();
  });
});

// =========================================================================
// Session expiry: a null session AFTER initial load (event !== SIGNED_OUT)
// surfaces the expiry toast; SIGNED_OUT does NOT. Renders the REAL
// <AuthProvider> and drives its onAuthStateChange callback — pinning the
// production guard at AuthProvider.tsx:79
//   `if (!newSession && initialLoadDone.current && event !== 'SIGNED_OUT')`.
// =========================================================================

describe('spec: session expiry detection (real AuthProvider)', () => {
  function fire(event: string, session: unknown) {
    if (!authCallbacks.current) throw new Error('onAuthStateChange not registered');
    authCallbacks.current(event, session);
  }

  it('TOKEN_REFRESHED with null session after initial load shows the expiry toast', async () => {
    render(
      <AuthProvider>
        <div>child</div>
      </AuthProvider>,
    );
    act(() => fire('INITIAL_SESSION', { user: { id: 'u-hub' } }));
    act(() => fire('TOKEN_REFRESHED', null));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/session has expired/i);
    });
  });

  it('SIGNED_OUT does NOT show the expiry toast (intentional sign-out)', async () => {
    render(
      <AuthProvider>
        <div>child</div>
      </AuthProvider>,
    );
    act(() => fire('INITIAL_SESSION', { user: { id: 'u-hub' } }));
    act(() => fire('SIGNED_OUT', null));

    // Give any (incorrect) toast a chance to mount, then assert it didn't.
    await Promise.resolve();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('null session BEFORE initial load (INITIAL_SESSION null) does NOT show the toast', async () => {
    render(
      <AuthProvider>
        <div>child</div>
      </AuthProvider>,
    );
    act(() => fire('INITIAL_SESSION', null));

    await Promise.resolve();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
