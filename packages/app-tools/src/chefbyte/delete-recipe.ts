import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const deleteRecipe: ToolDefinition = {
  name: 'CHEFBYTE_delete_recipe',
  description:
    "Delete a recipe by recipe_id. Cascades to recipe_ingredients. " +
    "Fails if any meal_plan_entries still reference the recipe — delete those first. " +
    "RLS enforces ownership.",
  inputSchema: {
    type: 'object',
    properties: {
      recipe_id: { type: 'string', description: 'The recipe UUID to delete' },
    },
    required: ['recipe_id'],
  },
  handler: async (args, ctx) => {
    const { recipe_id } = args;
    if (typeof recipe_id !== 'string' || recipe_id.length === 0) {
      return toolError('recipe_id is required');
    }

    // Pre-check: do any meal_plan_entries reference this recipe? If so, the
    // FK (ON DELETE NO ACTION / default) will block the delete. Surface a
    // cleaner error before the DB rejects us.
    const { data: refs, error: refErr } = await ctx.supabase
      .schema('chefbyte')
      .from('meal_plan_entries')
      .select('meal_id')
      .eq('user_id', ctx.userId)
      .eq('recipe_id', recipe_id)
      .limit(1);

    if (refErr) return toolError(`Failed to check meal plan references: ${refErr.message}`);
    if (refs && refs.length > 0) {
      return toolError(
        'Cannot delete recipe: meal plan entries still reference it. Delete those meal entries first.',
      );
    }

    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('recipes')
      .delete()
      .eq('recipe_id', recipe_id)
      .eq('user_id', ctx.userId)
      .select('recipe_id, name');

    if (error) return toolError(`Failed to delete recipe: ${error.message}`);
    if (!data || data.length === 0) return toolError('Recipe not found or does not belong to you');

    return toolSuccess({
      success: true,
      message: `Recipe "${data[0].name}" deleted`,
      deleted: data[0],
    });
  },
};
