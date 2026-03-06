import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const addStock: ToolDefinition = {
  name: 'CHEFBYTE_add_stock',
  description: 'Add stock by inserting a new lot for a product.',
  inputSchema: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'The product UUID' },
      qty_containers: { type: 'number', description: 'Number of containers to add' },
      location_id: { type: 'string', description: 'Storage location UUID (optional)' },
      expires_on: { type: 'string', description: 'Expiration date YYYY-MM-DD (optional)' },
    },
    required: ['product_id', 'qty_containers'],
  },
  handler: async (args, ctx) => {
    const { product_id, qty_containers, location_id, expires_on } = args;

    if (!Number.isFinite(qty_containers) || qty_containers <= 0)
      return toolError('qty_containers must be a positive finite number');

    // Resolve location_id: use provided, or fetch default (first by created_at)
    let resolvedLocationId = location_id;
    if (!resolvedLocationId) {
      const { data: locs, error: locError } = await ctx.supabase
        .schema('chefbyte')
        .from('locations')
        .select('location_id')
        .eq('user_id', ctx.userId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (locError || !locs?.length) return toolError('No storage locations found. Activate ChefByte first.');
      resolvedLocationId = (locs[0] as any).location_id;
    }

    const row: Record<string, any> = {
      user_id: ctx.userId,
      product_id,
      qty_containers,
      location_id: resolvedLocationId,
    };
    if (expires_on) row.expires_on = expires_on;

    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('stock_lots')
      .insert(row)
      .select('lot_id, qty_containers, expires_on, location_id')
      .single();

    if (error) return toolError(`Failed to add stock: ${error.message}`);

    return toolSuccess({
      message: `Added ${qty_containers} container(s)`,
      lot: data,
    });
  },
};
