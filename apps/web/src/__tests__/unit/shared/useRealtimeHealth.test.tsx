import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRealtimeHealth } from '../../../shared/useRealtimeHealth';
import { realtimeHealth } from '../../../shared/realtimeHealth';

describe('useRealtimeHealth', () => {
  beforeEach(() => {
    realtimeHealth._resetForTests();
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

  it('reconnect() fans out to every registered reconnector', () => {
    const reconnectA = vi.fn();
    const reconnectB = vi.fn();
    realtimeHealth.register('a', reconnectA);
    realtimeHealth.register('b', reconnectB);

    const { result } = renderHook(() => useRealtimeHealth());
    act(() => {
      result.current.reconnect();
    });
    expect(reconnectA).toHaveBeenCalledTimes(1);
    expect(reconnectB).toHaveBeenCalledTimes(1);
  });
});
