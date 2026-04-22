import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

// Dispatches to the DB state-machine RPC `coachbyte.start_timer`
// (see migration 20260425040000_timer_state_machine_rpcs.sql). The RPC
// upserts the single-per-user row (running state, fresh end_time) and
// enforces the duration > 0 guard server-side. The tool still validates
// client-side so a bad arg never hits the DB.
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

    // MCP tools run with service_role (no JWT). The `coachbyte.start_timer(
    // p_user_id, p_duration_seconds)` overload (migration 20260425090000)
    // is granted to service_role and takes p_user_id explicitly. Browser
    // callers use the no-arg form and derive auth.uid() from the JWT.
    const { data, error } = await ctx.supabase.schema('coachbyte').rpc('start_timer', {
      p_user_id: ctx.userId,
      p_duration_seconds: duration_seconds,
    });

    if (error) return toolError(`Failed to set timer: ${error.message}`);

    // The RPC returns a SETOF coachbyte.timers row; PostgREST surfaces it
    // as an object (single-row) when the client passes no array wrapper.
    const row = (Array.isArray(data) ? data[0] : data) as {
      timer_id: string;
      state: string;
      duration_seconds: number;
      end_time: string;
    };

    return toolSuccess({
      message: `Timer started for ${duration_seconds} seconds`,
      timer_id: row.timer_id,
      state: row.state,
      duration_seconds: row.duration_seconds,
      end_time: row.end_time,
    });
  },
};
