import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const deleteProduct: ToolDefinition = {
  name: 'CHEFBYTE_delete_product',
  description:
    "Soft-delete a product by product_id (sets deleted_at timestamp). The product " +
    "is hidden from inventory / product-list queries and propagates to the Live " +
    "Shelf Pi (its local classifier won't propose the deleted product anymore). " +
    "Existing stock_lots, food_logs, meal_plan_entries, and recipe_ingredients " +
    "rows are preserved — historical records stay intact. RLS enforces ownership.",
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

    // Soft-delete: set deleted_at = now(). The products_set_updated_at
    // trigger bumps updated_at so the Pi's 30s product-sync poller sees
    // the tombstone in its next updated_since delta and hard-deletes the
    // local row. We still filter on `deleted_at IS NULL` in the eq clause
    // so double-deleting a product returns "not found" rather than
    // silently succeeding — prevents accidental state bounce in retries.
    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('products')
      .update({ deleted_at: new Date().toISOString() })
      .eq('product_id', product_id)
      .eq('user_id', ctx.userId)
      .is('deleted_at', null)
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
