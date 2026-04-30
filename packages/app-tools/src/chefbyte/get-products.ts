import type { ToolDefinition } from '../types';
import { toolSuccess, toolError, escapeIlike } from '../shared';

export const getProducts: ToolDefinition = {
  name: 'CHEFBYTE_get_products',
  description: 'List products with optional name search.',
  inputSchema: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Search term to filter by name (case-insensitive)' },
    },
  },
  handler: async (args, ctx) => {
    let query = ctx.supabase
      .schema('chefbyte')
      .from('products')
      .select(
        'product_id, name, barcode, description, servings_per_container, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, price, min_stock_amount, visual_unit_label, visual_units_per_serving',
      )
      .eq('user_id', ctx.userId)
      // Match the web UI's `useChefbyteProducts` hook: never return
      // soft-deleted products or internal [MEAL]% sentinel rows. Without
      // these filters, MCP and the Settings page disagreed (MCP returned
      // tombstoned rows that the UI hides), which led to a surprising
      // "16 vs 9 products" mismatch and confused recipe debugging.
      .is('deleted_at', null)
      .not('name', 'ilike', '[MEAL]%')
      .order('name', { ascending: true });

    if (args.search) {
      query = query.ilike('name', `%${escapeIlike(args.search)}%`);
    }

    const { data, error } = await query;

    if (error) return toolError(`Failed to fetch products: ${error.message}`);

    return toolSuccess({ products: data || [], total: (data || []).length });
  },
};
