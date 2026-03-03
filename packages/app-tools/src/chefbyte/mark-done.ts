import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const markDone: ToolDefinition = {
  name: 'CHEFBYTE_mark_done',
  description: 'Mark a meal plan entry as completed. Deducts stock and logs macros.',
  inputSchema: {
    type: 'object',
    properties: {
      meal_id: { type: 'string', description: 'The meal plan entry UUID' },
    },
    required: ['meal_id'],
  },
  handler: async (args, ctx) => {
    const { meal_id } = args;

    const { data, error } = await ctx.supabase.rpc(
      'mark_meal_done_admin',
      {
        p_user_id: ctx.userId,
        p_meal_id: meal_id,
      },
      { schema: 'chefbyte' },
    );

    if (error) return toolError(`Failed to mark meal done: ${error.message}`);

    return toolSuccess(data);
  },
};
