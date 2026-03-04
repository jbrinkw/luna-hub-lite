import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const deleteMealEntry: ToolDefinition = {
  name: 'CHEFBYTE_delete_meal_entry',
  description: 'Delete a meal plan entry by meal_id. Validates ownership.',
  inputSchema: {
    type: 'object',
    properties: {
      meal_id: { type: 'string', description: 'The meal plan entry UUID to delete' },
    },
    required: ['meal_id'],
  },
  handler: async (args, ctx) => {
    const { meal_id } = args;

    // Verify the entry exists and belongs to the user
    const { data: existing, error: fetchError } = await ctx.supabase
      .schema('chefbyte')
      .from('meal_plan_entries')
      .select('meal_id')
      .eq('meal_id', meal_id)
      .eq('user_id', ctx.userId)
      .single();

    if (fetchError || !existing) {
      return toolError('Meal plan entry not found or does not belong to you');
    }

    const { error } = await ctx.supabase
      .schema('chefbyte')
      .from('meal_plan_entries')
      .delete()
      .eq('meal_id', meal_id)
      .eq('user_id', ctx.userId);

    if (error) return toolError(`Failed to delete meal entry: ${error.message}`);

    return toolSuccess({ message: 'Meal plan entry deleted', meal_id });
  },
};
