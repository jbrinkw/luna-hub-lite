import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

// Dispatches to the DB state-machine RPC `coachbyte.pause_timer`. The RPC:
//   - errors with 'no active timer' when no row exists (mapped to the UX
//     string the legacy handler returned);
//   - errors with 'cannot pause timer in state <s> (must be running)' when
//     the row is paused/expired (mapped to the legacy UX string too).
// The RPC also computes elapsed_before_pause from end_time + duration
// and clears end_time — server-side, so the transition stays atomic.
export const pauseTimer: ToolDefinition = {
  name: 'COACHBYTE_pause_timer',
  description: 'Pause a running rest timer. Stores elapsed time so it can be resumed later.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, ctx) => {
    // Service-role overload — see set-timer.ts for rationale.
    const { data, error } = await ctx.supabase.schema('coachbyte').rpc('pause_timer', { p_user_id: ctx.userId });

    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('no active timer')) {
        return toolError('No active timer found');
      }
      // Map the RPC guard message to the stable UX string. The legacy
      // TS handler returned: 'Cannot pause timer in state "<s>" (must be "running")'.
      const match = msg.match(/cannot pause timer in state (\w+)/i);
      if (match) {
        return toolError(`Cannot pause timer in state "${match[1]}" (must be "running")`);
      }
      return toolError(`Failed to pause timer: ${msg}`);
    }

    const row = (Array.isArray(data) ? data[0] : data) as {
      timer_id: string;
      state: string;
      duration_seconds: number;
      elapsed_before_pause: number;
    };

    const remaining = row.duration_seconds - row.elapsed_before_pause;

    return toolSuccess({
      message: `Timer paused with ${remaining} second(s) remaining`,
      timer_id: row.timer_id,
      state: row.state,
      duration_seconds: row.duration_seconds,
      elapsed_seconds: row.elapsed_before_pause,
      remaining_seconds: remaining,
    });
  },
};
