import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const createRecipe: ToolDefinition = {
  name: 'CHEFBYTE_create_recipe',
  description: 'Create a recipe with ingredients.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Recipe name' },
      instructions: { type: 'string', description: 'Cooking instructions (optional)' },
      servings: { type: 'integer', description: 'Number of servings (optional)' },
      prep_time: { type: 'integer', description: 'Prep time in minutes (optional)' },
      ingredients: {
        type: 'array',
        description: 'List of ingredients',
        items: {
          type: 'object',
          properties: {
            product_id: { type: 'string', description: 'Product UUID' },
            qty_containers: { type: 'number', description: 'Quantity in containers' },
          },
          required: ['product_id', 'qty_containers'],
        },
      },
    },
    required: ['name', 'ingredients'],
  },
  handler: async (args, ctx) => {
    const { name, instructions, servings, prep_time, ingredients } = args;

    if (!ingredients || ingredients.length === 0) {
      return toolError('At least one ingredient is required');
    }

    // Insert recipe
    const recipeRow: Record<string, any> = { user_id: ctx.userId, name };
    if (instructions !== undefined) recipeRow.instructions = instructions;
    if (servings !== undefined) recipeRow.servings = servings;
    if (prep_time !== undefined) recipeRow.prep_time = prep_time;

    const { data: recipe, error: recipeError } = await ctx.supabase
      .schema('chefbyte')
      .from('recipes')
      .insert(recipeRow)
      .select('recipe_id, name, servings, prep_time')
      .single();

    if (recipeError) return toolError(`Failed to create recipe: ${recipeError.message}`);

    // Insert ingredients
    const ingredientRows = ingredients.map((ing: any) => ({
      recipe_id: recipe.recipe_id,
      product_id: ing.product_id,
      qty_containers: ing.qty_containers,
    }));

    const { error: ingError } = await ctx.supabase
      .schema('chefbyte')
      .from('recipe_ingredients')
      .insert(ingredientRows);

    if (ingError) {
      // Clean up the recipe if ingredients fail
      await ctx.supabase
        .schema('chefbyte')
        .from('recipes')
        .delete()
        .eq('recipe_id', recipe.recipe_id);
      return toolError(`Failed to add ingredients: ${ingError.message}`);
    }

    return toolSuccess({
      message: `Recipe "${name}" created with ${ingredients.length} ingredient(s)`,
      recipe,
    });
  },
};
