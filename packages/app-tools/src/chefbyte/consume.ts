import type { ToolDefinition } from '../types';
import { toolSuccess, toolError, getLogicalDate } from '../shared';

export const consume: ToolDefinition = {
  name: 'CHEFBYTE_consume',
  description: 'Consume product stock (deducts from oldest lots first). Optionally logs macros.',
  inputSchema: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'The product UUID' },
      qty: { type: 'number', description: 'Amount to consume' },
      unit: {
        type: 'string',
        enum: ['container', 'serving'],
        description: 'Unit of qty (container or serving)',
      },
      log_macros: {
        type: 'boolean',
        description: 'Whether to log macros for this consumption (default true)',
      },
    },
    required: ['product_id', 'qty', 'unit'],
  },
  handler: async (args, ctx) => {
    const { product_id, qty, unit } = args;
    const logMacros = args.log_macros !== false;

    if (qty <= 0) return toolError('qty must be positive');

    const logicalDate = await getLogicalDate(ctx.supabase, ctx.userId);

    const { data, error } = await ctx.supabase.schema('chefbyte').rpc('consume_product_admin', {
      p_user_id: ctx.userId,
      p_product_id: product_id,
      p_qty: qty,
      p_unit: unit,
      p_log_macros: logMacros,
      p_logical_date: logicalDate,
    });

    if (error) return toolError(`Failed to consume: ${error.message}`);

    return toolSuccess(data);
  },
};
