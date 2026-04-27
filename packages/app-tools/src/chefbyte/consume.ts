import type { ToolDefinition } from '../types';
import { toolSuccess, toolError, getLogicalDate } from '../shared';

// Tool-side schema guard. The SQL side enforces these too (HARD_QTY_CEILING,
// SOFT_CAL_CEILING in 20260424030000_consume_bounds.sql) but rejecting at
// the tool boundary avoids a DB round-trip and gives the agent a cleaner
// error string to reason about.
const QTY_MAX = 10000;

export const consume: ToolDefinition = {
  name: 'CHEFBYTE_consume',
  description:
    'Consume product stock (deducts from oldest lots first). Optionally logs macros. ' +
    'Rejects qty > 10000. If the derived calorie load exceeds 10000 kcal, the DB will ' +
    'reject unless confirm_large_amount=true is passed.',
  inputSchema: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'The product UUID' },
      qty: {
        type: 'number',
        description: `Amount to consume. Must be > 0 and <= ${QTY_MAX}.`,
        minimum: 0,
        maximum: QTY_MAX,
      },
      unit: {
        type: 'string',
        enum: ['container', 'serving'],
        description: 'Unit of qty (container or serving)',
      },
      log_macros: {
        type: 'boolean',
        description: 'Whether to log macros for this consumption (default true)',
      },
      confirm_large_amount: {
        type: 'boolean',
        description:
          'Set true to bypass the calorie-load sanity gate (>10000 kcal). Use only when ' +
          'the large amount is deliberate (e.g. a batch of meal prep). Default false.',
      },
    },
    required: ['product_id', 'qty', 'unit'],
  },
  handler: async (args, ctx) => {
    const { product_id, qty, unit } = args;
    const logMacros = args.log_macros !== false;
    const confirmLargeAmount = args.confirm_large_amount === true;

    if (!Number.isFinite(qty) || qty <= 0) return toolError('qty must be a positive finite number');
    if (qty > QTY_MAX) {
      return toolError(`qty ${qty} exceeds hard ceiling of ${QTY_MAX}. Value is outside any plausible consumption.`);
    }

    const logicalDate = await getLogicalDate(ctx.supabase, ctx.userId);

    const { data, error } = await ctx.supabase.schema('chefbyte').rpc('consume_product_admin', {
      p_user_id: ctx.userId,
      p_product_id: product_id,
      p_qty: qty,
      p_unit: unit,
      p_log_macros: logMacros,
      p_logical_date: logicalDate,
      p_confirm_large_amount: confirmLargeAmount,
    });

    if (error) return toolError(`Failed to consume: ${error.message}`);

    return toolSuccess(data);
  },
};
