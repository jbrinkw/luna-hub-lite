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
      is_placeholder: {
        type: 'boolean',
        description:
          'True when the product has no barcode and nutritional data is estimated. Scanners must never set this.',
      },
      is_distinct_unit_item: {
        type: 'boolean',
        description:
          '1 piece = 1 serving (eggs, buns, bread slices, tortillas, protein bars, packets). Set servings_per_container to the number of physical pieces in the package. Defaults false.',
      },
      default_recipe_unit: {
        type: 'string',
        enum: ['gram', 'serving', 'container'],
        description:
          "Default unit when this product is added to a recipe. Use 'gram' for bulk items (yogurt, milk, sugar), 'serving' for distinct items (eggs, buns), 'container' rarely.",
      },
      net_weight_g: {
        type: 'number',
        description:
          "Full container mass in grams. Required if default_recipe_unit is 'gram' — handler downgrades to 'serving' if not provided.",
      },
    },
    required: ['name'],
  },
  handler: async (args, ctx) => {
    const row: Record<string, any> = { user_id: ctx.userId, name: args.name };

    const optionalFields = [
      'barcode',
      'description',
      'servings_per_container',
      'calories_per_serving',
      'carbs_per_serving',
      'protein_per_serving',
      'fat_per_serving',
      'price',
      'min_stock_amount',
      'is_placeholder',
      'is_distinct_unit_item',
      'default_recipe_unit',
      'net_weight_g',
    ];

    for (const field of optionalFields) {
      if (args[field] !== undefined && args[field] !== null) {
        row[field] = args[field];
      }
    }

    // Defensive: if default_recipe_unit='gram' but net_weight_g is absent / non-positive,
    // downgrade to 'serving' so the product is usable in recipes immediately.
    let downgradedNote = '';
    if (row.default_recipe_unit === 'gram' && !(row.net_weight_g > 0)) {
      row.default_recipe_unit = 'serving';
      downgradedNote = ' (Note: gram unit downgraded to serving because net_weight_g not provided.)';
    }

    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('products')
      .insert(row)
      .select('product_id, name, barcode')
      .single();

    if (error) return toolError(`Failed to create product: ${error.message}`);

    return toolSuccess({ message: `Product "${data.name}" created${downgradedNote}`, product: data });
  },
};
