import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const importShoppingToInventory: ToolDefinition = {
  name: 'CHEFBYTE_import_shopping_to_inventory',
  description:
    'Import all purchased shopping list items into inventory as new stock lots. Source rows are stamped with imported_at (not deleted) so the operation is idempotent — a second call processes 0 items.',
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

    // Single-call RPC. Handles location resolution, stock_lot merge/insert,
    // and imported_at stamping atomically. Prevents double-imports and
    // orphaned stock_lots if a step mid-batch fails.
    const { data, error } = await (ctx.supabase as any)
      .schema('chefbyte')
      .rpc('import_shopping_to_inventory', { p_location_id: location_id ?? null });

    if (error) return toolError(`Failed to import shopping list: ${error.message}`);

    const result = (data ?? {}) as { success?: boolean; lots_processed?: number; imported_at?: string };

    if (!result.success || !result.lots_processed) {
      return toolError('No purchased items to import');
    }

    return toolSuccess({
      message: `Imported ${result.lots_processed} item(s) into inventory`,
      lots_created: result.lots_processed,
      imported_at: result.imported_at,
    });
  },
};
