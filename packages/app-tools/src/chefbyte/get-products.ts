import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const getProducts: ToolDefinition = {
  name: 'CHEFBYTE_get_products',
  description: 'List products with optional name search and category filter.',
  inputSchema: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Search term to filter by name (case-insensitive)' },
      category: { type: 'string', description: 'Filter by category' },
    },
  },
  handler: async (args, ctx) => {
    let query = ctx.supabase
      .schema('chefbyte')
      .from('products')
      .select('product_id, name, barcode, description, servings_per_container, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, price, min_stock_amount, category')
      .eq('user_id', ctx.userId)
      .order('name', { ascending: true });

    if (args.search) {
      query = query.ilike('name', `%${args.search}%`);
    }
    if (args.category) {
      query = query.eq('category', args.category);
    }

    const { data, error } = await query;

    if (error) return toolError(`Failed to fetch products: ${error.message}`);

    return toolSuccess({ products: data || [], total: (data || []).length });
  },
};
