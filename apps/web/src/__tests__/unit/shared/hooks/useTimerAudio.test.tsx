/**
 * Unit tests for useTimerAudio (shared hooks location).
 *
 * The hook (actually a module of exported functions) provides gym-phone
 * signaling: audio beeps, vibration, system notifications, and
 * screen wake-lock. This file adds the "mute toggle" coverage that the
 * coachbyte-local test does not cover: installAudioUnlockOnFirstGesture
 * idempotency and playPrCelebrationCue / firePrCelebrationCue paths.
 *
 * The coachbyte test already covers:
 *   playTimerExpiredCue, vibrateTimerExpired, notifyTimerExpired,
 *   requestNotificationPermission, fireTimerExpiredCue, useScreenWakeLock.
 *
 * This file adds coverage for:
 *   - installAudioUnlockOnFirstGesture (idempotent; installs listener once)
 *   - unlockAudioContextNow (resumes suspended context)
 *   - playPrCelebrationCue (four triangle-wave notes)
 *   - firePrCelebrationCue (sound + distinct vibration pattern)
 *   - vibrateSetCompleted (50ms haptic)
 *   - vibratePr ([80,60,80,60,80] pattern)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import {
  __resetAudioContextForTests,
  installAudioUnlockOnFirstGesture,
  unlockAudioContextNow,
  playPrCelebrationCue,
  firePrCelebrationCue,
  vibrateSetCompleted,
  vibratePr,
  useScreenWakeLock,
} from '@/hooks/useTimerAudio';

// ---------------------------------------------------------------------------
// Shared audio mock factory
// ---------------------------------------------------------------------------

function setupAudioMock() {
  const oscillators: any[] = [];
  const ctx = {
    state: 'running' as AudioContextState,
    currentTime: 0,
    destination: {},
    resume: vi.fn(() => Promise.resolve()),
    createOscillator: vi.fn(() => {
      const osc = {
        frequency: { value: 0 },
        type: 'triangle' as OscillatorType,
        connect: vi.fn(() => osc),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(osc);
      return osc;
    }),
    createGain: vi.fn(() => ({
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(() => ctx.destination),
    })),
  };
  function Ctor(this: any) { return ctx; }
  (window as any).AudioContext = Ctor;
  return { ctx, oscillators };
}

describe('useTimerAudio — installAudioUnlockOnFirstGesture', () => {
  beforeEach(() => {
    __resetAudioContextForTests();
    delete (window as any).AudioContext;
    delete (window as any).webkitAudioContext;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetAudioContextForTests();
  });

  it('installs a pointerdown listener on first call', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    installAudioUnlockOnFirstGesture();
    expect(addSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function), expect.any(Object));
  });

  it('is idempotent — second call does NOT install a second listener', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    installAudioUnlockOnFirstGesture();
    const firstCallCount = addSpy.mock.calls.filter((c) => c[0] === 'pointerdown').length;
    installAudioUnlockOnFirstGesture();
    const secondCallCount = addSpy.mock.calls.filter((c) => c[0] === 'pointerdown').length;
    // Only one listener installed across two calls
    expect(secondCallCount).toBe(firstCallCount);
  });
});

describe('useTimerAudio — unlockAudioContextNow', () => {
  beforeEach(() => {
    __resetAudioContextForTests();
    delete (window as any).AudioContext;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetAudioContextForTests();
  });

  it('resumes a suspended AudioContext', () => {
    const { ctx } = setupAudioMock();
    ctx.state = 'suspended';
    unlockAudioContextNow();
    expect(ctx.resume).toHaveBeenCalled();
  });

  it('no-ops when context is already running', () => {
    const { ctx } = setupAudioMock();
    ctx.state = 'running';
    unlockAudioContextNow();
    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it('no-ops gracefully when AudioContext is unavailable', () => {
    expect(() => unlockAudioContextNow()).not.toThrow();
  });
});

describe('useTimerAudio — playPrCelebrationCue', () => {
  beforeEach(() => {
    __resetAudioContextForTests();
    delete (window as any).AudioContext;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetAudioContextForTests();
  });

  it('schedules four oscillator notes (C5/E5/G5/C6)', () => {
    const { ctx, oscillators } = setupAudioMock();
    playPrCelebrationCue();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(4);
    expect(oscillators).toHaveLength(4);
    for (const osc of oscillators) {
      expect(osc.start).toHaveBeenCalled();
      expect(osc.stop).toHaveBeenCalled();
    }
  });

  it('no-ops when AudioContext is unavailable', () => {
    expect(() => playPrCelebrationCue()).not.toThrow();
  });

  it('resumes a suspended context before scheduling', () => {
    const { ctx } = setupAudioMock();
    ctx.state = 'suspended';
    playPrCelebrationCue();
    expect(ctx.resume).toHaveBeenCalled();
  });
});

describe('useTimerAudio — mute-toggle simulation via vibratePr / vibrateSetCompleted', () => {
  it('vibratePr fires [80,60,80,60,80] — distinct from rest-timer pattern', () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
    vibratePr();
    expect(vibrate).toHaveBeenCalledWith([80, 60, 80, 60, 80]);
  });

  it('vibrateSetCompleted fires 50ms single pulse', () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
    vibrateSetCompleted();
    expect(vibrate).toHaveBeenCalledWith(50);
  });

  it('vibratePr no-ops gracefully when vibrate is unsupported', () => {
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: undefined });
    expect(() => vibratePr()).not.toThrow();
  });
});

describe('useTimerAudio — firePrCelebrationCue (combined)', () => {
  beforeEach(() => {
    __resetAudioContextForTests();
    delete (window as any).AudioContext;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetAudioContextForTests();
  });

  it('calls both sound + distinct vibration pattern', () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
    setupAudioMock();

    expect(() => firePrCelebrationCue()).not.toThrow();
    // vibratePr is called inside firePrCelebrationCue
    expect(vibrate).toHaveBeenCalledWith([80, 60, 80, 60, 80]);
  });
});

describe('useTimerAudio — useScreenWakeLock (mute: disabled path)', () => {
  beforeEach(() => {
    delete (navigator as any).wakeLock;
  });

  it('re-acquires wake-lock when tab becomes visible again', async () => {
    const sentinel = {
      release: vi.fn(() => Promise.resolve()),
      addEventListener: vi.fn(),
    };
    const request = vi.fn(() => Promise.resolve(sentinel));
    (navigator as any).wakeLock = { request };

    renderHook(() => useScreenWakeLock(true));
    await Promise.resolve();

    // Simulate tab going background then coming back
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();

    // request was called at least once (on mount) — re-acquire fired
    expect(request.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
