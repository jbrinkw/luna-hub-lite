import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const deleteFoodLog: ToolDefinition = {
  name: 'CHEFBYTE_delete_food_log',
  description:
    "Delete a single food log entry by log_id. Used to undo accidental `consume` calls or remove a mistaken macro entry. RLS enforces ownership.",
  inputSchema: {
    type: 'object',
    properties: {
      log_id: { type: 'string', description: 'The food_log UUID to delete' },
    },
    required: ['log_id'],
  },
  handler: async (args, ctx) => {
    const { log_id } = args;
    if (typeof log_id !== 'string' || log_id.length === 0) {
      return toolError('log_id is required');
    }

    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('food_logs')
      .delete()
      .eq('log_id', log_id)
      .eq('user_id', ctx.userId)
      .select('log_id, product_id, logical_date, calories, carbs, protein, fat, qty_consumed, unit');

    if (error) return toolError(`Failed to delete food log: ${error.message}`);
    if (!data || data.length === 0) return toolError('Food log not found or does not belong to you');

    return toolSuccess({
      success: true,
      message: 'Food log deleted',
      deleted: data[0],
    });
  },
};
