import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

// get-timer is a read — no state transition — so it does a direct SELECT
// against coachbyte.timers (RLS scopes to the caller). The one write
// this tool used to do (flip state='done' when remaining_seconds==0)
// is now dispatched through the `coachbyte.expire_timer` RPC so the
// state-machine guards (state=running AND end_time<=now()) stay
// centralized. We also fix a longstanding bug: the old handler set
// state='done', but the CHECK constraint only allows
// ('running','paused','expired') — the legacy write would have failed
// on any real DB. The RPC writes 'expired'.
export const getTimer: ToolDefinition = {
  name: 'COACHBYTE_get_timer',
  description: 'Get current timer state and remaining seconds.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, ctx) => {
    const { data: timer, error } = await ctx.supabase
      .schema('coachbyte')
      .from('timers')
      .select('timer_id, state, duration_seconds, end_time')
      .eq('user_id', ctx.userId)
      .maybeSingle();

    if (error) return toolError(`Failed to fetch timer: ${error.message}`);

    if (!timer) {
      return toolSuccess({
        state: 'idle',
        remaining_seconds: 0,
        duration_seconds: 0,
      });
    }

    let remainingSeconds = 0;
    let state = timer.state;

    if (timer.state === 'running' && timer.end_time) {
      const endMs = new Date(timer.end_time).getTime();
      const nowMs = Date.now();
      remainingSeconds = Math.max(0, Math.round((endMs - nowMs) / 1000));

      // If the timer's wall-clock end has passed, flip to 'expired' via the
      // state-machine RPC (which enforces state=running AND end_time<=now()).
      // Any RPC error (e.g. guard failed because another writer already
      // expired or mutated the row) is treated non-fatally — the read we
      // return still reflects 'running' with 0 remaining, letting the
      // caller refetch.
      if (remainingSeconds === 0) {
        // Service-role overload — see set-timer.ts for rationale.
        const { error: expErr } = await ctx.supabase.schema('coachbyte').rpc('expire_timer', { p_user_id: ctx.userId });
        if (!expErr) {
          state = 'expired';
        }
      }
    }

    return toolSuccess({
      timer_id: timer.timer_id,
      state,
      remaining_seconds: remainingSeconds,
      duration_seconds: timer.duration_seconds,
      end_time: timer.end_time,
    });
  },
};
