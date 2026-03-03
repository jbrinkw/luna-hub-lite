import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const addMeal: ToolDefinition = {
  name: 'CHEFBYTE_add_meal',
  description: 'Add a meal plan entry. Must specify at least one of recipe_id or product_id.',
  inputSchema: {
    type: 'object',
    properties: {
      logical_date: { type: 'string', description: 'Plan date YYYY-MM-DD' },
      meal_prep: { type: 'boolean', description: 'Whether this is a meal prep entry (default: false)' },
      recipe_id: { type: 'string', description: 'Recipe UUID (optional if product_id given)' },
      product_id: { type: 'string', description: 'Product UUID (optional if recipe_id given)' },
      servings: { type: 'number', description: 'Number of servings (optional)' },
    },
    required: ['logical_date'],
  },
  handler: async (args, ctx) => {
    const { logical_date, meal_prep, recipe_id, product_id, servings } = args;

    if (!recipe_id && !product_id) {
      return toolError('At least one of recipe_id or product_id is required');
    }

    const row: Record<string, any> = {
      user_id: ctx.userId,
      logical_date,
      meal_prep: meal_prep ?? false,
    };
    if (recipe_id) row.recipe_id = recipe_id;
    if (product_id) row.product_id = product_id;
    if (servings !== undefined) row.servings = servings;

    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('meal_plan_entries')
      .insert(row)
      .select('meal_id, logical_date, meal_prep, recipe_id, product_id, servings')
      .single();

    if (error) return toolError(`Failed to add meal: ${error.message}`);

    return toolSuccess({ message: 'Meal plan entry added', meal: data });
  },
};
