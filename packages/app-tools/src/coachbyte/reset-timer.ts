import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const resetTimer: ToolDefinition = {
  name: 'COACHBYTE_reset_timer',
  description: 'Reset (delete) the current rest timer, returning to idle state.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, ctx) => {
    const { error, count } = await ctx.supabase
      .schema('coachbyte')
      .from('timers')
      .delete({ count: 'exact' })
      .eq('user_id', ctx.userId);

    if (error) return toolError(`Failed to reset timer: ${error.message}`);
    if (count === 0) return toolError('No active timer to reset');

    return toolSuccess({ message: 'Timer reset', state: 'idle' });
  },
};
