import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const setTimer: ToolDefinition = {
  name: 'COACHBYTE_set_timer',
  description: 'Start a rest timer with specified duration.',
  inputSchema: {
    type: 'object',
    properties: {
      duration_seconds: {
        type: 'integer',
        description: 'Timer duration in seconds',
      },
    },
    required: ['duration_seconds'],
  },
  handler: async (args, ctx) => {
    const { duration_seconds } = args;

    if (duration_seconds <= 0) {
      return toolError('duration_seconds must be positive');
    }

    const endTime = new Date(Date.now() + duration_seconds * 1000).toISOString();

    const { data, error } = await ctx.supabase
      .schema('coachbyte')
      .from('timers')
      .upsert(
        {
          user_id: ctx.userId,
          state: 'running',
          duration_seconds,
          end_time: endTime,
        },
        { onConflict: 'user_id' },
      )
      .select('timer_id, state, duration_seconds, end_time')
      .single();

    if (error) return toolError(`Failed to set timer: ${error.message}`);

    return toolSuccess({
      message: `Timer started for ${duration_seconds} seconds`,
      timer_id: data.timer_id,
      state: data.state,
      duration_seconds: data.duration_seconds,
      end_time: data.end_time,
    });
  },
};
