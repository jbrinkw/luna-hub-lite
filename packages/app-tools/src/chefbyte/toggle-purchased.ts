import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const togglePurchased: ToolDefinition = {
  name: 'CHEFBYTE_toggle_purchased',
  description: 'Toggle the purchased status of a shopping list item.',
  inputSchema: {
    type: 'object',
    properties: {
      item_id: { type: 'string', description: 'The cart_item_id UUID' },
    },
    required: ['item_id'],
  },
  handler: async (args, ctx) => {
    const { item_id } = args;

    // Fetch current purchased state
    const { data: current, error: fetchError } = await ctx.supabase
      .schema('chefbyte')
      .from('shopping_list')
      .select('cart_item_id, purchased')
      .eq('cart_item_id', item_id)
      .eq('user_id', ctx.userId)
      .single();

    if (fetchError || !current) {
      return toolError(`Shopping item not found: ${fetchError?.message ?? 'no matching row'}`);
    }

    const newPurchased = !current.purchased;

    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('shopping_list')
      .update({ purchased: newPurchased })
      .eq('cart_item_id', item_id)
      .eq('user_id', ctx.userId)
      .select('cart_item_id, product_id, qty_containers, purchased')
      .single();

    if (error) return toolError(`Failed to toggle purchased: ${error.message}`);

    return toolSuccess({
      message: `Item marked as ${newPurchased ? 'purchased' : 'not purchased'}`,
      item: {
        id: data.cart_item_id,
        product_id: data.product_id,
        qty_containers: Number(data.qty_containers),
        purchased: data.purchased,
      },
    });
  },
};
