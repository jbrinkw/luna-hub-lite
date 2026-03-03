import type { ToolDefinition } from '../types';
import { toolSuccess, toolError, getLogicalDate } from '../shared';

export const getMacros: ToolDefinition = {
  name: 'CHEFBYTE_get_macros',
  description: 'Get daily macro summary (food_logs + temp_items combined vs targets).',
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'Date YYYY-MM-DD (defaults to today\'s logical date)' },
    },
  },
  handler: async (args, ctx) => {
    const date = args.date || await getLogicalDate(ctx.supabase, ctx.userId);

    const { data, error } = await ctx.supabase.rpc(
      'get_daily_macros_admin',
      {
        p_user_id: ctx.userId,
        p_logical_date: date,
      },
      { schema: 'chefbyte' },
    );

    if (error) return toolError(`Failed to fetch macros: ${error.message}`);

    return toolSuccess(data);
  },
};
