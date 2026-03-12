import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const clearShopping: ToolDefinition = {
  name: 'CHEFBYTE_clear_shopping',
  description: 'Clear the entire shopping list.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, ctx) => {
    const { error } = await ctx.supabase.schema('chefbyte').from('shopping_list').delete().eq('user_id', ctx.userId);

    if (error) return toolError(`Failed to clear shopping list: ${error.message}`);

    return toolSuccess({ message: 'Shopping list cleared' });
  },
};
