import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const getProductLots: ToolDefinition = {
  name: 'CHEFBYTE_get_product_lots',
  description: 'Get all stock lots for a specific product.',
  inputSchema: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'The product UUID' },
    },
    required: ['product_id'],
  },
  handler: async (args, ctx) => {
    const { product_id } = args;

    const { data: lots, error } = await ctx.supabase
      .schema('chefbyte')
      .from('stock_lots')
      .select('lot_id, qty_containers, expires_on, meal_label, location_id, created_at, locations(name)')
      .eq('user_id', ctx.userId)
      .eq('product_id', product_id)
      .gt('qty_containers', 0)
      .order('expires_on', { ascending: true, nullsFirst: false });

    if (error) return toolError(`Failed to fetch lots: ${error.message}`);

    const result = (lots || []).map((lot: any) => ({
      lot_id: lot.lot_id,
      qty_containers: Number(lot.qty_containers),
      expires_on: lot.expires_on,
      meal_label: lot.meal_label,
      location: lot.locations?.name ?? null,
      location_id: lot.location_id,
      created_at: lot.created_at,
    }));

    return toolSuccess({ product_id, lots: result, total_lots: result.length });
  },
};
