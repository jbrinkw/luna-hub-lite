import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const deleteProduct: ToolDefinition = {
  name: 'CHEFBYTE_delete_product',
  description:
    "DESTRUCTIVE: permanently delete a product by product_id. CASCADES to stock_lots, " +
    "meal_plan_entries (for product-based meals), food_logs, shopping_list rows, and " +
    "recipe_ingredients referencing this product (which may orphan recipes). " +
    "Prefer archiving or updating fields over deletion. RLS enforces ownership.",
  inputSchema: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'The product UUID to delete' },
    },
    required: ['product_id'],
  },
  handler: async (args, ctx) => {
    const { product_id } = args;
    if (typeof product_id !== 'string' || product_id.length === 0) {
      return toolError('product_id is required');
    }

    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('products')
      .delete()
      .eq('product_id', product_id)
      .eq('user_id', ctx.userId)
      .select('product_id, name, barcode');

    if (error) return toolError(`Failed to delete product: ${error.message}`);
    if (!data || data.length === 0) return toolError('Product not found or does not belong to you');

    return toolSuccess({
      success: true,
      message: `Product "${data[0].name}" deleted`,
      deleted: data[0],
    });
  },
};
