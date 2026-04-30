import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const markDone: ToolDefinition = {
  name: 'CHEFBYTE_mark_done',
  description:
    'Mark a meal plan entry as completed (works for both regular and meal-prep entries). ' +
    'Deducts available stock and logs macros for what was actually consumed. ' +
    'Completes the meal regardless of stock shortage — any shorted ingredients are ' +
    'reported in the returned `partials` array.',
  inputSchema: {
    type: 'object',
    properties: {
      meal_id: { type: 'string', description: 'The meal plan entry UUID' },
    },
    required: ['meal_id'],
  },
  handler: async (args, ctx) => {
    const { meal_id } = args;

    const { data, error } = await ctx.supabase.schema('chefbyte').rpc('mark_meal_done_admin', {
      p_user_id: ctx.userId,
      p_meal_id: meal_id,
    });

    if (error) return toolError(`Failed to mark meal done: ${error.message}`);

    // Surface partials clearly so the LLM/user knows which ingredients
    // were out of stock but the meal was still completed.
    const result = data as {
      success: boolean;
      meal_id: string;
      mode: string;
      partials?: Array<{ product_id: string; needed: number; available: number }>;
      completed_at: string;
    } | null;

    if (result?.partials && result.partials.length > 0) {
      return toolSuccess({
        ...result,
        warning:
          `Meal completed with ${result.partials.length} out-of-stock ingredient(s). ` +
          `Deducted what was available; macros reflect actual consumption. ` +
          `Shorted: ${result.partials.map((p) => `product ${p.product_id} (needed ${p.needed}, had ${p.available})`).join(', ')}`,
      });
    }

    return toolSuccess(data);
  },
};
