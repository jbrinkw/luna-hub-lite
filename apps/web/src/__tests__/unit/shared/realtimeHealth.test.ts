import { describe, it, expect, beforeEach, vi } from 'vitest';
import { realtimeHealth } from '../../../shared/realtimeHealth';

describe('realtimeHealth singleton', () => {
  beforeEach(() => {
    realtimeHealth._resetForTests();
  });

  it('starts degraded until a channel reaches SUBSCRIBED', () => {
    realtimeHealth.register('chef:stock_lots', () => {});
    expect(realtimeHealth.isAnyDegraded()).toBe(true);

    realtimeHealth.setStatus('chef:stock_lots', 'SUBSCRIBED');
    expect(realtimeHealth.isAnyDegraded()).toBe(false);
  });

  it('flips to degraded on CHANNEL_ERROR', () => {
    realtimeHealth.register('chef:stock_lots', () => {});
    realtimeHealth.setStatus('chef:stock_lots', 'SUBSCRIBED');
    expect(realtimeHealth.isAnyDegraded()).toBe(false);

    realtimeHealth.setStatus('chef:stock_lots', 'CHANNEL_ERROR', 'bad publication');
    expect(realtimeHealth.isAnyDegraded()).toBe(true);
  });

  it('flips to degraded on TIMED_OUT', () => {
    realtimeHealth.register('a', () => {});
    realtimeHealth.setStatus('a', 'SUBSCRIBED');
    realtimeHealth.setStatus('a', 'TIMED_OUT');
    expect(realtimeHealth.isAnyDegraded()).toBe(true);
  });

  it('flips to degraded on CLOSED', () => {
    realtimeHealth.register('a', () => {});
    realtimeHealth.setStatus('a', 'SUBSCRIBED');
    realtimeHealth.setStatus('a', 'CLOSED');
    expect(realtimeHealth.isAnyDegraded()).toBe(true);
  });

  it('stays healthy through 2 missed heartbeats and flips on the 3rd', () => {
    realtimeHealth.register('a', () => {});
    realtimeHealth.setStatus('a', 'SUBSCRIBED');

    realtimeHealth.markHeartbeatSent('a');
    expect(realtimeHealth.isAnyDegraded()).toBe(false);

    realtimeHealth.markHeartbeatSent('a');
    expect(realtimeHealth.isAnyDegraded()).toBe(false);

    realtimeHealth.markHeartbeatSent('a');
    expect(realtimeHealth.isAnyDegraded()).toBe(true);
  });

  it('recovers when a heartbeat echo arrives', () => {
    realtimeHealth.register('a', () => {});
    realtimeHealth.setStatus('a', 'SUBSCRIBED');

    realtimeHealth.markHeartbeatSent('a');
    realtimeHealth.markHeartbeatSent('a');
    realtimeHealth.markHeartbeatSent('a');
    expect(realtimeHealth.isAnyDegraded()).toBe(true);

    realtimeHealth.markHeartbeatEcho('a');
    expect(realtimeHealth.isAnyDegraded()).toBe(false);
  });

  it('resets miss counter on re-SUBSCRIBED after an error', () => {
    realtimeHealth.register('a', () => {});
    realtimeHealth.setStatus('a', 'SUBSCRIBED');
    realtimeHealth.markHeartbeatSent('a');
    realtimeHealth.markHeartbeatSent('a');

    realtimeHealth.setStatus('a', 'CHANNEL_ERROR');
    expect(realtimeHealth.isAnyDegraded()).toBe(true);

    realtimeHealth.setStatus('a', 'SUBSCRIBED');
    expect(realtimeHealth.isAnyDegraded()).toBe(false);
  });

  it('isAnyDegraded() is true if ANY channel is degraded', () => {
    realtimeHealth.register('a', () => {});
    realtimeHealth.register('b', () => {});
    realtimeHealth.setStatus('a', 'SUBSCRIBED');
    realtimeHealth.setStatus('b', 'SUBSCRIBED');
    expect(realtimeHealth.isAnyDegraded()).toBe(false);

    realtimeHealth.setStatus('b', 'CHANNEL_ERROR');
    expect(realtimeHealth.isAnyDegraded()).toBe(true);
  });

  it('reconnectAll() invokes every registered reconnector', () => {
    const reconnectA = vi.fn();
    const reconnectB = vi.fn();
    realtimeHealth.register('a', reconnectA);
    realtimeHealth.register('b', reconnectB);

    realtimeHealth.reconnectAll();
    expect(reconnectA).toHaveBeenCalledTimes(1);
    expect(reconnectB).toHaveBeenCalledTimes(1);
  });

  it('swallows errors thrown by reconnectors so one failure does not block the others', () => {
    const reconnectA = vi.fn(() => {
      throw new Error('nope');
    });
    const reconnectB = vi.fn();
    realtimeHealth.register('a', reconnectA);
    realtimeHealth.register('b', reconnectB);

    expect(() => realtimeHealth.reconnectAll()).not.toThrow();
    expect(reconnectB).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers on status change', () => {
    const listener = vi.fn();
    const unsub = realtimeHealth.subscribe(listener);

    realtimeHealth.register('a', () => {});
    realtimeHealth.setStatus('a', 'SUBSCRIBED');
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);

    unsub();
    const before = listener.mock.calls.length;
    realtimeHealth.setStatus('a', 'CHANNEL_ERROR');
    expect(listener.mock.calls.length).toBe(before);
  });

  it('unregister removes the channel from aggregate health', () => {
    realtimeHealth.register('a', () => {});
    realtimeHealth.register('b', () => {});
    realtimeHealth.setStatus('a', 'SUBSCRIBED');
    realtimeHealth.setStatus('b', 'CHANNEL_ERROR');
    expect(realtimeHealth.isAnyDegraded()).toBe(true);

    realtimeHealth.unregister('b');
    expect(realtimeHealth.isAnyDegraded()).toBe(false);
  });
});
