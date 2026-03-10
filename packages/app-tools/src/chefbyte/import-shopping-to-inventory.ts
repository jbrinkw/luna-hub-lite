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

    // 3. Create or merge stock lots for each purchased item
    const resultLots: Array<{ lot_id: string; product_id: string; qty_containers: number }> = [];
    for (const item of purchased as any[]) {
      // Check for existing lot with same (product_id, location_id, expires_on=null)
      const { data: existingLot } = await ctx.supabase
        .schema('chefbyte')
        .from('stock_lots')
        .select('lot_id, qty_containers')
        .eq('user_id', ctx.userId)
        .eq('product_id', item.product_id)
        .eq('location_id', resolvedLocationId)
        .is('expires_on', null)
        .single();

      if (existingLot) {
        // Merge: increment qty on existing lot
        const { data: updated, error: updateErr } = await ctx.supabase
          .schema('chefbyte')
          .from('stock_lots')
          .update({ qty_containers: Number((existingLot as any).qty_containers) + Number(item.qty_containers) })
          .eq('lot_id', (existingLot as any).lot_id)
          .select('lot_id, product_id, qty_containers')
          .single();
        if (updateErr) return toolError(`Failed to update stock lot: ${updateErr.message}`);
        if (updated) resultLots.push(updated as any);
      } else {
        // Insert new lot
        const { data: inserted, error: insertErr } = await ctx.supabase
          .schema('chefbyte')
          .from('stock_lots')
          .insert({
            user_id: ctx.userId,
            product_id: item.product_id,
            qty_containers: item.qty_containers,
            location_id: resolvedLocationId,
          })
          .select('lot_id, product_id, qty_containers')
          .single();
        if (insertErr) return toolError(`Failed to create stock lot: ${insertErr.message}`);
        if (inserted) resultLots.push(inserted as any);
      }
    }

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
      message: `Imported ${resultLots.length} item(s) into inventory`,
      lots_created: resultLots.length,
      lots: resultLots.map((lot: any) => ({
        lot_id: lot.lot_id,
        product_id: lot.product_id,
        qty_containers: Number(lot.qty_containers),
      })),
    });
  },
};
