import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const getInventory: ToolDefinition = {
  name: 'CHEFBYTE_get_inventory',
  description: 'Get current inventory grouped by product with total stock and nearest expiration.',
  inputSchema: {
    type: 'object',
    properties: {
      include_lots: {
        type: 'boolean',
        description: 'Include individual lot details per product (default false)',
      },
    },
  },
  handler: async (args, ctx) => {
    const includeLots = args.include_lots === true;

    const { data: lots, error } = await ctx.supabase
      .schema('chefbyte')
      .from('stock_lots')
      .select(
        'lot_id, product_id, qty_containers, expires_on, location_id, created_at, products(name), locations(name)',
      )
      .eq('user_id', ctx.userId)
      .gt('qty_containers', 0)
      .order('expires_on', { ascending: true, nullsFirst: false });

    if (error) return toolError(`Failed to fetch inventory: ${error.message}`);

    const grouped: Record<string, any> = {};

    for (const lot of lots || []) {
      const pid = lot.product_id;
      if (!grouped[pid]) {
        grouped[pid] = {
          product_id: pid,
          product_name: lot.products?.name ?? null,
          total_containers: 0,
          nearest_expiry: null as string | null,
          lots: [] as any[],
        };
      }

      const g = grouped[pid];
      g.total_containers += Number(lot.qty_containers);

      if (lot.expires_on && (!g.nearest_expiry || lot.expires_on < g.nearest_expiry)) {
        g.nearest_expiry = lot.expires_on;
      }

      if (includeLots) {
        g.lots.push({
          lot_id: lot.lot_id,
          qty_containers: Number(lot.qty_containers),
          expires_on: lot.expires_on,
          location: lot.locations?.name ?? null,
          location_id: lot.location_id,
        });
      }
    }

    const inventory = Object.values(grouped).map((g: any) => {
      const result: any = {
        product_id: g.product_id,
        product_name: g.product_name,
        total_containers: g.total_containers,
        nearest_expiry: g.nearest_expiry,
      };
      if (includeLots) result.lots = g.lots;
      return result;
    });

    return toolSuccess({ inventory, total_products: inventory.length });
  },
};
