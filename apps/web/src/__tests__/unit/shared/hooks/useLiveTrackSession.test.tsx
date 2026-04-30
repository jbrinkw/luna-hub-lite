/**
 * Unit tests for useLiveTrackSession.
 *
 * The hook wraps TanStack Query + Supabase Realtime for one LiveTrack
 * import session. It:
 *   - returns null when sessionId is null (disabled)
 *   - returns isLoading=true while in-flight
 *   - returns the session object on success
 *   - surfaces error state on failure
 *   - exposes a patch() helper that writes to Supabase then updates cache
 *   - exposes refetch()
 *
 * useRealtimeInvalidation is mocked — its channel subscription is an
 * infrastructure concern tested in its own suite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockLoadSession, mockPatchSession, mockUseAuth } = vi.hoisted(() => {
  const mockLoadSession = vi.fn();
  const mockPatchSession = vi.fn();
  const mockUseAuth = vi.fn();
  return { mockLoadSession, mockPatchSession, mockUseAuth };
});

vi.mock('@/pages/chefbyte/livetrackSession', () => ({
  loadLiveTrackSession: mockLoadSession,
  patchLiveTrackSession: mockPatchSession,
}));

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: mockUseAuth,
}));

vi.mock('@/shared/useRealtimeInvalidation', () => ({
  useRealtimeInvalidation: vi.fn(),
}));

vi.mock('@/shared/queryKeys', () => ({
  queryKeys: {
    livetrackSession: (userId: string, sessionId: string | null) => ['livetrack-session', userId, sessionId] as const,
    liveShelfDevice: (userId: string) => ['live-shelf-device', userId] as const,
  },
}));

import { useLiveTrackSession } from '@/hooks/useLiveTrackSession';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_STUB = {
  session_id: 'sess-1',
  user_id: 'user-1',
  device_id: 'dev-1',
  scale_id: 'scale-01',
  state: 'waiting_barcode',
  current_barcode: null,
  current_product_id: null,
  scale_reading_g: null,
  scale_reading_ts: null,
  ai_tare_product_form: null,
  ai_tare_g: null,
  ai_tare_confidence: null,
  ai_tare_reasoning: null,
  last_error: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  expires_at: '2026-01-01T01:00:00Z',
};

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  return {
    qc,
    Wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  };
}

describe('useLiveTrackSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: { id: 'user-1' } });
  });

  it('returns null session immediately when sessionId is null (query disabled)', () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useLiveTrackSession(null), {
      wrapper: Wrapper,
    });

    expect(result.current.session).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('returns isLoading=true while loadLiveTrackSession is pending', () => {
    mockLoadSession.mockReturnValue(new Promise(() => {})); // never resolves
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useLiveTrackSession('sess-1'), {
      wrapper: Wrapper,
    });

    expect(result.current.isLoading).toBe(true);
  });

  it('returns session object on successful load', async () => {
    mockLoadSession.mockResolvedValue(SESSION_STUB);
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useLiveTrackSession('sess-1'), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.session).toEqual(SESSION_STUB);
    expect(result.current.error).toBeNull();
  });

  it('surfaces error when loadLiveTrackSession rejects', async () => {
    mockLoadSession.mockRejectedValue(new Error('network error'));
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useLiveTrackSession('sess-1'), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.session).toBeUndefined();
  });

  it('patch() calls patchLiveTrackSession and updates query cache', async () => {
    const patchedSession = { ...SESSION_STUB, state: 'waiting_scale' };
    mockLoadSession.mockResolvedValue(SESSION_STUB);
    mockPatchSession.mockResolvedValue(patchedSession);

    const { Wrapper, qc } = makeWrapper();
    const { result } = renderHook(() => useLiveTrackSession('sess-1'), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.session).toEqual(SESSION_STUB));

    const updated = await result.current.patch({ state: 'waiting_scale' } as any);
    expect(mockPatchSession).toHaveBeenCalledWith('sess-1', { state: 'waiting_scale' });
    expect(updated).toEqual(patchedSession);

    // Cache should be updated
    const cached = qc.getQueryData(['livetrack-session', 'user-1', 'sess-1']);
    expect(cached).toEqual(patchedSession);
  });

  it('patch() throws when called with no active session', async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useLiveTrackSession(null), {
      wrapper: Wrapper,
    });

    await expect(result.current.patch({ state: 'closed' } as any)).rejects.toThrow('no active session');
  });

  it('exposes refetch function', async () => {
    mockLoadSession.mockResolvedValue(SESSION_STUB);
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useLiveTrackSession('sess-1'), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.session).toEqual(SESSION_STUB));
    expect(typeof result.current.refetch).toBe('function');
  });

  it('reconnect: refetch returns updated data after a reconnect', async () => {
    const updatedSession = { ...SESSION_STUB, state: 'waiting_scale' };
    mockLoadSession
      .mockResolvedValueOnce(SESSION_STUB) // initial load
      .mockResolvedValueOnce(updatedSession); // after reconnect

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useLiveTrackSession('sess-1'), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.session).toEqual(SESSION_STUB));

    // Simulate reconnect by calling refetch
    await result.current.refetch();

    await waitFor(() => expect(result.current.session).toEqual(updatedSession));
  });
});
