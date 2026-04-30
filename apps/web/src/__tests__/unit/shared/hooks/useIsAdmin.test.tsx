/**
 * Unit tests for useIsAdmin hook.
 *
 * The hook fetches `hub.profiles.is_admin` for the signed-in user and
 * collapses every failure mode (network error, RLS denial, missing row)
 * to `isAdmin = false` — so a non-admin user never gets transient access
 * to admin UI.
 *
 * Coverage:
 *   - returns isAdmin=false + loading=false when no user is signed in
 *   - returns isAdmin=false + loading=true while the query is pending
 *   - returns isAdmin=true when the profile row has is_admin=true
 *   - returns isAdmin=false when the profile row has is_admin=false
 *   - returns isAdmin=false on supabase error (not throw — silent collapse)
 *   - returns isAdmin=false when maybeSingle returns null (no row)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

// ---------------------------------------------------------------------------
// Mocks — must be defined with vi.hoisted before vi.mock factories run
// ---------------------------------------------------------------------------

const { mockProfileFn, mockUseAuth } = vi.hoisted(() => {
  const mockProfileFn = vi.fn();
  const mockUseAuth = vi.fn();
  return { mockProfileFn, mockUseAuth };
});

vi.mock('@/shared/supabase', () => {
  const supabase = {
    schema: vi.fn(() => ({
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: mockProfileFn,
      })),
    })),
  };
  return { supabase };
});

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: mockUseAuth,
}));

import { useIsAdmin } from '@/hooks/useIsAdmin';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('useIsAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isAdmin=false and loading=false when no user is signed in', async () => {
    mockUseAuth.mockReturnValue({ user: null });

    const { result } = renderHook(() => useIsAdmin(), { wrapper: wrapper() });

    // Query is disabled when there's no user, so it never enters loading.
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('returns isAdmin=true when profile row has is_admin=true', async () => {
    mockUseAuth.mockReturnValue({ user: { id: 'user-1' } });
    mockProfileFn.mockResolvedValue({ data: { is_admin: true }, error: null });

    const { result } = renderHook(() => useIsAdmin(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isAdmin).toBe(true);
  });

  it('returns isAdmin=false when profile row has is_admin=false', async () => {
    mockUseAuth.mockReturnValue({ user: { id: 'user-2' } });
    mockProfileFn.mockResolvedValue({ data: { is_admin: false }, error: null });

    const { result } = renderHook(() => useIsAdmin(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isAdmin).toBe(false);
  });

  it('collapses supabase error to isAdmin=false (does not throw)', async () => {
    mockUseAuth.mockReturnValue({ user: { id: 'user-3' } });
    mockProfileFn.mockResolvedValue({ data: null, error: { message: 'RLS denied' } });

    const { result } = renderHook(() => useIsAdmin(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isAdmin).toBe(false);
  });

  it('returns isAdmin=false when maybeSingle returns null (no profile row)', async () => {
    mockUseAuth.mockReturnValue({ user: { id: 'user-4' } });
    mockProfileFn.mockResolvedValue({ data: null, error: null });

    const { result } = renderHook(() => useIsAdmin(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isAdmin).toBe(false);
  });

  it('returns loading=true while the query is in-flight', () => {
    mockUseAuth.mockReturnValue({ user: { id: 'user-5' } });
    // Never resolves, keeps the query pending.
    mockProfileFn.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useIsAdmin(), { wrapper: wrapper() });

    expect(result.current.loading).toBe(true);
    expect(result.current.isAdmin).toBe(false);
  });
});
