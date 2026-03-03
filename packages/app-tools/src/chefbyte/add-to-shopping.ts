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
      notes: { type: 'string', description: 'Optional notes' },
    },
    required: ['product_id', 'qty_containers'],
  },
  handler: async (args, ctx) => {
    const { product_id, qty_containers, notes } = args;

    if (qty_containers <= 0) return toolError('qty_containers must be positive');

    const row: Record<string, any> = {
      user_id: ctx.userId,
      product_id,
      qty_containers,
    };
    if (notes !== undefined) row.notes = notes;

    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('shopping_list')
      .upsert(row, { onConflict: 'user_id,product_id' })
      .select('id, product_id, qty_containers, notes')
      .single();

    if (error) return toolError(`Failed to add to shopping list: ${error.message}`);

    return toolSuccess({
      message: `Added ${qty_containers} container(s) to shopping list`,
      item: data,
    });
  },
};
