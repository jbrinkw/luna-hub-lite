import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const getMealPlan: ToolDefinition = {
  name: 'CHEFBYTE_get_meal_plan',
  description: 'Get meal plan entries for a date range.',
  inputSchema: {
    type: 'object',
    properties: {
      start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
      end_date: { type: 'string', description: 'End date YYYY-MM-DD' },
    },
    required: ['start_date', 'end_date'],
  },
  handler: async (args, ctx) => {
    const { start_date, end_date } = args;

    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('meal_plan_entries')
      .select(
        'meal_id, logical_date, meal_prep, recipe_id, product_id, servings, completed_at, recipes(name), products(name)',
      )
      .eq('user_id', ctx.userId)
      .gte('logical_date', start_date)
      .lte('logical_date', end_date)
      .order('logical_date', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) return toolError(`Failed to fetch meal plan: ${error.message}`);

    const entries = (data || []).map((e: any) => ({
      meal_id: e.meal_id,
      logical_date: e.logical_date,
      meal_prep: e.meal_prep,
      recipe_id: e.recipe_id,
      recipe_name: e.recipes?.name ?? null,
      product_id: e.product_id,
      product_name: e.products?.name ?? null,
      servings: e.servings ? Number(e.servings) : null,
      completed: !!e.completed_at,
      completed_at: e.completed_at,
    }));

    return toolSuccess({ entries, total: entries.length });
  },
};
