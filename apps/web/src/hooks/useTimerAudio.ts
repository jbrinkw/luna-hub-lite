/**
 * useTimerAudio — gym-phone signaling for the rest timer.
 *
 * Plugs into the Today page so that when the rest timer reaches 0 the
 * user gets all four cues simultaneously:
 *   1. Audio beep        — Web Audio API oscillator burst (no asset file)
 *   2. Vibration         — navigator.vibrate([200, 100, 200])
 *   3. System notification — desktop / Android notification banner
 *   4. (caller-managed wake-lock) see useScreenWakeLock below
 *
 * The hook is split into two pieces because they have different
 * lifecycle needs:
 *   - playTimerExpiredCue() fires once on the running→expired edge
 *   - useScreenWakeLock keeps the screen awake while a workout session
 *     is active. Released on unmount or when explicitly disabled.
 *
 * Browser nuances:
 *   - AudioContext can't start until a user gesture; we lazy-init on
 *     the first call and ignore "NotAllowedError" so SSR/jsdom tests
 *     don't crash.
 *   - Notifications require permission. The hook auto-requests on
 *     first use and silently no-ops if denied.
 *   - WakeLock is whatwg/Chrome-only; Safari iOS has it from 16.4+.
 *     We detect with `'wakeLock' in navigator` and gracefully skip.
 */

import { useCallback, useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Audio — single shared AudioContext (lazy init)
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (audioCtx) return audioCtx;
  if (typeof window === 'undefined') return null;
  try {
    const Ctx =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ??
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
    return audioCtx;
  } catch {
    return null;
  }
}

/** TEST-ONLY: clear the cached AudioContext so the next call to
 * `getAudioContext` re-runs the lazy init. Lets tests stub
 * `window.AudioContext` and verify the init path. */
export function __resetAudioContextForTests(): void {
  audioCtx = null;
}

/** Play a short triple-beep cue (660 Hz, 880 Hz, 660 Hz). */
export function playTimerExpiredCue(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  // Some browsers (Chrome 71+) put the context into "suspended" state
  // until a user gesture; we resume opportunistically.
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {
      /* ignore — will retry on next call */
    });
  }

  const now = ctx.currentTime;
  const beepFreqs = [660, 880, 660];
  const beepDuration = 0.18;
  const beepGap = 0.07;

  beepFreqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    const start = now + i * (beepDuration + beepGap);
    const stop = start + beepDuration;
    // Fade-in/out envelope to avoid clicks
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.35, start + 0.02);
    gain.gain.setValueAtTime(0.35, stop - 0.04);
    gain.gain.linearRampToValueAtTime(0, stop);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(stop);
  });
}

// ---------------------------------------------------------------------------
// Vibration
// ---------------------------------------------------------------------------

/** Trigger a 200-100-200ms vibration pulse. No-op if unsupported. */
export function vibrateTimerExpired(): void {
  if (typeof navigator === 'undefined') return;
  if (typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate([200, 100, 200]);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// System notification
// ---------------------------------------------------------------------------

/** Try to request Notification permission once. Idempotent. */
export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  const N = window.Notification;
  if (N.permission === 'granted' || N.permission === 'denied') return N.permission;
  try {
    return await N.requestPermission();
  } catch {
    return 'denied';
  }
}

/** Send a "rest timer expired" desktop / mobile system notification. */
export function notifyTimerExpired(title = 'Rest complete', body = "You're up — log your next set"): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  const N = window.Notification;
  if (N.permission !== 'granted') return;
  try {
    new N(title, { body, tag: 'coachbyte-rest-timer', silent: false });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Combined cue — fires all three signals at once
// ---------------------------------------------------------------------------

/**
 * Fire all four "your rest is over" signals at once. Safe to call on
 * every running→expired edge; callers should debounce by tracking state
 * transitions so it doesn't repeat each second.
 */
export function fireTimerExpiredCue(): void {
  playTimerExpiredCue();
  vibrateTimerExpired();
  notifyTimerExpired();
}

// ---------------------------------------------------------------------------
// useScreenWakeLock — keep the screen awake while a workout is active
// ---------------------------------------------------------------------------

/**
 * Acquire a `screen` wake-lock while `enabled` is true and release it
 * when the component unmounts or `enabled` flips false. Re-acquires on
 * tab visibility-change ("visible") because the browser auto-releases
 * the lock when the tab is backgrounded.
 *
 * Returns `{ active: boolean }` for tests / debug UI.
 */
export function useScreenWakeLock(enabled: boolean): { active: { current: boolean } } {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const activeRef = useRef(false);

  const release = useCallback(() => {
    const s = sentinelRef.current;
    sentinelRef.current = null;
    activeRef.current = false;
    if (s) {
      s.release().catch(() => {
        /* ignore */
      });
    }
  }, []);

  const acquire = useCallback(async () => {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    if (sentinelRef.current) return;
    try {
      const sentinel = await (
        navigator as Navigator & {
          wakeLock: { request: (type: 'screen') => Promise<WakeLockSentinel> };
        }
      ).wakeLock.request('screen');
      sentinelRef.current = sentinel;
      activeRef.current = true;
      sentinel.addEventListener?.('release', () => {
        activeRef.current = false;
        sentinelRef.current = null;
      });
    } catch {
      /* permission denied / unsupported */
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      release();
      return;
    }
    void acquire();

    const onVisible = () => {
      if (!enabled) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' && !sentinelRef.current) {
        void acquire();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
      release();
    };
  }, [enabled, acquire, release]);

  return { active: activeRef };
}

// Minimal type for wake-lock sentinel — TS lib.dom doesn't always
// include WakeLockSentinel; declare just enough to compile.
interface WakeLockSentinel {
  release: () => Promise<void>;
  addEventListener?: (type: 'release', listener: () => void) => void;
}
