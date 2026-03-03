import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const setPrice: ToolDefinition = {
  name: 'CHEFBYTE_set_price',
  description: 'Set the price for a product.',
  inputSchema: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'The product UUID' },
      price: { type: 'number', description: 'Price per container' },
    },
    required: ['product_id', 'price'],
  },
  handler: async (args, ctx) => {
    const { product_id, price } = args;

    if (price < 0) return toolError('Price cannot be negative');

    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('products')
      .update({ price })
      .eq('product_id', product_id)
      .eq('user_id', ctx.userId)
      .select('product_id, name, price')
      .single();

    if (error) return toolError(`Failed to set price: ${error.message}`);

    return toolSuccess({
      message: `Price for "${data.name}" set to $${Number(data.price).toFixed(2)}`,
      product: data,
    });
  },
};
