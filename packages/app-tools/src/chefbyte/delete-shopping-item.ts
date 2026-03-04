import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const deleteShoppingItem: ToolDefinition = {
  name: 'CHEFBYTE_delete_shopping_item',
  description: 'Delete a single item from the shopping list.',
  inputSchema: {
    type: 'object',
    properties: {
      item_id: { type: 'string', description: 'The cart_item_id UUID' },
    },
    required: ['item_id'],
  },
  handler: async (args, ctx) => {
    const { item_id } = args;

    const { error, count } = await ctx.supabase
      .schema('chefbyte')
      .from('shopping_list')
      .delete({ count: 'exact' })
      .eq('cart_item_id', item_id)
      .eq('user_id', ctx.userId);

    if (error) return toolError(`Failed to delete shopping item: ${error.message}`);
    if (count === 0) return toolError('Shopping item not found');

    return toolSuccess({ message: 'Shopping item deleted', item_id });
  },
};
