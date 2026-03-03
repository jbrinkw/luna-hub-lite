import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const getCookable: ToolDefinition = {
  name: 'CHEFBYTE_get_cookable',
  description: 'Find recipes that can be made with current stock.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, ctx) => {
    // Get all recipes with ingredients
    const { data: recipes, error: recipeError } = await ctx.supabase
      .schema('chefbyte')
      .from('recipes')
      .select('recipe_id, name, base_servings, recipe_ingredients(product_id, quantity, unit)')
      .eq('user_id', ctx.userId);

    if (recipeError) return toolError(`Failed to fetch recipes: ${recipeError.message}`);
    if (!recipes || recipes.length === 0) {
      return toolSuccess({ cookable: [], total: 0, message: 'No recipes found' });
    }

    // Get stock sums by product
    const { data: lots, error: lotError } = await ctx.supabase
      .schema('chefbyte')
      .from('stock_lots')
      .select('product_id, qty_containers')
      .eq('user_id', ctx.userId)
      .gt('qty_containers', 0);

    if (lotError) return toolError(`Failed to fetch stock: ${lotError.message}`);

    const stockMap: Record<string, number> = {};
    for (const lot of lots || []) {
      stockMap[lot.product_id] = (stockMap[lot.product_id] || 0) + Number(lot.qty_containers);
    }

    const cookable: any[] = [];

    for (const recipe of recipes) {
      const ingredients = recipe.recipe_ingredients || [];
      if (ingredients.length === 0) continue;

      let maxBatches = Infinity;
      let canCook = true;

      for (const ing of ingredients) {
        const needed = Number(ing.quantity);
        const available = stockMap[ing.product_id] || 0;

        if (needed <= 0) continue;

        if (available < needed) {
          canCook = false;
          break;
        }

        const batches = Math.floor(available / needed);
        if (batches < maxBatches) maxBatches = batches;
      }

      if (canCook && maxBatches > 0 && maxBatches < Infinity) {
        const baseServings = recipe.base_servings ? Number(recipe.base_servings) : null;
        cookable.push({
          recipe_id: recipe.recipe_id,
          name: recipe.name,
          servings_per_batch: baseServings,
          max_batches: maxBatches,
          max_servings: baseServings ? maxBatches * baseServings : null,
        });
      }
    }

    return toolSuccess({ cookable, total: cookable.length });
  },
};
