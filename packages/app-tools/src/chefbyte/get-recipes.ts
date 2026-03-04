import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const getRecipes: ToolDefinition = {
  name: 'CHEFBYTE_get_recipes',
  description: 'Get recipes with their ingredients. Optional name search.',
  inputSchema: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Search term to filter by name (case-insensitive)' },
    },
  },
  handler: async (args, ctx) => {
    let query = ctx.supabase
      .schema('chefbyte')
      .from('recipes')
      .select(
        'recipe_id, name, description, instructions, base_servings, active_time, total_time, created_at, recipe_ingredients(ingredient_id, product_id, quantity, unit, products(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))',
      )
      .eq('user_id', ctx.userId)
      .order('name', { ascending: true });

    if (args.search) {
      query = query.ilike('name', `%${args.search}%`);
    }

    const { data, error } = await query;

    if (error) return toolError(`Failed to fetch recipes: ${error.message}`);

    const recipes = (data || []).map((r: any) => {
      const ingredients = (r.recipe_ingredients || []).map((ri: any) => ({
        ingredient_id: ri.ingredient_id,
        product_id: ri.product_id,
        product_name: ri.products?.name ?? null,
        quantity: Number(ri.quantity),
        unit: ri.unit,
        macros_per_container: ri.products
          ? {
              calories: Number(ri.products.calories_per_serving || 0) * Number(ri.products.servings_per_container || 1),
              carbs: Number(ri.products.carbs_per_serving || 0) * Number(ri.products.servings_per_container || 1),
              protein: Number(ri.products.protein_per_serving || 0) * Number(ri.products.servings_per_container || 1),
              fat: Number(ri.products.fat_per_serving || 0) * Number(ri.products.servings_per_container || 1),
            }
          : null,
      }));

      return {
        recipe_id: r.recipe_id,
        name: r.name,
        description: r.description,
        instructions: r.instructions ?? null,
        base_servings: r.base_servings ? Number(r.base_servings) : null,
        active_time: r.active_time,
        total_time: r.total_time,
        ingredients,
      };
    });

    return toolSuccess({ recipes, total: recipes.length });
  },
};
