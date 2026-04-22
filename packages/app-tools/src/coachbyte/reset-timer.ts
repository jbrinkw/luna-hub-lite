import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

// Dispatches to the DB state-machine RPC `coachbyte.reset_timer` which
// deletes the caller's timer row. Returns the INTEGER row-count so we
// can preserve the legacy UX: return an error when no row existed
// (count == 0). The DB RPC itself treats count == 0 as a soft noop; the
// "no active timer to reset" UX message stays a client-side choice.
export const resetTimer: ToolDefinition = {
  name: 'COACHBYTE_reset_timer',
  description: 'Reset (delete) the current rest timer, returning to idle state.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, ctx) => {
    // Service-role overload — see set-timer.ts for rationale.
    const { data, error } = await ctx.supabase.schema('coachbyte').rpc('reset_timer', { p_user_id: ctx.userId });

    if (error) return toolError(`Failed to reset timer: ${error.message}`);

    const count = typeof data === 'number' ? data : 0;
    if (count === 0) return toolError('No active timer to reset');

    return toolSuccess({ message: 'Timer reset', state: 'idle' });
  },
};
