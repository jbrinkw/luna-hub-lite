import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const addToShopping: ToolDefinition = {
  name: 'CHEFBYTE_add_to_shopping',
  description:
    'Add containers of a product to the shopping list. Additive: calling twice for the same product sums the quantities (qty=3 then qty=2 → final qty=5).',
  inputSchema: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'The product UUID' },
      qty_containers: { type: 'number', description: 'Number of containers to add (additive on conflict)' },
    },
    required: ['product_id', 'qty_containers'],
  },
  handler: async (args, ctx) => {
    const { product_id, qty_containers } = args;

    if (!Number.isFinite(qty_containers) || qty_containers <= 0)
      return toolError('qty_containers must be a positive finite number');

    // Use the additive RPC: INSERT ... ON CONFLICT DO UPDATE SET qty = existing + EXCLUDED.
    // The previous PostgREST upsert was REPLACE-on-conflict, which violated the
    // "additive upsert" spec and caused the 2026-04-22 E2E audit's Bug 2.
    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .rpc('add_to_shopping_admin', {
        p_user_id: ctx.userId,
        p_product_id: product_id,
        p_qty: qty_containers,
      });

    if (error) return toolError(`Failed to add to shopping list: ${error.message}`);
    const row: any = Array.isArray(data) ? data[0] : data;
    if (!row) return toolError('Failed to add to shopping list: no row returned');
    return toolSuccess({
      message: `Added ${qty_containers} container(s) to shopping list`,
      item: {
        id: row.out_cart_item_id,
        product_id: row.out_product_id,
        qty_containers: Number(row.out_qty_containers),
      },
    });
  },
};
