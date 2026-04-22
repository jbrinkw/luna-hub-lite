import { describe, it, expect, vi } from 'vitest';
import {
  startTimerRpc,
  pauseTimerRpc,
  resumeTimerRpc,
  resetTimerRpc,
  expireTimerRpc,
} from '@/pages/coachbyte/TodayPage';

// Unit tests for the TodayPage timer dispatchers. These functions are the
// single code path the page uses to mutate the DB timer state machine —
// each must hit the matching `coachbyte.*_timer` RPC introduced in
// migration 20260425040000_timer_state_machine_rpcs.sql. If a future
// refactor reverts back to `from('timers').update(...)`, one of these
// tests fails because the mock rpc isn't called (or is called with the
// wrong name / args).

function mockClient(rpcResp: { data?: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(() => Promise.resolve(rpcResp));
  const schema = vi.fn(() => ({ rpc }));
  return {
    client: { schema } as any,
    schema,
    rpc,
  };
}

describe('TodayPage timer dispatchers → state-machine RPCs', () => {
  describe('startTimerRpc', () => {
    it('calls coachbyte.start_timer with p_duration_seconds', async () => {
      const m = mockClient({ data: null, error: null });
      const result = await startTimerRpc(90, m.client);

      expect(m.schema).toHaveBeenCalledWith('coachbyte');
      expect(m.rpc).toHaveBeenCalledWith('start_timer', { p_duration_seconds: 90 });
      expect(result.error).toBeNull();
    });

    it('surfaces RPC error.message', async () => {
      const m = mockClient({ data: null, error: { message: 'start_timer: duration_seconds must be positive' } });
      const result = await startTimerRpc(0, m.client);
      expect(result.error).toContain('must be positive');
    });
  });

  describe('pauseTimerRpc', () => {
    it('calls coachbyte.pause_timer with no args', async () => {
      const m = mockClient({ data: null, error: null });
      const result = await pauseTimerRpc(m.client);

      expect(m.rpc).toHaveBeenCalledWith('pause_timer');
      expect(result.error).toBeNull();
    });

    it('surfaces RPC guard rejection (state=paused)', async () => {
      const m = mockClient({
        data: null,
        error: { message: 'pause_timer: cannot pause timer in state paused (must be running)' },
      });
      const result = await pauseTimerRpc(m.client);
      expect(result.error).toContain('cannot pause');
      expect(result.error).toContain('paused');
    });
  });

  describe('resumeTimerRpc', () => {
    it('calls coachbyte.resume_timer with no args', async () => {
      const m = mockClient({ data: null, error: null });
      const result = await resumeTimerRpc(m.client);

      expect(m.rpc).toHaveBeenCalledWith('resume_timer');
      expect(result.error).toBeNull();
    });

    it('surfaces RPC guard rejection (state=running)', async () => {
      const m = mockClient({
        data: null,
        error: { message: 'resume_timer: cannot resume timer in state running (must be paused)' },
      });
      const result = await resumeTimerRpc(m.client);
      expect(result.error).toContain('cannot resume');
    });

    it('surfaces RPC no-remaining-time rejection', async () => {
      const m = mockClient({
        data: null,
        error: { message: 'resume_timer: no remaining time' },
      });
      const result = await resumeTimerRpc(m.client);
      expect(result.error).toContain('no remaining time');
    });
  });

  describe('resetTimerRpc', () => {
    it('calls coachbyte.reset_timer with no args', async () => {
      const m = mockClient({ data: 1, error: null });
      const result = await resetTimerRpc(m.client);

      expect(m.rpc).toHaveBeenCalledWith('reset_timer');
      expect(result.error).toBeNull();
    });

    it('soft-noop when no row existed (returns 0) — still reports no error', async () => {
      const m = mockClient({ data: 0, error: null });
      const result = await resetTimerRpc(m.client);
      expect(result.error).toBeNull();
    });

    it('surfaces RPC error', async () => {
      const m = mockClient({ data: null, error: { message: 'denied' } });
      const result = await resetTimerRpc(m.client);
      expect(result.error).toBe('denied');
    });
  });

  describe('expireTimerRpc', () => {
    it('calls coachbyte.expire_timer with no args', async () => {
      const m = mockClient({ data: null, error: null });
      const result = await expireTimerRpc(m.client);

      expect(m.rpc).toHaveBeenCalledWith('expire_timer');
      expect(result.error).toBeNull();
    });

    it('swallows "cannot expire" guard rejections (race with pause/reset)', async () => {
      const m = mockClient({
        data: null,
        error: { message: 'expire_timer: cannot expire timer in state paused (must be running)' },
      });
      const result = await expireTimerRpc(m.client);
      // Racing guards are expected — surface as non-error so the
      // realtime subscription re-syncs the UI.
      expect(result.error).toBeNull();
    });

    it('surfaces unknown RPC errors', async () => {
      const m = mockClient({ data: null, error: { message: 'network failure' } });
      const result = await expireTimerRpc(m.client);
      expect(result.error).toBe('network failure');
    });
  });
});
