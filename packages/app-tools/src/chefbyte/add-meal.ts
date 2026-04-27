import type { ToolDefinition } from '../types';
import { toolSuccess, toolError, getLogicalDate } from '../shared';

export const addMeal: ToolDefinition = {
  name: 'CHEFBYTE_add_meal',
  description:
    'Add a meal plan entry. Must specify at least one of recipe_id or product_id. ' +
    "logical_date is OPTIONAL — if omitted, defaults to the user's current logical date " +
    '(derived from profile timezone + day_start_hour), matching consume/log_temp_item semantics.',
  inputSchema: {
    type: 'object',
    properties: {
      logical_date: {
        type: 'string',
        description: "Plan date YYYY-MM-DD. Optional — defaults to the user's current logical date when omitted.",
      },
      meal_prep: { type: 'boolean', description: 'Whether this is a meal prep entry (default: false)' },
      recipe_id: { type: 'string', description: 'Recipe UUID (optional if product_id given)' },
      product_id: { type: 'string', description: 'Product UUID (optional if recipe_id given)' },
      servings: { type: 'number', description: 'Number of servings (optional)' },
    },
    // logical_date is no longer required — server derives it when absent.
  },
  handler: async (args, ctx) => {
    const { logical_date, meal_prep, recipe_id, product_id, servings } = args;

    if (!recipe_id && !product_id) {
      return toolError('At least one of recipe_id or product_id is required');
    }

    // Bug 5 fix: if the caller didn't supply logical_date, derive it
    // server-side the same way consume/log_temp_item do. This eliminates the
    // wall-clock-UTC drift where an AI agent would compute "today" and land
    // meal entries on a different logical day than food_logs.
    const effectiveLogicalDate =
      typeof logical_date === 'string' && logical_date.length > 0
        ? logical_date
        : await getLogicalDate(ctx.supabase, ctx.userId);

    const row: Record<string, any> = {
      user_id: ctx.userId,
      logical_date: effectiveLogicalDate,
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
