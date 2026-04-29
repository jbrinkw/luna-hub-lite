/**
 * S-02: Unit tests for AuthProvider.
 *
 * AuthProvider manages the onAuthStateChange subscription, session hydration,
 * and signOut cleanup. It is mocked in every other test — the actual session
 * refresh retry logic, SIGNED_OUT handling, and cleanup of the
 * onAuthStateChange subscription on unmount are tested here.
 *
 * Key assertions:
 *  (a) INITIAL_SESSION event sets user + session and clears loading state.
 *  (b) SIGNED_OUT event clears user and session.
 *  (c) A null session AFTER initial load sets a sessionError (token expiry).
 *  (d) onAuthStateChange subscription is unsubscribed on unmount.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Supabase mock — must be defined with vi.hoisted so it's available in
// vi.mock factory (vi.mock is hoisted to the top by Vitest).
// ---------------------------------------------------------------------------

const { mockSupabase, mockUnsubscribe, fireAuthEvent } = vi.hoisted(() => {
  const mockUnsubscribe = vi.fn();
  let authStateCallback: ((event: string, session: any) => void) | null = null;

  const mockSupabase = {
    auth: {
      onAuthStateChange: vi.fn((cb: (event: string, session: any) => void) => {
        authStateCallback = cb;
        return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
      }),
      signInWithPassword: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      signUp: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      getUser: vi.fn(),
    },
  };

  const fireAuthEvent = (event: string, session: any) => {
    if (authStateCallback) authStateCallback(event, session);
  };

  return { mockSupabase, mockUnsubscribe, fireAuthEvent };
});

vi.mock('@/shared/supabase', () => ({
  supabase: mockSupabase,
}));

import { AuthProvider, useAuth } from '@/shared/auth/AuthProvider';

// ---------------------------------------------------------------------------
// Test component that reads auth context
// ---------------------------------------------------------------------------

function AuthStatus() {
  const { user, session, loading, sessionError } = useAuth();
  return (
    <div>
      <div data-testid="loading">{loading ? 'loading' : 'ready'}</div>
      <div data-testid="user">{user ? user.email : 'none'}</div>
      <div data-testid="session">{session ? 'active' : 'none'}</div>
      <div data-testid="error">{sessionError ?? 'none'}</div>
    </div>
  );
}

function renderWithProvider() {
  return render(
    <AuthProvider>
      <AuthStatus />
    </AuthProvider>,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSession = {
  access_token: 'access-tok',
  refresh_token: 'refresh-tok',
  user: { id: 'user-123', email: 'test@example.com' },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Reset onAuthStateChange mock to re-capture the callback
  mockSupabase.auth.onAuthStateChange.mockImplementation((cb: (event: string, session: any) => void) => {
    (fireAuthEvent as any)._cb = cb;
    return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
  });
  (fireAuthEvent as any)._cb = null;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthProvider — INITIAL_SESSION', () => {
  it('starts in loading state before any auth event', () => {
    renderWithProvider();
    // Before INITIAL_SESSION fires, loading=true
    expect(screen.getByTestId('loading').textContent).toBe('loading');
  });

  it('sets user and session from INITIAL_SESSION event', async () => {
    renderWithProvider();

    act(() => {
      fireAuthEvent('INITIAL_SESSION', mockSession);
    });

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('ready');
    });
    expect(screen.getByTestId('user').textContent).toBe('test@example.com');
    expect(screen.getByTestId('session').textContent).toBe('active');
  });

  it('clears loading even when INITIAL_SESSION carries null (no session)', async () => {
    renderWithProvider();

    act(() => {
      fireAuthEvent('INITIAL_SESSION', null);
    });

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('ready');
    });
    expect(screen.getByTestId('user').textContent).toBe('none');
    expect(screen.getByTestId('session').textContent).toBe('none');
  });
});

describe('AuthProvider — SIGNED_OUT', () => {
  it('clears user and session on SIGNED_OUT event', async () => {
    renderWithProvider();

    // First, establish a session
    act(() => {
      fireAuthEvent('INITIAL_SESSION', mockSession);
    });
    await waitFor(() => {
      expect(screen.getByTestId('user').textContent).toBe('test@example.com');
    });

    // Then sign out
    act(() => {
      fireAuthEvent('SIGNED_OUT', null);
    });

    await waitFor(() => {
      expect(screen.getByTestId('user').textContent).toBe('none');
      expect(screen.getByTestId('session').textContent).toBe('none');
    });
  });

  it('does NOT set sessionError on SIGNED_OUT (intentional sign-out is not an error)', async () => {
    renderWithProvider();

    act(() => {
      fireAuthEvent('INITIAL_SESSION', mockSession);
    });
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('ready'));

    act(() => {
      fireAuthEvent('SIGNED_OUT', null);
    });

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('none');
    });
  });
});

describe('AuthProvider — session expiry (token refresh failure)', () => {
  it('sets sessionError when session becomes null after initial load (not SIGNED_OUT)', async () => {
    renderWithProvider();

    act(() => {
      fireAuthEvent('INITIAL_SESSION', mockSession);
    });
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('ready'));

    // Simulate a token-refresh failure: a TOKEN_REFRESHED event with null session
    act(() => {
      fireAuthEvent('TOKEN_REFRESHED', null);
    });

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toMatch(/session has expired/i);
    });
  });
});

describe('AuthProvider — subscription cleanup', () => {
  it('calls subscription.unsubscribe on unmount', async () => {
    const { unmount } = renderWithProvider();

    act(() => {
      fireAuthEvent('INITIAL_SESSION', mockSession);
    });
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('ready'));

    unmount();

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('AuthProvider — timeout fallback', () => {
  it('clears loading after 10s even if no auth event fires', async () => {
    vi.useFakeTimers();

    renderWithProvider();
    expect(screen.getByTestId('loading').textContent).toBe('loading');

    act(() => {
      vi.advanceTimersByTime(10_001);
    });

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('ready');
    });
  });
});
