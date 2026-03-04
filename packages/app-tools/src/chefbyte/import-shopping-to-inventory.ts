import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const importShoppingToInventory: ToolDefinition = {
  name: 'CHEFBYTE_import_shopping_to_inventory',
  description:
    'Import all purchased shopping list items into inventory as new stock lots, then remove them from the shopping list.',
  inputSchema: {
    type: 'object',
    properties: {
      location_id: {
        type: 'string',
        description: 'Storage location UUID. If omitted, uses the first location.',
      },
    },
  },
  handler: async (args, ctx) => {
    const { location_id } = args;

    // 1. Get all purchased items
    const { data: purchased, error: fetchError } = await ctx.supabase
      .schema('chefbyte')
      .from('shopping_list')
      .select('cart_item_id, product_id, qty_containers')
      .eq('user_id', ctx.userId)
      .eq('purchased', true);

    if (fetchError) return toolError(`Failed to fetch purchased items: ${fetchError.message}`);
    if (!purchased || purchased.length === 0) {
      return toolError('No purchased items to import');
    }

    // 2. Resolve location
    let resolvedLocationId = location_id;
    if (!resolvedLocationId) {
      const { data: locs, error: locError } = await ctx.supabase
        .schema('chefbyte')
        .from('locations')
        .select('location_id')
        .eq('user_id', ctx.userId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (locError || !locs?.length) {
        return toolError('No storage locations found. Activate ChefByte first.');
      }
      resolvedLocationId = (locs[0] as any).location_id;
    }

    // 3. Create stock lots for each purchased item
    const lots = purchased.map((item: any) => ({
      user_id: ctx.userId,
      product_id: item.product_id,
      qty_containers: item.qty_containers,
      location_id: resolvedLocationId,
    }));

    const { data: insertedLots, error: insertError } = await ctx.supabase
      .schema('chefbyte')
      .from('stock_lots')
      .insert(lots)
      .select('lot_id, product_id, qty_containers');

    if (insertError) return toolError(`Failed to create stock lots: ${insertError.message}`);

    // 4. Remove purchased items from shopping list
    const purchasedIds = purchased.map((item: any) => item.cart_item_id);
    const { error: deleteError } = await ctx.supabase
      .schema('chefbyte')
      .from('shopping_list')
      .delete()
      .in('cart_item_id', purchasedIds)
      .eq('user_id', ctx.userId);

    if (deleteError) {
      return toolError(`Stock lots created but failed to clear shopping list: ${deleteError.message}`);
    }

    return toolSuccess({
      message: `Imported ${insertedLots?.length ?? 0} item(s) into inventory`,
      lots_created: insertedLots?.length ?? 0,
      lots: (insertedLots || []).map((lot: any) => ({
        lot_id: lot.lot_id,
        product_id: lot.product_id,
        qty_containers: Number(lot.qty_containers),
      })),
    });
  },
};
