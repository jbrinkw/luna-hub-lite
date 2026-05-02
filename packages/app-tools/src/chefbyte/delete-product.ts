import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const deleteProduct: ToolDefinition = {
  name: 'CHEFBYTE_delete_product',
  description:
    'Delete a product by product_id. stock_lots / shopping_list / meal_plan_entries / ' +
    'recipe_ingredients referencing the product cascade out; food_logs preserve their ' +
    'cached macro values with product_id set to NULL. RLS enforces ownership.',
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

    // Hard delete. Earlier iterations soft-deleted (set deleted_at) so
    // historical food_logs / stock_lots could keep their reference, but
    // the tombstone left the row in the unique-on-(user_id, barcode)
    // index — which made rescans of the same barcode short-circuit on
    // the dead row. food_logs has ON DELETE SET NULL so history rows
    // survive without breaking; everything else cascades.
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
