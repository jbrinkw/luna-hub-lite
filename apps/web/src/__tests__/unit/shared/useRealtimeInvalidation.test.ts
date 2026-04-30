/**
 * S-01: Unit tests for useRealtimeInvalidation hook.
 *
 * useRealtimeInvalidation is the central realtime→cache invalidation
 * mechanism for the entire app. It is mocked in 12+ other test files, so the
 * actual queryClient.invalidateQueries call, subscription wiring, and cleanup
 * have never been verified until now.
 *
 * Key assertions:
 *  - queryClient.invalidateQueries is called with the correct query key when
 *    a postgres_changes event fires.
 *  - The channel is removed from supabase on hook cleanup (no leak).
 *  - The hook is a no-op when user is null (unauthenticated).
 *  - The hook is a no-op when supabase.channel is not a function (test env
 *    guard, per the implementation comment).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

// ---------------------------------------------------------------------------
// Hoisted mocks — use vi.hoisted so factory closures can reference these
// variables even though vi.mock is hoisted to the top of the file.
// ---------------------------------------------------------------------------

const { mockChannel, mockSupabase, captureCallbacks } = vi.hoisted(() => {
  let postgresChangesCallback: (() => void) | null = null;
  let broadcastCallback: ((payload: any) => void) | null = null;

  const mockChannel = {
    on: vi.fn((eventType: string, _filter: any, cb: any) => {
      if (eventType === 'postgres_changes') postgresChangesCallback = cb;
      else if (eventType === 'broadcast') broadcastCallback = cb;
      return mockChannel;
    }),
    subscribe: vi.fn((cb?: any) => {
      if (cb) cb('SUBSCRIBED', undefined);
      return mockChannel;
    }),
    unsubscribe: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
  };

  const mockSupabase = {
    channel: vi.fn(() => mockChannel),
    removeChannel: vi.fn(),
    realtime: {
      stateChangeCallbacks: {
        close: [] as Array<(e: unknown) => void>,
      },
      connect: vi.fn(),
    },
    auth: {
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  };

  return {
    mockChannel,
    mockSupabase,
    captureCallbacks: {
      get postgres() {
        return postgresChangesCallback;
      },
      get broadcast() {
        return broadcastCallback;
      },
      reset() {
        postgresChangesCallback = null;
        broadcastCallback = null;
      },
    },
  };
});

vi.mock('@/shared/supabase', () => ({
  supabase: mockSupabase,
}));

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: vi.fn(() => ({ user: { id: 'user-123', email: 'test@test.com' } })),
  AuthProvider: ({ children }: any) => children,
}));

vi.mock('@/shared/realtimeHealth', () => ({
  realtimeHealth: {
    register: vi.fn(),
    unregister: vi.fn(),
    setStatus: vi.fn(),
    markHeartbeatSent: vi.fn(),
    markHeartbeatEcho: vi.fn(),
    isAnyDegraded: vi.fn(() => false),
  },
  HEARTBEAT_MS: 30_000,
  INITIAL_CONNECT_GRACE_MS: 5_000,
}));

// Import hook and mocked useAuth after vi.mock declarations
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';
import { useAuth } from '@/shared/auth/AuthProvider';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

const mockUser = { id: 'user-123', email: 'test@test.com' };

beforeEach(() => {
  vi.clearAllMocks();
  captureCallbacks.reset();

  // Re-wire channel mock so .on() re-captures callbacks after clearAllMocks()
  mockChannel.on.mockImplementation((eventType: string, _filter: any, cb: any) => {
    if (eventType === 'postgres_changes') (captureCallbacks as any)._postgres = cb;
    else if (eventType === 'broadcast') (captureCallbacks as any)._broadcast = cb;
    return mockChannel;
  });
  mockChannel.subscribe.mockImplementation((cb?: any) => {
    if (cb) cb('SUBSCRIBED', undefined);
    return mockChannel;
  });
  mockChannel.send.mockResolvedValue(undefined);
  mockSupabase.channel.mockReturnValue(mockChannel);
  mockSupabase.realtime.stateChangeCallbacks.close = [];

  (useAuth as ReturnType<typeof vi.fn>).mockReturnValue({ user: mockUser });
});

// ---------------------------------------------------------------------------
// Helper: fire the most-recently-captured postgres_changes callback
// ---------------------------------------------------------------------------
function firePostgresChange() {
  const cb = (captureCallbacks as any)._postgres as (() => void) | undefined;
  if (!cb) throw new Error('No postgres_changes callback captured — channel.on may not have been called');
  cb();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useRealtimeInvalidation — query invalidation', () => {
  it('calls queryClient.invalidateQueries with the correct key when postgres_changes fires', () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const testKey = ['stockLots', 'user-123'] as const;

    renderHook(
      () =>
        useRealtimeInvalidation('test-channel', [
          {
            schema: 'chefbyte',
            table: 'stock_lots',
            queryKeys: [testKey],
          },
        ]),
      { wrapper: wrapper(queryClient) },
    );

    firePostgresChange();

    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: [...testKey] }));
  });

  it('invalidates all query keys registered for the table', () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const key1 = ['lots', 'user-123'] as const;
    const key2 = ['macros', 'user-123'] as const;

    renderHook(
      () =>
        useRealtimeInvalidation('multi-key-channel', [
          {
            schema: 'chefbyte',
            table: 'food_logs',
            queryKeys: [key1, key2],
          },
        ]),
      { wrapper: wrapper(queryClient) },
    );

    firePostgresChange();

    expect(invalidateSpy).toHaveBeenCalledTimes(2);
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: [...key1] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: [...key2] }));
  });

  it('passes refetchType: "all" to force refetch regardless of observer state', () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(
      () =>
        useRealtimeInvalidation('refetch-channel', [
          { schema: 'chefbyte', table: 'products', queryKeys: [['products']] },
        ]),
      { wrapper: wrapper(queryClient) },
    );

    firePostgresChange();

    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ refetchType: 'all' }));
  });
});

describe('useRealtimeInvalidation — channel lifecycle', () => {
  it('subscribes to supabase.channel on mount with the channel name', () => {
    const queryClient = makeQueryClient();

    renderHook(
      () =>
        useRealtimeInvalidation('my-channel', [
          { schema: 'coachbyte', table: 'daily_logs', queryKeys: [['dailyLogs']] },
        ]),
      { wrapper: wrapper(queryClient) },
    );

    expect(mockSupabase.channel).toHaveBeenCalledWith(expect.stringContaining('my-channel'), expect.any(Object));
    expect(mockChannel.subscribe).toHaveBeenCalledTimes(1);
  });

  it('removes the channel from supabase on unmount (no memory leak)', () => {
    const queryClient = makeQueryClient();

    const { unmount } = renderHook(
      () =>
        useRealtimeInvalidation('leak-test-channel', [
          { schema: 'chefbyte', table: 'products', queryKeys: [['products']] },
        ]),
      { wrapper: wrapper(queryClient) },
    );

    unmount();

    expect(mockSupabase.removeChannel).toHaveBeenCalledTimes(1);
  });
});

describe('useRealtimeInvalidation — unauthenticated guard', () => {
  it('does NOT subscribe when user is null', () => {
    (useAuth as ReturnType<typeof vi.fn>).mockReturnValue({ user: null });
    const queryClient = makeQueryClient();

    renderHook(
      () =>
        useRealtimeInvalidation('no-user-channel', [
          { schema: 'chefbyte', table: 'stock_lots', queryKeys: [['stockLots']] },
        ]),
      { wrapper: wrapper(queryClient) },
    );

    expect(mockSupabase.channel).not.toHaveBeenCalled();
  });
});

describe('useRealtimeInvalidation — test env guard', () => {
  it('does NOT subscribe when supabase.channel is not a function', () => {
    // Simulate test environment where the supabase mock lacks .channel
    const originalChannel = mockSupabase.channel;
    (mockSupabase as any).channel = undefined;

    const queryClient = makeQueryClient();

    renderHook(
      () =>
        useRealtimeInvalidation('guard-channel', [
          { schema: 'chefbyte', table: 'stock_lots', queryKeys: [['stockLots']] },
        ]),
      { wrapper: wrapper(queryClient) },
    );

    (mockSupabase as any).channel = originalChannel;
    expect(mockChannel.subscribe).not.toHaveBeenCalled();
  });
});
