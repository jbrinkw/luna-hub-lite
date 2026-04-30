/**
 * useTimerAudio — unit tests for the gym-phone signaling hook
 * (audio + vibration + system notification + screen wake-lock).
 *
 * Covers the four cues that combine in `fireTimerExpiredCue()`:
 *   - playTimerExpiredCue uses Web Audio API (mocked)
 *   - vibrateTimerExpired calls navigator.vibrate
 *   - notifyTimerExpired creates a window.Notification
 *   - useScreenWakeLock acquires + releases navigator.wakeLock
 *
 * jsdom doesn't ship Web Audio / vibration / WakeLock, so each is
 * stubbed at the module / global level. The point of these tests is
 * to pin the contract, not to verify real-browser behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import {
  __resetAudioContextForTests,
  fireTimerExpiredCue,
  notifyTimerExpired,
  playTimerExpiredCue,
  requestNotificationPermission,
  useScreenWakeLock,
  vibrateTimerExpired,
} from '@/hooks/useTimerAudio';

// Audio mock — every oscillator/gain returns a stub so playTimerExpiredCue
// can exercise its "for each frequency, schedule oscillator" loop.
function setupAudioMock() {
  const oscillators: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];

  const ctx = {
    state: 'running' as AudioContextState,
    currentTime: 0,
    destination: {},
    resume: vi.fn(() => Promise.resolve()),
    createOscillator: vi.fn(() => {
      const osc = {
        frequency: { value: 0 },
        type: 'sine' as OscillatorType,
        connect: vi.fn(() => osc),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(osc as any);
      return osc;
    }),
    createGain: vi.fn(() => {
      const gain = {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(() => ctx.destination),
      };
      return gain;
    }),
  };

  // The hook calls `new Ctx()`. Use a real class that returns the
  // shared ctx stub from its constructor — vi.fn(() => ctx) confused
  // `new` semantics in earlier vitest versions.
  function Ctor(this: any) {
    return ctx;
  }
  (window as any).AudioContext = Ctor;
  return { ctx, oscillators, Ctor };
}

describe('useTimerAudio — playTimerExpiredCue', () => {
  beforeEach(() => {
    delete (window as any).AudioContext;
    delete (window as any).webkitAudioContext;
    __resetAudioContextForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetAudioContextForTests();
  });

  it('schedules three oscillator beeps when AudioContext is available', () => {
    const mock = setupAudioMock();
    playTimerExpiredCue();
    expect(mock.ctx.createOscillator).toHaveBeenCalledTimes(3);
    expect(mock.oscillators).toHaveLength(3);
    for (const osc of mock.oscillators) {
      expect(osc.start).toHaveBeenCalledTimes(1);
      expect(osc.stop).toHaveBeenCalledTimes(1);
    }
  });

  it('no-ops gracefully when AudioContext is unavailable', () => {
    expect(() => playTimerExpiredCue()).not.toThrow();
  });

  it('resumes a suspended AudioContext before scheduling', () => {
    const mock = setupAudioMock();
    mock.ctx.state = 'suspended';
    playTimerExpiredCue();
    expect(mock.ctx.resume).toHaveBeenCalledTimes(1);
  });
});

describe('useTimerAudio — vibrateTimerExpired', () => {
  it('calls navigator.vibrate with [200,100,200] when supported', () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
    vibrateTimerExpired();
    expect(vibrate).toHaveBeenCalledWith([200, 100, 200]);
  });

  it('no-ops when navigator.vibrate is unavailable', () => {
    const desc = Object.getOwnPropertyDescriptor(navigator, 'vibrate');
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: undefined });
    expect(() => vibrateTimerExpired()).not.toThrow();
    if (desc) Object.defineProperty(navigator, 'vibrate', desc);
  });
});

describe('useTimerAudio — notifyTimerExpired', () => {
  it('does not throw when Notification is unsupported', () => {
    const desc = Object.getOwnPropertyDescriptor(window, 'Notification');
    delete (window as any).Notification;
    expect(() => notifyTimerExpired()).not.toThrow();
    if (desc) Object.defineProperty(window, 'Notification', desc);
  });

  it('creates a Notification when permission is granted', () => {
    const ctor = vi.fn();
    (ctor as any).permission = 'granted';
    (window as any).Notification = ctor;
    notifyTimerExpired('Title', 'Body');
    expect(ctor).toHaveBeenCalledWith('Title', expect.objectContaining({ body: 'Body' }));
    delete (window as any).Notification;
  });

  it('does NOT create a Notification when permission is default (un-granted)', () => {
    const ctor = vi.fn();
    (ctor as any).permission = 'default';
    (window as any).Notification = ctor;
    notifyTimerExpired();
    expect(ctor).not.toHaveBeenCalled();
    delete (window as any).Notification;
  });
});

describe('useTimerAudio — requestNotificationPermission', () => {
  it('returns "unsupported" when Notification is missing', async () => {
    delete (window as any).Notification;
    const result = await requestNotificationPermission();
    expect(result).toBe('unsupported');
  });

  it('returns existing permission without re-prompting', async () => {
    const ctor: any = vi.fn();
    ctor.permission = 'granted';
    ctor.requestPermission = vi.fn();
    (window as any).Notification = ctor;
    const result = await requestNotificationPermission();
    expect(result).toBe('granted');
    expect(ctor.requestPermission).not.toHaveBeenCalled();
    delete (window as any).Notification;
  });

  it('requests permission when in default state', async () => {
    const ctor: any = vi.fn();
    ctor.permission = 'default';
    ctor.requestPermission = vi.fn(() => Promise.resolve('granted'));
    (window as any).Notification = ctor;
    const result = await requestNotificationPermission();
    expect(ctor.requestPermission).toHaveBeenCalledTimes(1);
    expect(result).toBe('granted');
    delete (window as any).Notification;
  });
});

describe('useTimerAudio — fireTimerExpiredCue', () => {
  beforeEach(() => {
    __resetAudioContextForTests();
  });
  afterEach(() => {
    __resetAudioContextForTests();
  });
  it('combines audio + vibration + notification in one call', () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
    setupAudioMock();
    expect(() => fireTimerExpiredCue()).not.toThrow();
    expect(vibrate).toHaveBeenCalledWith([200, 100, 200]);
  });
});

describe('useTimerAudio — useScreenWakeLock', () => {
  beforeEach(() => {
    delete (navigator as any).wakeLock;
  });

  it('does not throw when wakeLock is unsupported', () => {
    const { unmount } = renderHook(() => useScreenWakeLock(true));
    expect(() => unmount()).not.toThrow();
  });

  it('requests wakeLock when enabled flips to true', async () => {
    const sentinel = {
      release: vi.fn(() => Promise.resolve()),
      addEventListener: vi.fn(),
    };
    const request = vi.fn(() => Promise.resolve(sentinel));
    (navigator as any).wakeLock = { request };

    const { unmount } = renderHook(() => useScreenWakeLock(true));
    // Effect runs synchronously, but wakeLock.request is async — wait
    // for a microtask to drain.
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith('screen');
    unmount();
  });

  it('releases wakeLock on unmount', async () => {
    const release = vi.fn(() => Promise.resolve());
    const sentinel = { release, addEventListener: vi.fn() };
    const request = vi.fn(() => Promise.resolve(sentinel));
    (navigator as any).wakeLock = { request };

    const { unmount } = renderHook(() => useScreenWakeLock(true));
    await Promise.resolve();
    unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not request wakeLock when disabled', async () => {
    const request = vi.fn(() => Promise.resolve({}));
    (navigator as any).wakeLock = { request };
    renderHook(() => useScreenWakeLock(false));
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  });
});
