import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const getShoppingList: ToolDefinition = {
  name: 'CHEFBYTE_get_shopping_list',
  description: 'Get the current shopping list with product details.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, ctx) => {
    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('shopping_list')
      .select('id, product_id, qty_containers, notes, products(name, price)')
      .eq('user_id', ctx.userId)
      .order('products(name)', { ascending: true });

    if (error) return toolError(`Failed to fetch shopping list: ${error.message}`);

    const items = (data || []).map((item: any) => ({
      id: item.id,
      product_id: item.product_id,
      product_name: item.products?.name ?? null,
      qty_containers: Number(item.qty_containers),
      price: item.products?.price ? Number(item.products.price) : null,
      estimated_cost: item.products?.price
        ? Number(item.qty_containers) * Number(item.products.price)
        : null,
      notes: item.notes,
    }));

    const totalCost = items.reduce(
      (sum: number, item: any) => sum + (item.estimated_cost ?? 0),
      0,
    );

    return toolSuccess({ items, total_items: items.length, estimated_total: totalCost });
  },
};
