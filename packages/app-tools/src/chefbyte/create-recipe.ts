import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const createRecipe: ToolDefinition = {
  name: 'CHEFBYTE_create_recipe',
  description: 'Create a recipe with ingredients.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Recipe name' },
      description: { type: 'string', description: 'Recipe description (optional)' },
      base_servings: { type: 'number', description: 'Number of servings (optional)' },
      active_time: { type: 'integer', description: 'Active/prep time in minutes (optional)' },
      total_time: { type: 'integer', description: 'Total time in minutes (optional)' },
      instructions: { type: 'string', description: 'Cooking instructions/directions (optional)' },
      ingredients: {
        type: 'array',
        description: 'List of ingredients',
        items: {
          type: 'object',
          properties: {
            product_id: { type: 'string', description: 'Product UUID' },
            quantity: { type: 'number', description: 'Quantity value' },
            unit: {
              type: 'string',
              enum: ['container', 'serving'],
              description: 'Unit of measure (default: container)',
            },
          },
          required: ['product_id', 'quantity'],
        },
      },
    },
    required: ['name', 'ingredients'],
  },
  handler: async (args, ctx) => {
    const { name, description, base_servings, active_time, total_time, instructions, ingredients } = args;

    if (!ingredients || ingredients.length === 0) {
      return toolError('At least one ingredient is required');
    }

    // Insert recipe
    const recipeRow: Record<string, any> = { user_id: ctx.userId, name };
    if (description !== undefined) recipeRow.description = description;
    if (base_servings !== undefined) recipeRow.base_servings = base_servings;
    if (active_time !== undefined) recipeRow.active_time = active_time;
    if (total_time !== undefined) recipeRow.total_time = total_time;
    if (instructions !== undefined) recipeRow.instructions = instructions;

    const { data: recipe, error: recipeError } = await ctx.supabase
      .schema('chefbyte')
      .from('recipes')
      .insert(recipeRow)
      .select('recipe_id, name, base_servings, active_time, total_time, instructions')
      .single();

    if (recipeError) return toolError(`Failed to create recipe: ${recipeError.message}`);

    // Insert ingredients
    const ingredientRows = ingredients.map((ing: any) => ({
      recipe_id: recipe.recipe_id,
      product_id: ing.product_id,
      user_id: ctx.userId,
      quantity: ing.quantity,
      unit: ing.unit || 'container',
    }));

    const { error: ingError } = await ctx.supabase.schema('chefbyte').from('recipe_ingredients').insert(ingredientRows);

    if (ingError) {
      // Clean up the recipe if ingredients fail
      await ctx.supabase.schema('chefbyte').from('recipes').delete().eq('recipe_id', recipe.recipe_id);
      return toolError(`Failed to add ingredients: ${ingError.message}`);
    }

    return toolSuccess({
      message: `Recipe "${name}" created with ${ingredients.length} ingredient(s)`,
      recipe,
    });
  },
};
