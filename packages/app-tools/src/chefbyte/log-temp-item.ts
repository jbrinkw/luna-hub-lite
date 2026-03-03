import type { ToolDefinition } from '../types';
import { toolSuccess, toolError, getLogicalDate } from '../shared';

export const logTempItem: ToolDefinition = {
  name: 'CHEFBYTE_log_temp_item',
  description: 'Log a temporary food item (not linked to a product) for macro tracking.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Item name/description' },
      calories: { type: 'number', description: 'Calories' },
      carbs: { type: 'number', description: 'Carbs in grams (optional)' },
      protein: { type: 'number', description: 'Protein in grams (optional)' },
      fat: { type: 'number', description: 'Fat in grams (optional)' },
    },
    required: ['name', 'calories'],
  },
  handler: async (args, ctx) => {
    const { name, calories, carbs, protein, fat } = args;

    const logicalDate = await getLogicalDate(ctx.supabase, ctx.userId);

    const row: Record<string, any> = {
      user_id: ctx.userId,
      name,
      calories,
      carbs: carbs ?? 0,
      protein: protein ?? 0,
      fat: fat ?? 0,
      logical_date: logicalDate,
    };

    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('temp_items')
      .insert(row)
      .select('temp_id, name, calories, carbs, protein, fat, logical_date')
      .single();

    if (error) return toolError(`Failed to log temp item: ${error.message}`);

    return toolSuccess({ message: `Logged "${name}" (${calories} cal)`, item: data });
  },
};
