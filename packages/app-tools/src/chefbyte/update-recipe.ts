import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

/**
 * Updates a recipe's metadata and/or ingredient list.
 *
 * - Any meta field can be omitted; only provided fields are updated.
 * - If `ingredients` is provided, the FULL list is replaced via the
 *   `save_recipe_ingredients` RPC (delete-old + insert-new in a single
 *   transaction). Pass an empty array to clear ingredients (the RPC will
 *   reject if recipes require ≥1, but we don't enforce that here — the
 *   caller chose).
 * - If `ingredients` is omitted, the existing ingredient list stays
 *   untouched.
 */
export const updateRecipe: ToolDefinition = {
  name: 'CHEFBYTE_update_recipe',
  description:
    'Update an existing recipe. Pass any subset of metadata fields to patch them; ' +
    'pass `ingredients` to fully replace the ingredient list (atomic). RLS enforces ownership.',
  inputSchema: {
    type: 'object',
    properties: {
      recipe_id: { type: 'string', description: 'The recipe UUID to update' },
      name: { type: 'string', description: 'New recipe name (optional)' },
      description: { type: 'string', description: 'New description (optional)' },
      base_servings: { type: 'number', description: 'Number of servings the recipe yields (optional)' },
      active_time: { type: 'integer', description: 'Active/prep time in minutes (optional)' },
      total_time: { type: 'integer', description: 'Total time in minutes (optional)' },
      instructions: { type: 'string', description: 'Cooking instructions/directions (optional)' },
      ingredients: {
        type: 'array',
        description:
          "New ingredient list (optional). When provided, replaces the recipe's entire ingredient list atomically.",
        items: {
          type: 'object',
          properties: {
            product_id: { type: 'string', description: 'Product UUID' },
            quantity: { type: 'number', description: 'Quantity value' },
            unit: {
              type: 'string',
              enum: ['container', 'serving', 'gram'],
              description: 'Unit of measure (default: container)',
            },
            note: { type: 'string', description: 'Optional ingredient note' },
          },
          required: ['product_id', 'quantity'],
        },
      },
    },
    required: ['recipe_id'],
  },
  handler: async (args, ctx) => {
    const { recipe_id, name, description, base_servings, active_time, total_time, instructions, ingredients } = args;

    if (typeof recipe_id !== 'string' || recipe_id.length === 0) {
      return toolError('recipe_id is required');
    }

    // Patch recipe metadata if any field is provided.
    const metaPatch: Record<string, any> = {};
    if (name !== undefined) metaPatch.name = name;
    if (description !== undefined) metaPatch.description = description;
    if (base_servings !== undefined) metaPatch.base_servings = base_servings;
    if (active_time !== undefined) metaPatch.active_time = active_time;
    if (total_time !== undefined) metaPatch.total_time = total_time;
    if (instructions !== undefined) metaPatch.instructions = instructions;

    if (Object.keys(metaPatch).length > 0) {
      const { data, error } = await ctx.supabase
        .schema('chefbyte')
        .from('recipes')
        .update(metaPatch)
        .eq('recipe_id', recipe_id)
        .eq('user_id', ctx.userId)
        .select('recipe_id, name');
      if (error) return toolError(`Failed to update recipe: ${error.message}`);
      if (!data || data.length === 0) return toolError('Recipe not found or does not belong to you');
    }

    // Replace ingredient list if provided. Uses the canonical RPC so the
    // delete-old + insert-new happens atomically server-side.
    if (Array.isArray(ingredients)) {
      const payload = ingredients.map((ing: any) => ({
        product_id: ing.product_id,
        quantity: ing.quantity,
        unit: ing.unit ?? 'container',
        note: ing.note ?? null,
      }));
      // The MCP worker runs as service_role with no JWT, so auth.uid() is NULL
      // inside the RPC. The 2-arg public wrapper forwards
      // private.save_recipe_ingredients((SELECT auth.uid()), …) → p_user_id=NULL
      // → the ownership guard always raises 'Recipe not found'. Call the
      // service_role-only _admin overload with ctx.userId instead (H-17 / T3).
      const { error: rpcErr } = await (ctx.supabase as any).schema('chefbyte').rpc('save_recipe_ingredients_admin', {
        p_user_id: ctx.userId,
        p_recipe_id: recipe_id,
        p_ingredients: payload,
      });
      if (rpcErr) return toolError(`Failed to replace ingredients: ${rpcErr.message}`);
    }

    return toolSuccess({
      success: true,
      message: `Recipe ${recipe_id} updated`,
      recipe_id,
      meta_fields_updated: Object.keys(metaPatch),
      ingredients_replaced: Array.isArray(ingredients),
    });
  },
};
