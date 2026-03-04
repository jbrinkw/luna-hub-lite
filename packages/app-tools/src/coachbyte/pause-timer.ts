import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const pauseTimer: ToolDefinition = {
  name: 'COACHBYTE_pause_timer',
  description: 'Pause a running rest timer. Stores elapsed time so it can be resumed later.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, ctx) => {
    // Fetch the current timer
    const { data: timer, error: fetchError } = await ctx.supabase
      .schema('coachbyte')
      .from('timers')
      .select('timer_id, state, duration_seconds, end_time, elapsed_before_pause')
      .eq('user_id', ctx.userId)
      .single();

    if (fetchError || !timer) {
      return toolError('No active timer found');
    }

    if (timer.state !== 'running') {
      return toolError(`Cannot pause timer in state "${timer.state}" (must be "running")`);
    }

    // Calculate elapsed seconds so far
    const endMs = new Date(timer.end_time).getTime();
    const nowMs = Date.now();
    const remainingMs = Math.max(0, endMs - nowMs);
    const elapsedSeconds = timer.duration_seconds - Math.round(remainingMs / 1000);

    const { data, error } = await ctx.supabase
      .schema('coachbyte')
      .from('timers')
      .update({
        state: 'paused',
        paused_at: new Date().toISOString(),
        elapsed_before_pause: elapsedSeconds,
        end_time: null,
      })
      .eq('timer_id', timer.timer_id)
      .eq('user_id', ctx.userId)
      .select('timer_id, state, duration_seconds, elapsed_before_pause')
      .single();

    if (error) return toolError(`Failed to pause timer: ${error.message}`);

    const remaining = data.duration_seconds - data.elapsed_before_pause;

    return toolSuccess({
      message: `Timer paused with ${remaining} second(s) remaining`,
      timer_id: data.timer_id,
      state: data.state,
      duration_seconds: data.duration_seconds,
      elapsed_seconds: data.elapsed_before_pause,
      remaining_seconds: remaining,
    });
  },
};
