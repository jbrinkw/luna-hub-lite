import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

/**
 * Update any user-editable field on a product. Mirrors the Settings →
 * Products edit form so an MCP-driven flow can do everything the UI can.
 *
 * Skipped (not user-editable via this tool):
 *   - product_id, user_id, created_at, updated_at — system-managed
 *   - is_placeholder — set by the scanner; promoted automatically on
 *     barcode-match. Manual flips create confusing state.
 *   - deleted_at — use CHEFBYTE_delete_product (soft-delete).
 *
 * Validation is enforced at the DB level via CHECK constraints (e.g.
 * products_visual_pair_complete: visual_unit_label and
 * visual_units_per_serving must both be NULL or both NOT NULL with
 * units > 0).
 */
export const updateProduct: ToolDefinition = {
  name: 'CHEFBYTE_update_product',
  description: 'Update product fields by product_id. Validates ownership.',
  inputSchema: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'Product UUID to update' },
      name: { type: 'string', description: 'Product name' },
      barcode: { type: ['string', 'null'], description: 'Barcode (UPC/EAN). Null clears it.' },
      description: { type: ['string', 'null'], description: 'Free-text description (optional)' },
      servings_per_container: { type: 'number', description: 'Servings per container' },
      calories_per_serving: { type: 'number', description: 'Calories per serving' },
      carbs_per_serving: { type: 'number', description: 'Carbs per serving (g)' },
      protein_per_serving: { type: 'number', description: 'Protein per serving (g)' },
      fat_per_serving: { type: 'number', description: 'Fat per serving (g)' },
      min_stock_amount: { type: 'number', description: 'Minimum stock threshold (containers)' },
      walmart_link: { type: ['string', 'null'], description: 'Walmart product URL (or "NOT_ON_WALMART")' },
      price: { type: ['number', 'null'], description: 'Price per container (USD)' },
      net_weight_g: {
        type: ['number', 'null'],
        description:
          'Full container mass in grams. Required when display_by_weight or unit="gram" recipes use this product.',
      },
      tare_weight_g: {
        type: ['number', 'null'],
        description: 'Empty container mass in grams. Set by the LiveTrack enrollment flow; rarely set manually.',
      },
      default_expiry_days: {
        type: ['integer', 'null'],
        description: 'AI-estimated days until expiry from import date. Range 1–730. Null = non-perishable / unknown.',
      },
      default_recipe_unit: {
        type: ['string', 'null'],
        enum: ['gram', 'serving', 'container', null],
        description:
          'Initial unit when this product is added to a recipe. Null = auto (gram if net_weight_g > 0, else serving).',
      },
      is_distinct_unit_item: {
        type: 'boolean',
        description: 'True when 1 serving = 1 physical piece (eggs, buns, slices, bars). False for bulk items.',
      },
      certified: {
        type: ['boolean', 'null'],
        description: 'True when AI/user has confirmed macros are correct. Null when not yet reviewed.',
      },
      visual_unit_label: {
        type: ['string', 'null'],
        description:
          'Display-only unit name (e.g. "egg", "slice", "bun"). Both this and visual_units_per_serving must be set together (or both null). Backend math always uses canonical unit + servings.',
      },
      visual_units_per_serving: {
        type: ['number', 'null'],
        description:
          'How many of the visual unit equal one serving (e.g. 1 = 1 slice / serving, 0.5 = half a bagel / serving). Must be > 0 when set. Both-or-neither with visual_unit_label.',
      },
      display_by_weight: {
        type: 'boolean',
        description:
          'When true and net_weight_g > 0, the UI renders quantities as weight (grams or ounces, per user preference). Display-only; backend math reads canonical unit + quantity.',
      },
    },
    required: ['product_id'],
  },
  handler: async (args, ctx) => {
    const { product_id, ...fields } = args;

    const updatableFields = [
      'name',
      'barcode',
      'description',
      'servings_per_container',
      'calories_per_serving',
      'carbs_per_serving',
      'protein_per_serving',
      'fat_per_serving',
      'min_stock_amount',
      'walmart_link',
      'price',
      'net_weight_g',
      'tare_weight_g',
      'default_expiry_days',
      'default_recipe_unit',
      'is_distinct_unit_item',
      'certified',
      'visual_unit_label',
      'visual_units_per_serving',
      'display_by_weight',
    ];

    const updates: Record<string, any> = {};
    for (const field of updatableFields) {
      if (fields[field] !== undefined) {
        updates[field] = fields[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return toolError('No fields to update. Provide at least one field besides product_id.');
    }

    const { data, error } = await ctx.supabase
      .schema('chefbyte')
      .from('products')
      .update(updates)
      .eq('product_id', product_id)
      .eq('user_id', ctx.userId)
      .select('product_id, name, barcode')
      .single();

    if (error) {
      // PGRST116: "Cannot coerce the result to a single JSON object" — 0 rows
      // matched the update filter. Rewrap as a friendly not-found message.
      if ((error as any).code === 'PGRST116') {
        return toolError('Product not found or does not belong to you');
      }
      return toolError(`Failed to update product: ${error.message}`);
    }
    if (!data) return toolError('Product not found or does not belong to you');

    return toolSuccess({
      message: `Product "${data.name}" updated`,
      product: data,
      fields_updated: Object.keys(updates),
    });
  },
};
