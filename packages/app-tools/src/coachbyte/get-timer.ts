import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

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

      // If timer has expired, report as done
      if (remainingSeconds === 0) {
        state = 'done';
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
