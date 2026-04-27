import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { realtimeHealth, INITIAL_CONNECT_GRACE_MS } from '../../../shared/realtimeHealth';

describe('realtimeHealth singleton', () => {
  beforeEach(() => {
    realtimeHealth._resetForTests();
  });

  it('does NOT mark a freshly-registered channel as degraded (initial-connect grace window)', () => {
    // Bug fix: previously, register() set degraded=true immediately and the
    // banner would flash on every page load before the channel reached
    // SUBSCRIBED. The grace window suppresses that flash.
    realtimeHealth.register('chef:stock_lots', () => {});
    expect(realtimeHealth.isAnyDegraded()).toBe(false);

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

  it('flips to degraded immediately on a terminal error during the grace window', () => {
    // Even though we're within the initial-connect grace window, a terminal
    // error means the channel is genuinely broken — surface it immediately.
    realtimeHealth.register('a', () => {});
    expect(realtimeHealth.isAnyDegraded()).toBe(false);

    realtimeHealth.setStatus('a', 'CHANNEL_ERROR', 'boom');
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

describe('realtimeHealth — initial-connect grace window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    realtimeHealth._resetForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a CONNECTING channel non-degraded inside the grace window', () => {
    realtimeHealth.register('a', () => {});
    expect(realtimeHealth.isAnyDegraded()).toBe(false);

    // Advance halfway through the grace window — still healthy ("connecting…").
    vi.advanceTimersByTime(INITIAL_CONNECT_GRACE_MS / 2);
    expect(realtimeHealth.isAnyDegraded()).toBe(false);
  });

  it('flips a still-CONNECTING channel to degraded after the grace window expires', () => {
    realtimeHealth.register('a', () => {});
    expect(realtimeHealth.isAnyDegraded()).toBe(false);

    // Advance past the grace window without ever reaching SUBSCRIBED.
    vi.advanceTimersByTime(INITIAL_CONNECT_GRACE_MS + 100);
    expect(realtimeHealth.isAnyDegraded()).toBe(true);
  });

  it('notifies listeners when the grace timer fires', () => {
    const listener = vi.fn();
    realtimeHealth.subscribe(listener);

    realtimeHealth.register('a', () => {});
    const callsBefore = listener.mock.calls.length;

    vi.advanceTimersByTime(INITIAL_CONNECT_GRACE_MS + 100);
    // The grace timer should have called emit() — listener fires again.
    expect(listener.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('cancels the grace timer once SUBSCRIBED arrives (no spurious flip)', () => {
    realtimeHealth.register('a', () => {});
    realtimeHealth.setStatus('a', 'SUBSCRIBED');
    expect(realtimeHealth.isAnyDegraded()).toBe(false);

    // Even after the grace window would have elapsed, the channel stays healthy.
    vi.advanceTimersByTime(INITIAL_CONNECT_GRACE_MS + 5_000);
    expect(realtimeHealth.isAnyDegraded()).toBe(false);
  });

  it('does NOT re-grant a grace window after a mid-session disconnect', () => {
    // First connect succeeds within grace.
    realtimeHealth.register('a', () => {});
    realtimeHealth.setStatus('a', 'SUBSCRIBED');
    expect(realtimeHealth.isAnyDegraded()).toBe(false);

    // Mid-session: socket drops, channel re-enters CONNECTING. The everSubscribed
    // pin means we do NOT treat this like a fresh page load — banner should
    // surface promptly, not wait another 3s.
    realtimeHealth.setStatus('a', 'CLOSED');
    expect(realtimeHealth.isAnyDegraded()).toBe(true);

    realtimeHealth.setStatus('a', 'CONNECTING');
    expect(realtimeHealth.isAnyDegraded()).toBe(true);
  });

  it('terminal error during grace window flips immediately (does not wait for grace to expire)', () => {
    realtimeHealth.register('a', () => {});
    expect(realtimeHealth.isAnyDegraded()).toBe(false);

    // Half a tick into the grace window, the channel hits CHANNEL_ERROR.
    vi.advanceTimersByTime(500);
    realtimeHealth.setStatus('a', 'CHANNEL_ERROR', 'bad publication');
    expect(realtimeHealth.isAnyDegraded()).toBe(true);
  });

  it('three missed heartbeats during grace window override the grace and mark degraded', () => {
    realtimeHealth.register('a', () => {});
    expect(realtimeHealth.isAnyDegraded()).toBe(false);

    realtimeHealth.markHeartbeatSent('a');
    realtimeHealth.markHeartbeatSent('a');
    realtimeHealth.markHeartbeatSent('a');
    expect(realtimeHealth.isAnyDegraded()).toBe(true);
  });
});
