import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '../types';
import { setTimer } from '../coachbyte/set-timer';
import { pauseTimer } from '../coachbyte/pause-timer';
import { resumeTimer } from '../coachbyte/resume-timer';
import { resetTimer } from '../coachbyte/reset-timer';
import { getTimer } from '../coachbyte/get-timer';

// Unit tests for the CoachByte timer tool handlers.
//
// These tests mock the Supabase client and assert that every handler
// dispatches to the DB state-machine RPCs introduced in
// 20260425040000_timer_state_machine_rpcs.sql instead of writing
// directly to coachbyte.timers. The goal is a contract test between the
// handler and the DB layer: if someone reverts a handler back to a
// direct UPDATE / UPSERT / DELETE, the corresponding test fails because
// rpc(...) is not invoked with the expected args.

function parseText(result: { content: Array<{ text: string }>; isError?: boolean }): any {
  return JSON.parse(result.content[0].text);
}

/**
 * Build a mock Supabase client whose .schema('coachbyte').rpc(name, args)
 * chain returns `{ data, error }` from the per-call map. For the
 * get-timer handler we also mock .from('timers').select().eq().maybeSingle()
 * since that path is a pure read (no state transition).
 */
function mockSupabase(opts: {
  rpcResponses: Partial<Record<string, { data: any; error: any }>>;
  selectTimerRow?: { data: any; error: any };
}) {
  const rpc = vi.fn((name: string, _args?: unknown) => {
    const resp = opts.rpcResponses[name];
    if (!resp) {
      throw new Error(`unexpected rpc call: ${name}`);
    }
    return Promise.resolve(resp);
  });

  const maybeSingle = vi.fn(() => Promise.resolve(opts.selectTimerRow ?? { data: null, error: null }));
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));

  const schema = vi.fn(() => ({ rpc, from }));
  return { schema, rpc } as any;
}

function makeCtx(supabase: any): ToolContext {
  return { userId: '00000000-0000-0000-0000-000000000001', supabase };
}

describe('CoachByte timer handlers dispatch to state-machine RPCs', () => {
  // ──────────────────────────── set_timer ────────────────────────────
  describe('setTimer → start_timer RPC', () => {
    it('calls rpc("start_timer", { p_duration_seconds }) and returns the row', async () => {
      const row = {
        timer_id: 't-1',
        state: 'running',
        duration_seconds: 120,
        end_time: new Date(Date.now() + 120_000).toISOString(),
      };
      const supabase = mockSupabase({
        rpcResponses: { start_timer: { data: row, error: null } },
      });

      const result = await setTimer.handler({ duration_seconds: 120 }, makeCtx(supabase));
      const parsed = parseText(result);

      expect(supabase.schema).toHaveBeenCalledWith('coachbyte');
      expect(supabase.rpc).toHaveBeenCalledWith('start_timer', {
        p_user_id: '00000000-0000-0000-0000-000000000001',
        p_duration_seconds: 120,
      });
      expect(parsed.state).toBe('running');
      expect(parsed.duration_seconds).toBe(120);
      expect(parsed.timer_id).toBe('t-1');
    });

    it('handles rpc returning a single-element array (SETOF)', async () => {
      const row = {
        timer_id: 't-2',
        state: 'running',
        duration_seconds: 60,
        end_time: new Date(Date.now() + 60_000).toISOString(),
      };
      const supabase = mockSupabase({
        rpcResponses: { start_timer: { data: [row], error: null } },
      });

      const result = await setTimer.handler({ duration_seconds: 60 }, makeCtx(supabase));
      expect(parseText(result).timer_id).toBe('t-2');
    });

    it('rejects non-positive duration client-side before calling rpc', async () => {
      const supabase = mockSupabase({ rpcResponses: {} });
      const result = await setTimer.handler({ duration_seconds: 0 }, makeCtx(supabase));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('must be positive');
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it('surfaces an RPC error through toolError', async () => {
      const supabase = mockSupabase({
        rpcResponses: { start_timer: { data: null, error: { message: 'boom' } } },
      });
      const result = await setTimer.handler({ duration_seconds: 30 }, makeCtx(supabase));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('boom');
    });
  });

  // ──────────────────────────── pause_timer ──────────────────────────
  describe('pauseTimer → pause_timer RPC', () => {
    it('calls rpc("pause_timer") with no args and returns row', async () => {
      const row = {
        timer_id: 't-1',
        state: 'paused',
        duration_seconds: 120,
        elapsed_before_pause: 30,
      };
      const supabase = mockSupabase({
        rpcResponses: { pause_timer: { data: row, error: null } },
      });

      const result = await pauseTimer.handler({}, makeCtx(supabase));
      const parsed = parseText(result);

      expect(supabase.rpc).toHaveBeenCalledWith('pause_timer', {
        p_user_id: '00000000-0000-0000-0000-000000000001',
      });
      expect(parsed.state).toBe('paused');
      expect(parsed.elapsed_seconds).toBe(30);
      expect(parsed.remaining_seconds).toBe(90);
    });

    it('maps "no active timer" RPC error to legacy UX string', async () => {
      const supabase = mockSupabase({
        rpcResponses: {
          pause_timer: { data: null, error: { message: 'pause_timer: no active timer' } },
        },
      });
      const result = await pauseTimer.handler({}, makeCtx(supabase));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('No active timer found');
    });

    it('maps "cannot pause timer in state <s>" to legacy UX string', async () => {
      const supabase = mockSupabase({
        rpcResponses: {
          pause_timer: {
            data: null,
            error: { message: 'pause_timer: cannot pause timer in state paused (must be running)' },
          },
        },
      });
      const result = await pauseTimer.handler({}, makeCtx(supabase));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Cannot pause timer in state "paused" (must be "running")');
    });
  });

  // ──────────────────────────── resume_timer ─────────────────────────
  describe('resumeTimer → resume_timer RPC', () => {
    it('calls rpc("resume_timer") and returns row', async () => {
      const row = {
        timer_id: 't-1',
        state: 'running',
        duration_seconds: 120,
        elapsed_before_pause: 30,
        end_time: new Date(Date.now() + 90_000).toISOString(),
      };
      const supabase = mockSupabase({
        rpcResponses: { resume_timer: { data: row, error: null } },
      });

      const result = await resumeTimer.handler({}, makeCtx(supabase));
      const parsed = parseText(result);

      expect(supabase.rpc).toHaveBeenCalledWith('resume_timer', {
        p_user_id: '00000000-0000-0000-0000-000000000001',
      });
      expect(parsed.state).toBe('running');
      expect(parsed.remaining_seconds).toBe(90);
    });

    it('maps "no active timer" → No active timer found', async () => {
      const supabase = mockSupabase({
        rpcResponses: {
          resume_timer: { data: null, error: { message: 'resume_timer: no active timer' } },
        },
      });
      const result = await resumeTimer.handler({}, makeCtx(supabase));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('No active timer found');
    });

    it('maps "cannot resume timer in state <s>" to legacy UX string', async () => {
      const supabase = mockSupabase({
        rpcResponses: {
          resume_timer: {
            data: null,
            error: { message: 'resume_timer: cannot resume timer in state running (must be paused)' },
          },
        },
      });
      const result = await resumeTimer.handler({}, makeCtx(supabase));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Cannot resume timer in state "running" (must be "paused")');
    });

    it('maps "no remaining time" to legacy UX string', async () => {
      const supabase = mockSupabase({
        rpcResponses: {
          resume_timer: { data: null, error: { message: 'resume_timer: no remaining time' } },
        },
      });
      const result = await resumeTimer.handler({}, makeCtx(supabase));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Timer has no remaining time');
    });
  });

  // ──────────────────────────── reset_timer ──────────────────────────
  describe('resetTimer → reset_timer RPC', () => {
    it('calls rpc("reset_timer") and returns idle when count>0', async () => {
      const supabase = mockSupabase({
        rpcResponses: { reset_timer: { data: 1, error: null } },
      });

      const result = await resetTimer.handler({}, makeCtx(supabase));
      const parsed = parseText(result);

      expect(supabase.rpc).toHaveBeenCalledWith('reset_timer', {
        p_user_id: '00000000-0000-0000-0000-000000000001',
      });
      expect(parsed.state).toBe('idle');
      expect(parsed.message).toBe('Timer reset');
    });

    it('returns "No active timer to reset" when RPC returns count=0', async () => {
      const supabase = mockSupabase({
        rpcResponses: { reset_timer: { data: 0, error: null } },
      });
      const result = await resetTimer.handler({}, makeCtx(supabase));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('No active timer to reset');
    });

    it('surfaces an RPC error through toolError', async () => {
      const supabase = mockSupabase({
        rpcResponses: { reset_timer: { data: null, error: { message: 'denied' } } },
      });
      const result = await resetTimer.handler({}, makeCtx(supabase));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('denied');
    });
  });

  // ──────────────────────────── get_timer ────────────────────────────
  describe('getTimer (read + expire_timer auto-transition)', () => {
    it('returns idle when no row exists (no rpc call)', async () => {
      const supabase = mockSupabase({
        rpcResponses: {},
        selectTimerRow: { data: null, error: null },
      });
      const result = await getTimer.handler({}, makeCtx(supabase));
      const parsed = parseText(result);
      expect(parsed.state).toBe('idle');
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it('returns running timer with remaining_seconds>0 and no rpc call', async () => {
      const endTime = new Date(Date.now() + 60_000).toISOString();
      const supabase = mockSupabase({
        rpcResponses: {},
        selectTimerRow: {
          data: { timer_id: 't-1', state: 'running', duration_seconds: 60, end_time: endTime },
          error: null,
        },
      });
      const result = await getTimer.handler({}, makeCtx(supabase));
      const parsed = parseText(result);
      expect(parsed.state).toBe('running');
      expect(parsed.remaining_seconds).toBeGreaterThan(0);
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it('auto-dispatches expire_timer RPC when remaining==0', async () => {
      const endTime = new Date(Date.now() - 1000).toISOString(); // in the past
      const supabase = mockSupabase({
        rpcResponses: { expire_timer: { data: null, error: null } },
        selectTimerRow: {
          data: { timer_id: 't-1', state: 'running', duration_seconds: 60, end_time: endTime },
          error: null,
        },
      });
      const result = await getTimer.handler({}, makeCtx(supabase));
      const parsed = parseText(result);

      expect(supabase.rpc).toHaveBeenCalledWith('expire_timer', {
        p_user_id: '00000000-0000-0000-0000-000000000001',
      });
      // The handler flips state→'expired' after a successful rpc.
      expect(parsed.state).toBe('expired');
      expect(parsed.remaining_seconds).toBe(0);
    });

    it('keeps state=running (falls back) when expire_timer RPC rejects', async () => {
      const endTime = new Date(Date.now() - 1000).toISOString();
      const supabase = mockSupabase({
        rpcResponses: {
          expire_timer: { data: null, error: { message: 'cannot expire' } },
        },
        selectTimerRow: {
          data: { timer_id: 't-1', state: 'running', duration_seconds: 60, end_time: endTime },
          error: null,
        },
      });
      const result = await getTimer.handler({}, makeCtx(supabase));
      const parsed = parseText(result);
      expect(supabase.rpc).toHaveBeenCalledWith('expire_timer', {
        p_user_id: '00000000-0000-0000-0000-000000000001',
      });
      // Guard rejected — keep the last-known state so the caller can
      // refetch; remaining still reports 0.
      expect(parsed.state).toBe('running');
      expect(parsed.remaining_seconds).toBe(0);
    });
  });
});
