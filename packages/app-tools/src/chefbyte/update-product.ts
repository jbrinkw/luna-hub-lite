import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const updateProduct: ToolDefinition = {
  name: 'CHEFBYTE_update_product',
  description: 'Update product fields by product_id. Validates ownership.',
  inputSchema: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'Product UUID to update' },
      name: { type: 'string', description: 'Product name' },
      barcode: { type: 'string', description: 'Barcode' },
      servings_per_container: { type: 'number', description: 'Servings per container' },
      calories_per_serving: { type: 'number', description: 'Calories per serving' },
      carbs_per_serving: { type: 'number', description: 'Carbs per serving (g)' },
      protein_per_serving: { type: 'number', description: 'Protein per serving (g)' },
      fat_per_serving: { type: 'number', description: 'Fat per serving (g)' },
      min_stock_amount: { type: 'number', description: 'Minimum stock threshold (containers)' },
      walmart_link: { type: 'string', description: 'Walmart product URL' },
      price: { type: 'number', description: 'Price per container' },
    },
    required: ['product_id'],
  },
  handler: async (args, ctx) => {
    const { product_id, ...fields } = args;

    const updatableFields = [
      'name',
      'barcode',
      'servings_per_container',
      'calories_per_serving',
      'carbs_per_serving',
      'protein_per_serving',
      'fat_per_serving',
      'min_stock_amount',
      'walmart_link',
      'price',
    ];

    const updates: Record<string, any> = {};
    for (const field of updatableFields) {
      if (fields[field] !== undefined) {
        updates[field] = fields[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return toolError('No fields to update. Provide at least one field besides product_id.');
    }

    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('products')
      .update(updates)
      .eq('product_id', product_id)
      .eq('user_id', ctx.userId)
      .select('product_id, name, barcode')
      .single();

    if (error) return toolError(`Failed to update product: ${error.message}`);
    if (!data) return toolError('Product not found or does not belong to you');

    return toolSuccess({ message: `Product "${data.name}" updated`, product: data });
  },
};
