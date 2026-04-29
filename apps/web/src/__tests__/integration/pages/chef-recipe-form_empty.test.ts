import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPageTestContext, chefbyte, assertQuerySucceeds, type PageTestContext } from './helpers';

/* Empty-fixture sibling for chef-recipe-form.test.ts (L9 audit) */

describe('ChefByte RecipeForm queries — empty fixture', () => {
  let ctx: PageTestContext;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-recipe-form-empty');
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('products list returns [] when the user has not created any', async () => {
    // The recipe-form ingredient picker queries products for autocomplete.
    // Empty result must NOT crash: page falls back to a "no products yet"
    // banner with a link to the inventory page.
    const result = await chefbyte(ctx.client)
      .from('products')
      .select('product_id,name,servings_per_container')
      .eq('user_id', ctx.userId)
      .order('name');

    const data = assertQuerySucceeds(result, 'products');
    expect(data).toEqual([]);
  });

  it('recipe_ingredients query for a non-existent recipe returns []', async () => {
    const fakeRecipeId = '00000000-0000-0000-0000-000000000000';
    const result = await chefbyte(ctx.client)
      .from('recipe_ingredients')
      .select('product_id,quantity,unit')
      .eq('recipe_id', fakeRecipeId);

    const data = assertQuerySucceeds(result, 'recipe_ingredients');
    expect(data).toEqual([]);
  });
});
