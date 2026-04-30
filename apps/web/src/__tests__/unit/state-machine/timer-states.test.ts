/**
 * Timer state machine matrix tests.
 *
 * Cross-product: (current_state × event) → expected next state.
 *
 * The production state machine lives in the DB (private.*_timer RPCs,
 * migration 20260425040000_timer_state_machine_rpcs.sql). The client
 * dispatchers in TodayPage are thin wrappers that call those RPCs via
 * Supabase. This test layer verifies:
 *
 *   1. Happy-path transitions produce the expected RPC name + args.
 *   2. The dispatchers correctly surface or swallow RPC guard rejections
 *      (e.g. expireTimerRpc swallows "cannot expire" errors; others
 *      surface them).
 *   3. Illegal transitions (e.g. pause from idle, resume from expired)
 *      surface the guard message — not crash, not silent success.
 *
 * "Idle" is represented by a null/undefined timer row; the client
 * always calls the RPC and lets the DB guard handle the rejection. This
 * is intentional per the architecture: no client-side guard duplication.
 *
 * States:  idle (no row), running, paused, expired
 * Events:  set, pause, resume, reset, tick_to_zero (expire), extend
 */

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by vitest before imports)
// ---------------------------------------------------------------------------
// TodayPage imports supabase + AuthProvider at module load time. Provide
// minimal stubs so the module resolves without a real Supabase instance.
// These mocks only affect the module graph — all tests use the explicit
// mock client passed into each RPC function.
vi.mock('@/shared/supabase', () => ({
  supabase: {},
  coachbyte: () => ({ rpc: vi.fn() }),
  chefbyte: () => ({}),
}));

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: vi.fn(() => ({ user: null, session: null })),
  AuthProvider: ({ children }: any) => children,
}));

vi.mock('@/shared/useRealtimeInvalidation', () => ({
  useRealtimeInvalidation: vi.fn(),
}));

vi.mock('@/hooks/useTimerAudio', () => ({
  fireTimerExpiredCue: vi.fn(),
  firePrCelebrationCue: vi.fn(),
  installAudioUnlockOnFirstGesture: vi.fn(),
  requestNotificationPermission: vi.fn(),
  unlockAudioContextNow: vi.fn(),
  useScreenWakeLock: vi.fn(() => ({ wakeLockActive: false })),
  vibrateSetCompleted: vi.fn(),
}));

import {
  startTimerRpc,
  pauseTimerRpc,
  resumeTimerRpc,
  resetTimerRpc,
  expireTimerRpc,
  extendTimerRpc,
  DEFAULT_TIMER,
  type TimerState,
} from '@/pages/coachbyte/TodayPage';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal Supabase client mock that routes schema('coachbyte').rpc(name)
 * to the given response map. If a name is not in the map, returns a success
 * response (no error, null data) so unregistered calls don't crash the test.
 */
function makeClient(responses: Record<string, { data?: unknown; error: { message: string } | null }>) {
  const rpc = vi.fn((name: string, _params?: unknown) =>
    Promise.resolve(responses[name] ?? { data: null, error: null }),
  );
  const schema = vi.fn(() => ({ rpc }));
  return { client: { schema } as any, schema, rpc };
}

const OK = { data: null, error: null };

// Guard rejection message patterns emitted by the DB RPCs.
const GUARD = {
  pause_not_running: (state: string) => ({
    data: null,
    error: { message: `pause_timer: cannot pause timer in state ${state} (must be running)` },
  }),
  resume_not_paused: (state: string) => ({
    data: null,
    error: { message: `resume_timer: cannot resume timer in state ${state} (must be paused)` },
  }),
  expire_not_running: (state: string) => ({
    data: null,
    error: { message: `expire_timer: cannot expire timer in state ${state} (must be running)` },
  }),
  expire_not_due: () => ({ data: null, error: { message: 'expire_timer: timer has not reached end_time yet' } }),
  pause_no_timer: () => ({ data: null, error: { message: 'pause_timer: no active timer' } }),
  resume_no_timer: () => ({ data: null, error: { message: 'resume_timer: no active timer' } }),
  expire_no_timer: () => ({ data: null, error: { message: 'expire_timer: no active timer' } }),
  start_bad_duration: () => ({
    data: null,
    error: { message: 'start_timer: duration_seconds must be positive (got 0)' },
  }),
};

// ---------------------------------------------------------------------------
// 1. SET (start_timer) — valid from any state including idle
// ---------------------------------------------------------------------------

describe('event: set (startTimerRpc)', () => {
  it('idle → running: calls start_timer with duration_seconds', async () => {
    const m = makeClient({ start_timer: OK });
    const result = await startTimerRpc(60, m.client);
    expect(m.schema).toHaveBeenCalledWith('coachbyte');
    expect(m.rpc).toHaveBeenCalledWith('start_timer', { p_duration_seconds: 60 });
    expect(result.error).toBeNull();
  });

  it('running → running: start_timer replaces the timer (upsert semantics)', async () => {
    const m = makeClient({ start_timer: OK });
    const result = await startTimerRpc(90, m.client);
    expect(m.rpc).toHaveBeenCalledWith('start_timer', { p_duration_seconds: 90 });
    expect(result.error).toBeNull();
  });

  it('paused → running: start_timer replaces a paused timer', async () => {
    const m = makeClient({ start_timer: OK });
    const result = await startTimerRpc(120, m.client);
    expect(m.rpc).toHaveBeenCalledWith('start_timer', { p_duration_seconds: 120 });
    expect(result.error).toBeNull();
  });

  it('expired → running: start_timer replaces an expired timer', async () => {
    const m = makeClient({ start_timer: OK });
    const result = await startTimerRpc(30, m.client);
    expect(m.rpc).toHaveBeenCalledWith('start_timer', { p_duration_seconds: 30 });
    expect(result.error).toBeNull();
  });

  it('guard: duration=0 surfaces the DB guard message', async () => {
    const m = makeClient({ start_timer: GUARD.start_bad_duration() });
    const result = await startTimerRpc(0, m.client);
    expect(result.error).toContain('must be positive');
  });

  it('guard: negative duration surfaces the DB guard message', async () => {
    const m = makeClient({
      start_timer: { data: null, error: { message: 'start_timer: duration_seconds must be positive (got -5)' } },
    });
    const result = await startTimerRpc(-5, m.client);
    expect(result.error).toContain('must be positive');
  });
});

// ---------------------------------------------------------------------------
// 2. PAUSE (pause_timer) — only valid from running
// ---------------------------------------------------------------------------

describe('event: pause (pauseTimerRpc)', () => {
  it('running → paused: calls pause_timer with no args', async () => {
    const m = makeClient({ pause_timer: OK });
    const result = await pauseTimerRpc(m.client);
    expect(m.schema).toHaveBeenCalledWith('coachbyte');
    expect(m.rpc).toHaveBeenCalledWith('pause_timer');
    expect(result.error).toBeNull();
  });

  it('idle → guard: surfaces "no active timer" when no row exists', async () => {
    const m = makeClient({ pause_timer: GUARD.pause_no_timer() });
    const result = await pauseTimerRpc(m.client);
    expect(result.error).toContain('no active timer');
  });

  it('paused → guard: surfaces "cannot pause in state paused"', async () => {
    const m = makeClient({ pause_timer: GUARD.pause_not_running('paused') });
    const result = await pauseTimerRpc(m.client);
    expect(result.error).toContain('cannot pause timer in state paused');
  });

  it('expired → guard: surfaces "cannot pause in state expired"', async () => {
    const m = makeClient({ pause_timer: GUARD.pause_not_running('expired') });
    const result = await pauseTimerRpc(m.client);
    expect(result.error).toContain('cannot pause timer in state expired');
  });

  it('guard: state is preserved (no silent mutation on rejection)', async () => {
    // The client does not mutate local state — the DB guard ensures the row
    // is unchanged. We verify the dispatcher surfaces the error string
    // so the UI caller can read it.
    const m = makeClient({ pause_timer: GUARD.pause_not_running('paused') });
    const result = await pauseTimerRpc(m.client);
    expect(result.error).not.toBeNull();
    // Only one RPC call — no retry attempted.
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 3. RESUME (resume_timer) — only valid from paused
// ---------------------------------------------------------------------------

describe('event: resume (resumeTimerRpc)', () => {
  it('paused → running: calls resume_timer with no args', async () => {
    const m = makeClient({ resume_timer: OK });
    const result = await resumeTimerRpc(m.client);
    expect(m.schema).toHaveBeenCalledWith('coachbyte');
    expect(m.rpc).toHaveBeenCalledWith('resume_timer');
    expect(result.error).toBeNull();
  });

  it('idle → guard: surfaces "no active timer" when no row exists', async () => {
    const m = makeClient({ resume_timer: GUARD.resume_no_timer() });
    const result = await resumeTimerRpc(m.client);
    expect(result.error).toContain('no active timer');
  });

  it('running → guard: surfaces "cannot resume in state running"', async () => {
    const m = makeClient({ resume_timer: GUARD.resume_not_paused('running') });
    const result = await resumeTimerRpc(m.client);
    expect(result.error).toContain('cannot resume timer in state running');
  });

  it('expired → guard: surfaces "cannot resume in state expired"', async () => {
    const m = makeClient({ resume_timer: GUARD.resume_not_paused('expired') });
    const result = await resumeTimerRpc(m.client);
    expect(result.error).toContain('cannot resume timer in state expired');
  });

  it('guard: no retry on rejection', async () => {
    const m = makeClient({ resume_timer: GUARD.resume_not_paused('running') });
    await resumeTimerRpc(m.client);
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. RESET (reset_timer) — valid from any state (soft-noop when idle)
// ---------------------------------------------------------------------------

describe('event: reset (resetTimerRpc)', () => {
  it('running → idle: calls reset_timer and returns no error', async () => {
    const m = makeClient({ reset_timer: OK });
    const result = await resetTimerRpc(m.client);
    expect(m.schema).toHaveBeenCalledWith('coachbyte');
    expect(m.rpc).toHaveBeenCalledWith('reset_timer');
    expect(result.error).toBeNull();
  });

  it('paused → idle: reset from paused state succeeds', async () => {
    const m = makeClient({ reset_timer: OK });
    const result = await resetTimerRpc(m.client);
    expect(result.error).toBeNull();
  });

  it('expired → idle: reset from expired state succeeds', async () => {
    const m = makeClient({ reset_timer: OK });
    const result = await resetTimerRpc(m.client);
    expect(result.error).toBeNull();
  });

  it('idle → idle (no row): reset is a soft-noop — no error', async () => {
    // DB returns 0 rows deleted — the dispatcher surfaces no error.
    const m = makeClient({ reset_timer: { data: 0, error: null } });
    const result = await resetTimerRpc(m.client);
    expect(result.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. TICK_TO_ZERO (expire_timer) — only valid from running when end_time <= now
// ---------------------------------------------------------------------------

describe('event: tick_to_zero (expireTimerRpc)', () => {
  it('running (due) → expired: calls expire_timer and returns no error', async () => {
    const m = makeClient({ expire_timer: OK });
    const result = await expireTimerRpc(m.client);
    expect(m.schema).toHaveBeenCalledWith('coachbyte');
    expect(m.rpc).toHaveBeenCalledWith('expire_timer');
    expect(result.error).toBeNull();
  });

  it('running (not due) → guard: surfaces end_time error (not a "cannot expire" guard)', async () => {
    // "has not reached end_time yet" is NOT the "cannot expire" pattern —
    // the dispatcher must surface it.
    const m = makeClient({ expire_timer: GUARD.expire_not_due() });
    const result = await expireTimerRpc(m.client);
    expect(result.error).toContain('has not reached end_time yet');
  });

  it('paused → guard swallowed: "cannot expire in state paused" is swallowed (race with UI)', async () => {
    const m = makeClient({ expire_timer: GUARD.expire_not_running('paused') });
    const result = await expireTimerRpc(m.client);
    // expireTimerRpc swallows "cannot expire" guard messages — race between
    // wall-clock tick and user pause/reset is expected and silent.
    expect(result.error).toBeNull();
  });

  it('expired → guard swallowed: "cannot expire in state expired" is swallowed', async () => {
    const m = makeClient({ expire_timer: GUARD.expire_not_running('expired') });
    const result = await expireTimerRpc(m.client);
    expect(result.error).toBeNull();
  });

  it('idle → guard swallowed: "no active timer" is NOT a "cannot expire" match — surfaced', async () => {
    const m = makeClient({ expire_timer: GUARD.expire_no_timer() });
    const result = await expireTimerRpc(m.client);
    // "no active timer" doesn't contain "cannot expire" so it IS surfaced.
    expect(result.error).toContain('no active timer');
  });
});

// ---------------------------------------------------------------------------
// 6. EXTEND (extendTimerRpc) — computed locally then delegates to startTimerRpc
// ---------------------------------------------------------------------------

describe('event: extend (extendTimerRpc)', () => {
  const futureEndTime = new Date(Date.now() + 30_000).toISOString(); // 30 s from now

  it('running → running: computes remaining + extra and calls start_timer', async () => {
    const m = makeClient({ start_timer: OK });
    const timer: TimerState = {
      state: 'running',
      end_time: futureEndTime,
      duration_seconds: 60,
      elapsed_before_pause: 0,
    };
    const result = await extendTimerRpc(timer, 30, m.client);
    expect(result.error).toBeNull();
    expect(m.rpc).toHaveBeenCalledWith(
      'start_timer',
      expect.objectContaining({
        p_duration_seconds: expect.any(Number),
      }),
    );
    // The new duration is remaining (~30s) + 30 = ~60s. Allow ±2s tolerance.
    const called = m.rpc.mock.calls[0][1] as { p_duration_seconds: number };
    expect(called.p_duration_seconds).toBeGreaterThanOrEqual(58);
    expect(called.p_duration_seconds).toBeLessThanOrEqual(62);
  });

  it('paused → running: uses elapsed_before_pause to compute remaining', async () => {
    const m = makeClient({ start_timer: OK });
    const timer: TimerState = {
      state: 'paused',
      end_time: null,
      duration_seconds: 60,
      elapsed_before_pause: 20,
    };
    // remaining = 60 - 20 = 40; extra = 30; new = 70
    const result = await extendTimerRpc(timer, 30, m.client);
    expect(result.error).toBeNull();
    const called = m.rpc.mock.calls[0][1] as { p_duration_seconds: number };
    expect(called.p_duration_seconds).toBe(70);
  });

  it('idle/expired → no-op: returns null error without calling start_timer', async () => {
    const m = makeClient({ start_timer: OK });
    const timer: TimerState = { ...DEFAULT_TIMER };
    const result = await extendTimerRpc(timer, 30, m.client);
    expect(result.error).toBeNull();
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7. Full transition matrix — 5 states × 5 core events = 25 cells
//    Documents expected outcome (success | error_keyword) for every cell.
// ---------------------------------------------------------------------------

describe('full state×event matrix (25 cells)', () => {
  type State = 'idle' | 'running' | 'paused' | 'expired' | 'running_not_due';
  type Event = 'set' | 'pause' | 'resume' | 'reset' | 'tick_to_zero';

  type Cell = {
    state: State;
    event: Event;
    expectSuccess: boolean;
    errorFragment?: string;
  };

  const matrix: Cell[] = [
    // --- set ---
    { state: 'idle', event: 'set', expectSuccess: true },
    { state: 'running', event: 'set', expectSuccess: true },
    { state: 'paused', event: 'set', expectSuccess: true },
    { state: 'expired', event: 'set', expectSuccess: true },
    { state: 'running_not_due', event: 'set', expectSuccess: true },

    // --- pause ---
    { state: 'idle', event: 'pause', expectSuccess: false, errorFragment: 'no active timer' },
    { state: 'running', event: 'pause', expectSuccess: true },
    { state: 'paused', event: 'pause', expectSuccess: false, errorFragment: 'cannot pause' },
    { state: 'expired', event: 'pause', expectSuccess: false, errorFragment: 'cannot pause' },
    { state: 'running_not_due', event: 'pause', expectSuccess: true },

    // --- resume ---
    { state: 'idle', event: 'resume', expectSuccess: false, errorFragment: 'no active timer' },
    { state: 'running', event: 'resume', expectSuccess: false, errorFragment: 'cannot resume' },
    { state: 'paused', event: 'resume', expectSuccess: true },
    { state: 'expired', event: 'resume', expectSuccess: false, errorFragment: 'cannot resume' },
    { state: 'running_not_due', event: 'resume', expectSuccess: false, errorFragment: 'cannot resume' },

    // --- reset ---
    { state: 'idle', event: 'reset', expectSuccess: true },
    { state: 'running', event: 'reset', expectSuccess: true },
    { state: 'paused', event: 'reset', expectSuccess: true },
    { state: 'expired', event: 'reset', expectSuccess: true },
    { state: 'running_not_due', event: 'reset', expectSuccess: true },

    // --- tick_to_zero (expire) ---
    // idle: "no active timer" — surfaced (not a "cannot expire" message)
    { state: 'idle', event: 'tick_to_zero', expectSuccess: false, errorFragment: 'no active timer' },
    // running (due): happy path
    { state: 'running', event: 'tick_to_zero', expectSuccess: true },
    // paused: "cannot expire" — swallowed by expireTimerRpc
    { state: 'paused', event: 'tick_to_zero', expectSuccess: true },
    // expired: "cannot expire" — swallowed
    { state: 'expired', event: 'tick_to_zero', expectSuccess: true },
    // running not due: "has not reached end_time" — surfaced
    {
      state: 'running_not_due',
      event: 'tick_to_zero',
      expectSuccess: false,
      errorFragment: 'has not reached end_time',
    },
  ];

  // RPC response per (state, event) cell.
  function responseFor(
    state: State,
    event: Event,
  ): Record<string, { data?: unknown; error: { message: string } | null }> {
    switch (event) {
      case 'set':
        return { start_timer: OK };
      case 'reset':
        return { reset_timer: OK };
      case 'pause':
        if (state === 'idle') return { pause_timer: GUARD.pause_no_timer() };
        if (state === 'running' || state === 'running_not_due') return { pause_timer: OK };
        return { pause_timer: GUARD.pause_not_running(state) };
      case 'resume':
        if (state === 'idle') return { resume_timer: GUARD.resume_no_timer() };
        if (state === 'paused') return { resume_timer: OK };
        return { resume_timer: GUARD.resume_not_paused(state === 'running_not_due' ? 'running' : state) };
      case 'tick_to_zero':
        if (state === 'idle') return { expire_timer: GUARD.expire_no_timer() };
        if (state === 'running') return { expire_timer: OK };
        if (state === 'running_not_due') return { expire_timer: GUARD.expire_not_due() };
        return { expire_timer: GUARD.expire_not_running(state) };
    }
  }

  async function fireEvent(event: Event, client: any): Promise<{ error: string | null }> {
    switch (event) {
      case 'set':
        return startTimerRpc(60, client);
      case 'pause':
        return pauseTimerRpc(client);
      case 'resume':
        return resumeTimerRpc(client);
      case 'reset':
        return resetTimerRpc(client);
      case 'tick_to_zero':
        return expireTimerRpc(client);
    }
  }

  for (const cell of matrix) {
    const { state, event, expectSuccess, errorFragment } = cell;
    it(`${state} × ${event} → ${expectSuccess ? 'success' : `error(${errorFragment})`}`, async () => {
      const m = makeClient(responseFor(state, event));
      const result = await fireEvent(event, m.client);
      if (expectSuccess) {
        expect(result.error).toBeNull();
      } else {
        expect(result.error).not.toBeNull();
        if (errorFragment) {
          expect(result.error).toContain(errorFragment);
        }
      }
    });
  }
});
