/**
 * Integration tests for CHEFBYTE_create_product distinct-unit fields.
 *
 * Covers:
 *   1. is_distinct_unit_item=true + default_recipe_unit='serving' → stored correctly.
 *   2. default_recipe_unit='gram' + no net_weight_g → handler downgrades to 'serving'
 *      and message contains the downgrade note.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUser, createToolContext, parseToolResult, admin } from './helpers';
import type { ToolContext } from '../../types';
import { createProduct } from '../../chefbyte/create-product';

describe('CHEFBYTE_create_product — distinct-unit fields', () => {
  let userId: string;
  let ctx: ToolContext;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const user = await createTestUser('chefbyte-distinct-unit');
    userId = user.userId;
    ctx = createToolContext(userId);
    cleanup = user.cleanup;
  }, 30_000);

  afterAll(async () => {
    await cleanup();
  });

  it('stores is_distinct_unit_item=true + default_recipe_unit=serving', async () => {
    const result = await createProduct.handler(
      {
        name: 'Test Hamburger Buns',
        servings_per_container: 8,
        calories_per_serving: 120,
        protein_per_serving: 4,
        carbs_per_serving: 22,
        fat_per_serving: 2,
        is_distinct_unit_item: true,
        default_recipe_unit: 'serving',
      },
      ctx,
    );

    const data = parseToolResult(result);
    expect(data.message).toContain('Test Hamburger Buns');
    expect(data.product.product_id).toBeTruthy();

    // Verify the row in DB has the expected values
    const { data: row } = await admin
      .schema('chefbyte')
      .from('products')
      .select('is_distinct_unit_item, default_recipe_unit, net_weight_g')
      .eq('product_id', data.product.product_id)
      .single();

    expect(row).not.toBeNull();
    expect(row!.is_distinct_unit_item).toBe(true);
    expect(row!.default_recipe_unit).toBe('serving');
    expect(row!.net_weight_g).toBeNull();
  });

  it('downgrades default_recipe_unit gram→serving when net_weight_g not provided', async () => {
    const result = await createProduct.handler(
      {
        name: 'Test Mystery Bulk Item',
        servings_per_container: 4,
        calories_per_serving: 200,
        protein_per_serving: 5,
        carbs_per_serving: 30,
        fat_per_serving: 8,
        is_distinct_unit_item: false,
        default_recipe_unit: 'gram',
        // net_weight_g intentionally omitted
      },
      ctx,
    );

    const data = parseToolResult(result);

    // Message must contain the downgrade note
    expect(data.message).toContain('gram unit downgraded to serving because net_weight_g not provided');

    // DB row must have default_recipe_unit='serving' (downgraded)
    const { data: row } = await admin
      .schema('chefbyte')
      .from('products')
      .select('default_recipe_unit, net_weight_g, is_distinct_unit_item')
      .eq('product_id', data.product.product_id)
      .single();

    expect(row!.default_recipe_unit).toBe('serving');
    expect(row!.net_weight_g).toBeNull();
    expect(row!.is_distinct_unit_item).toBe(false);
  });

  it('stores default_recipe_unit=gram when net_weight_g > 0 is provided', async () => {
    const result = await createProduct.handler(
      {
        name: 'Test Plain Greek Yogurt',
        servings_per_container: 1,
        calories_per_serving: 100,
        protein_per_serving: 17,
        carbs_per_serving: 6,
        fat_per_serving: 0,
        is_distinct_unit_item: false,
        default_recipe_unit: 'gram',
        net_weight_g: 170,
      },
      ctx,
    );

    const data = parseToolResult(result);
    // No downgrade note
    expect(data.message).not.toContain('downgraded');

    const { data: row } = await admin
      .schema('chefbyte')
      .from('products')
      .select('default_recipe_unit, net_weight_g, is_distinct_unit_item')
      .eq('product_id', data.product.product_id)
      .single();

    expect(row!.default_recipe_unit).toBe('gram');
    expect(Number(row!.net_weight_g)).toBe(170);
    expect(row!.is_distinct_unit_item).toBe(false);
  });
});
