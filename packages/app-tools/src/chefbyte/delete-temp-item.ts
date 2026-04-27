import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const deleteTempItem: ToolDefinition = {
  name: 'CHEFBYTE_delete_temp_item',
  description:
    'Delete a temporary (quick-add) macro entry by temp_id. Used to undo a stray `log_temp_item` call. RLS enforces ownership.',
  inputSchema: {
    type: 'object',
    properties: {
      temp_id: { type: 'string', description: 'The temp_items UUID to delete' },
    },
    required: ['temp_id'],
  },
  handler: async (args, ctx) => {
    const { temp_id } = args;
    if (typeof temp_id !== 'string' || temp_id.length === 0) {
      return toolError('temp_id is required');
    }

    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('temp_items')
      .delete()
      .eq('temp_id', temp_id)
      .eq('user_id', ctx.userId)
      .select('temp_id, name, logical_date, calories, carbs, protein, fat');

    if (error) return toolError(`Failed to delete temp item: ${error.message}`);
    if (!data || data.length === 0) return toolError('Temp item not found or does not belong to you');

    return toolSuccess({
      success: true,
      message: 'Temp item deleted',
      deleted: data[0],
    });
  },
};
