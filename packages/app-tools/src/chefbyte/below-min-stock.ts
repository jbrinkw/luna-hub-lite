import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const belowMinStock: ToolDefinition = {
  name: 'CHEFBYTE_below_min_stock',
  description: 'Find products below minimum stock level. Optionally auto-add deficits to shopping list.',
  inputSchema: {
    type: 'object',
    properties: {
      auto_add: {
        type: 'boolean',
        description: 'Automatically add deficit quantities to shopping list (default false)',
      },
    },
  },
  handler: async (args, ctx) => {
    const autoAdd = args.auto_add === true;

    // Get products with a min_stock_amount set
    const { data: products, error: prodError } = await ctx.supabase
      .schema('chefbyte')
      .from('products')
      .select('product_id, name, min_stock_amount')
      .eq('user_id', ctx.userId)
      .not('min_stock_amount', 'is', null)
      .gt('min_stock_amount', 0);

    if (prodError) return toolError(`Failed to fetch products: ${prodError.message}`);
    if (!products || products.length === 0) {
      return toolSuccess({ below_min: [], total: 0, message: 'No products have minimum stock set' });
    }

    // Get current stock sums per product
    const { data: lots, error: lotError } = await ctx.supabase
      .schema('chefbyte')
      .from('stock_lots')
      .select('product_id, qty_containers')
      .eq('user_id', ctx.userId)
      .gt('qty_containers', 0);

    if (lotError) return toolError(`Failed to fetch stock: ${lotError.message}`);

    const stockMap: Record<string, number> = {};
    for (const lot of lots || []) {
      stockMap[lot.product_id] = (stockMap[lot.product_id] || 0) + Number(lot.qty_containers);
    }

    const belowMin: any[] = [];
    for (const prod of products) {
      const current = stockMap[prod.product_id] || 0;
      const min = Number(prod.min_stock_amount);
      if (current < min) {
        const deficit = Math.ceil(min - current);
        belowMin.push({
          product_id: prod.product_id,
          product_name: prod.name,
          min_stock: min,
          current_stock: current,
          deficit,
        });
      }
    }

    if (autoAdd && belowMin.length > 0) {
      const rows = belowMin.map((item) => ({
        user_id: ctx.userId,
        product_id: item.product_id,
        qty_containers: item.deficit,
      }));

      const { error: upsertError } = await ctx.supabase
        .schema('chefbyte')
        .from('shopping_list')
        .upsert(rows, { onConflict: 'user_id,product_id' });

      if (upsertError)
        return toolError(
          `Found ${belowMin.length} below-min products but failed to add to shopping list: ${upsertError.message}`,
        );
    }

    return toolSuccess({
      below_min: belowMin,
      total: belowMin.length,
      added_to_shopping: autoAdd && belowMin.length > 0,
    });
  },
};
