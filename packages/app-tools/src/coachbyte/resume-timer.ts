import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const resumeTimer: ToolDefinition = {
  name: 'COACHBYTE_resume_timer',
  description: 'Resume a paused rest timer. Computes a new end_time from the remaining duration.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, ctx) => {
    // Fetch the current timer
    const { data: timer, error: fetchError } = await ctx.supabase
      .schema('coachbyte')
      .from('timers')
      .select('timer_id, state, duration_seconds, elapsed_before_pause')
      .eq('user_id', ctx.userId)
      .single();

    if (fetchError || !timer) {
      return toolError('No active timer found');
    }

    if (timer.state !== 'paused') {
      return toolError(`Cannot resume timer in state "${timer.state}" (must be "paused")`);
    }

    const remainingSeconds = timer.duration_seconds - (timer.elapsed_before_pause ?? 0);
    if (remainingSeconds <= 0) {
      return toolError('Timer has no remaining time');
    }

    const newEndTime = new Date(Date.now() + remainingSeconds * 1000).toISOString();

    const { data, error } = await ctx.supabase
      .schema('coachbyte')
      .from('timers')
      .update({
        state: 'running',
        end_time: newEndTime,
        paused_at: null,
      })
      .eq('timer_id', timer.timer_id)
      .eq('user_id', ctx.userId)
      .select('timer_id, state, duration_seconds, end_time')
      .single();

    if (error) return toolError(`Failed to resume timer: ${error.message}`);

    return toolSuccess({
      message: `Timer resumed with ${remainingSeconds} second(s) remaining`,
      timer_id: data.timer_id,
      state: data.state,
      duration_seconds: data.duration_seconds,
      remaining_seconds: remainingSeconds,
      end_time: data.end_time,
    });
  },
};
