import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRealtimeHealth, RECONNECT_SETTLE_MS } from '../../../shared/useRealtimeHealth';
import { realtimeHealth } from '../../../shared/realtimeHealth';
import { supabase } from '../../../shared/supabase';

// Mock the Supabase client so we can spy on realtime.disconnect()/connect()
// without opening any real WebSockets. We only need the .realtime surface
// the hook touches.
vi.mock('../../../shared/supabase', () => ({
  supabase: {
    realtime: {
      disconnect: vi.fn(),
      connect: vi.fn(),
    },
  },
}));

const mockDisconnect = vi.mocked(supabase.realtime.disconnect);
const mockConnect = vi.mocked(supabase.realtime.connect);

describe('useRealtimeHealth', () => {
  beforeEach(() => {
    realtimeHealth._resetForTests();
    mockDisconnect.mockClear();
    mockConnect.mockClear();
  });

  it('reports degraded = false when no channels are registered', () => {
    const { result } = renderHook(() => useRealtimeHealth());
    expect(result.current.degraded).toBe(false);
  });

  it('does not flash degraded=true immediately after register (initial-connect grace window)', () => {
    // Bug fix: previously this hook reported degraded=true the moment a
    // channel was registered, causing a "Live updates paused" banner to
    // flash on every page load before the channel reached SUBSCRIBED.
    realtimeHealth.register('a', () => {});
    const { result } = renderHook(() => useRealtimeHealth());
    expect(result.current.degraded).toBe(false);

    act(() => {
      realtimeHealth.setStatus('a', 'SUBSCRIBED');
    });
    expect(result.current.degraded).toBe(false);
  });

  it('re-renders to degraded when a channel hits CHANNEL_ERROR', () => {
    realtimeHealth.register('a', () => {});
    realtimeHealth.setStatus('a', 'SUBSCRIBED');
    const { result } = renderHook(() => useRealtimeHealth());
    expect(result.current.degraded).toBe(false);

    act(() => {
      realtimeHealth.setStatus('a', 'CHANNEL_ERROR', 'boom');
    });
    expect(result.current.degraded).toBe(true);
  });

  it('reconnect() fans out to every registered reconnector', async () => {
    const reconnectA = vi.fn();
    const reconnectB = vi.fn();
    realtimeHealth.register('a', reconnectA);
    realtimeHealth.register('b', reconnectB);

    const { result } = renderHook(() => useRealtimeHealth());
    await act(async () => {
      await result.current.reconnect();
    });
    expect(reconnectA).toHaveBeenCalledTimes(1);
    expect(reconnectB).toHaveBeenCalledTimes(1);
  });

  it('reconnect() hard-resets the underlying socket via disconnect() + connect()', async () => {
    // Regression guard for the original bug: clicking "Reconnect" only
    // re-subscribed channels but never reset the dead socket, so the
    // banner stayed up forever. The fix is to disconnect+connect the
    // socket before the per-channel fan-out.
    const { result } = renderHook(() => useRealtimeHealth());
    await act(async () => {
      await result.current.reconnect();
    });
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('reconnect() calls disconnect() BEFORE connect() (order matters — connect on a still-open socket is a no-op)', async () => {
    const order: string[] = [];
    mockDisconnect.mockImplementation(() => {
      order.push('disconnect');
    });
    mockConnect.mockImplementation(() => {
      order.push('connect');
    });

    const { result } = renderHook(() => useRealtimeHealth());
    await act(async () => {
      await result.current.reconnect();
    });
    expect(order).toEqual(['disconnect', 'connect']);
  });

  it('reconnect() fans out to per-channel reconnectors AFTER the socket reset', async () => {
    // Order matters: the per-channel rebuild must happen on a freshly
    // reconnected socket, not the dead one. We assert via call ordering
    // by piggybacking on a shared event log.
    const order: string[] = [];
    mockDisconnect.mockImplementation(() => {
      order.push('disconnect');
    });
    mockConnect.mockImplementation(() => {
      order.push('connect');
    });
    const reconnectA = vi.fn(() => {
      order.push('channel:a');
    });
    realtimeHealth.register('a', reconnectA);

    const { result } = renderHook(() => useRealtimeHealth());
    await act(async () => {
      await result.current.reconnect();
    });
    expect(order).toEqual(['disconnect', 'connect', 'channel:a']);
  });

  it('reconnect() still calls connect() and fans out per-channel reconnectors when disconnect() throws', async () => {
    // Defensive: if the lib is in a transitional state and disconnect()
    // throws, we MUST still attempt connect() + per-channel reconnect.
    // Otherwise a transient internal error would brick the manual button.
    mockDisconnect.mockImplementation(() => {
      throw new Error('lib in shutdown');
    });
    const reconnectA = vi.fn();
    realtimeHealth.register('a', reconnectA);

    const { result } = renderHook(() => useRealtimeHealth());
    await act(async () => {
      await result.current.reconnect();
    });
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(reconnectA).toHaveBeenCalledTimes(1);
  });

  it('reconnect() returns a Promise that resolves only after the settle delay (so callers can await an in-flight UI state)', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useRealtimeHealth());

      let resolved = false;
      let reconnectPromise: Promise<void>;
      act(() => {
        reconnectPromise = result.current.reconnect().then(() => {
          resolved = true;
        });
      });

      // disconnect() runs synchronously before the await.
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
      // connect() should NOT have been called yet — waiting on the settle delay.
      expect(mockConnect).not.toHaveBeenCalled();
      expect(resolved).toBe(false);

      // Halfway through the settle window — still pending.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RECONNECT_SETTLE_MS / 2);
      });
      expect(mockConnect).not.toHaveBeenCalled();
      expect(resolved).toBe(false);

      // Past the settle window — connect runs and the promise resolves.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RECONNECT_SETTLE_MS);
        await reconnectPromise!;
      });
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
