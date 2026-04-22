import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

// Dispatches to the DB state-machine RPC `coachbyte.resume_timer`. RPC
// errors we map back to the legacy UX strings:
//   - 'no active timer'   → 'No active timer found'
//   - 'cannot resume timer in state <s>' → 'Cannot resume timer in state "<s>" (must be "paused")'
//   - 'no remaining time' → 'Timer has no remaining time'
export const resumeTimer: ToolDefinition = {
  name: 'COACHBYTE_resume_timer',
  description: 'Resume a paused rest timer. Computes a new end_time from the remaining duration.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, ctx) => {
    // Service-role overload — see set-timer.ts for rationale.
    const { data, error } = await ctx.supabase.schema('coachbyte').rpc('resume_timer', { p_user_id: ctx.userId });

    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('no active timer')) {
        return toolError('No active timer found');
      }
      if (msg.includes('no remaining time')) {
        return toolError('Timer has no remaining time');
      }
      const match = msg.match(/cannot resume timer in state (\w+)/i);
      if (match) {
        return toolError(`Cannot resume timer in state "${match[1]}" (must be "paused")`);
      }
      return toolError(`Failed to resume timer: ${msg}`);
    }

    const row = (Array.isArray(data) ? data[0] : data) as {
      timer_id: string;
      state: string;
      duration_seconds: number;
      elapsed_before_pause: number;
      end_time: string;
    };

    const remainingSeconds = row.duration_seconds - (row.elapsed_before_pause ?? 0);

    return toolSuccess({
      message: `Timer resumed with ${remainingSeconds} second(s) remaining`,
      timer_id: row.timer_id,
      state: row.state,
      duration_seconds: row.duration_seconds,
      remaining_seconds: remainingSeconds,
      end_time: row.end_time,
    });
  },
};
