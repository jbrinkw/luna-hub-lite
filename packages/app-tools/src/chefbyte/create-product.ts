import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const createProduct: ToolDefinition = {
  name: 'CHEFBYTE_create_product',
  description: 'Create a new product with nutritional info.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Product name' },
      barcode: { type: 'string', description: 'Barcode (optional)' },
      description: { type: 'string', description: 'Product description (optional)' },
      servings_per_container: { type: 'number', description: 'Servings per container' },
      calories_per_serving: { type: 'number', description: 'Calories per serving' },
      carbs_per_serving: { type: 'number', description: 'Carbs per serving (g)' },
      protein_per_serving: { type: 'number', description: 'Protein per serving (g)' },
      fat_per_serving: { type: 'number', description: 'Fat per serving (g)' },
      price: { type: 'number', description: 'Price per container' },
      min_stock_amount: { type: 'number', description: 'Minimum stock threshold (containers)' },
      category: { type: 'string', description: 'Product category' },
    },
    required: ['name'],
  },
  handler: async (args, ctx) => {
    const row: Record<string, any> = { user_id: ctx.userId, name: args.name };

    const optionalFields = [
      'barcode', 'description', 'servings_per_container',
      'calories_per_serving', 'carbs_per_serving', 'protein_per_serving',
      'fat_per_serving', 'price', 'min_stock_amount', 'category',
    ];

    for (const field of optionalFields) {
      if (args[field] !== undefined && args[field] !== null) {
        row[field] = args[field];
      }
    }

    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('products')
      .insert(row)
      .select('product_id, name, barcode, category')
      .single();

    if (error) return toolError(`Failed to create product: ${error.message}`);

    return toolSuccess({ message: `Product "${data.name}" created`, product: data });
  },
};
