import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const addToShopping: ToolDefinition = {
  name: 'CHEFBYTE_add_to_shopping',
  description: 'Add or update an item on the shopping list.',
  inputSchema: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'The product UUID' },
      qty_containers: { type: 'number', description: 'Number of containers to buy' },
    },
    required: ['product_id', 'qty_containers'],
  },
  handler: async (args, ctx) => {
    const { product_id, qty_containers } = args;

    if (qty_containers <= 0) return toolError('qty_containers must be positive');

    const row: Record<string, any> = {
      user_id: ctx.userId,
      product_id,
      qty_containers,
    };

    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('shopping_list')
      .upsert(row, { onConflict: 'user_id,product_id' })
      .select('cart_item_id, product_id, qty_containers')
      .single();

    if (error) return toolError(`Failed to add to shopping list: ${error.message}`);

    return toolSuccess({
      message: `Added ${qty_containers} container(s) to shopping list`,
      item: {
        id: data.cart_item_id,
        product_id: data.product_id,
        qty_containers: data.qty_containers,
      },
    });
  },
};
