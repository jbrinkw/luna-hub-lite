import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPageTestContext,
  chefbyte,
  seedProducts,
  seedRecipe,
  assertQuerySucceeds,
  type PageTestContext,
} from './helpers';

/* ================================================================== */
/*  chef-recipes page query integration tests                          */
/*                                                                     */
/*  Validates the EXACT Supabase queries used in RecipesPage.tsx       */
/*  against a real local Supabase database.                            */
/* ================================================================== */

let ctx: PageTestContext;
let productMap: Record<string, string>;
let recipeId: string;

beforeAll(async () => {
  ctx = await createPageTestContext('chef-recipes');
  productMap = await seedProducts(ctx);
  recipeId = await seedRecipe(ctx, productMap);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe('ChefByte RecipesPage queries', () => {
  /* ---------------------------------------------------------------- */
  /*  Main recipe list query — exact from RecipesPage.tsx loadData()   */
  /* ---------------------------------------------------------------- */
  it('recipes list query with recipe_ingredients + products join', async () => {
    // Exact query from RecipesPage.tsx line 122-128
    const result = await chefbyte(ctx.client)
      .from('recipes')
      .select(
        '*, recipe_ingredients(*, products:product_id(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))',
      )
      .eq('user_id', ctx.userId)
      .order('name');

    const recipes = assertQuerySucceeds(result, 'recipes list');
    expect(Array.isArray(recipes)).toBe(true);
    expect(recipes.length).toBeGreaterThanOrEqual(1);

    // Find the seeded recipe
    const recipe = recipes.find((r: any) => r.recipe_id === recipeId);
    expect(recipe).toBeTruthy();
    expect(recipe.name).toBe('Chicken & Rice');
    expect(recipe.description).toBe('Simple chicken and rice meal');
    expect(Number(recipe.base_servings)).toBe(2);
    expect(Number(recipe.active_time)).toBe(15);
    expect(Number(recipe.total_time)).toBe(30);

    // Verify recipe_ingredients join
    expect(recipe.recipe_ingredients).toBeDefined();
    expect(Array.isArray(recipe.recipe_ingredients)).toBe(true);
    expect(recipe.recipe_ingredients.length).toBe(2);

    // Verify products sub-join (product_id aliased as "products")
    for (const ing of recipe.recipe_ingredients) {
      expect(ing.products).toBeTruthy();
      expect(ing.products.name).toBeDefined();
      expect(ing.products.calories_per_serving).toBeDefined();
      expect(ing.products.carbs_per_serving).toBeDefined();
      expect(ing.products.protein_per_serving).toBeDefined();
      expect(ing.products.fat_per_serving).toBeDefined();
      expect(ing.products.servings_per_container).toBeDefined();
    }

    // Check one specific ingredient
    const chickenIng = recipe.recipe_ingredients.find((i: any) => i.product_id === productMap['Chicken Breast']);
    expect(chickenIng).toBeTruthy();
    expect(chickenIng.products.name).toBe('Chicken Breast');
    expect(Number(chickenIng.products.calories_per_serving)).toBe(165);
    expect(Number(chickenIng.products.protein_per_serving)).toBe(31);
    expect(Number(chickenIng.products.servings_per_container)).toBe(4);
  });

  /* ---------------------------------------------------------------- */
  /*  Recipe ordering                                                  */
  /* ---------------------------------------------------------------- */
  it('recipes are returned ordered by name', async () => {
    // Insert a second recipe to verify ordering
    const { data: second, error: insertErr } = await chefbyte(ctx.client)
      .from('recipes')
      .insert({
        user_id: ctx.userId,
        name: 'Avocado Toast',
        base_servings: 1,
        active_time: 5,
        total_time: 5,
      })
      .select('recipe_id')
      .single();
    expect(insertErr).toBeNull();

    // Exact query from RecipesPage.tsx
    const result = await chefbyte(ctx.client)
      .from('recipes')
      .select(
        '*, recipe_ingredients(*, products:product_id(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))',
      )
      .eq('user_id', ctx.userId)
      .order('name');

    const recipes = assertQuerySucceeds(result, 'ordered recipes');
    expect(recipes.length).toBeGreaterThanOrEqual(2);

    // "Avocado Toast" should come before "Chicken & Rice" alphabetically
    const names = recipes.map((r: any) => r.name);
    const avocadoIdx = names.indexOf('Avocado Toast');
    const chickenIdx = names.indexOf('Chicken & Rice');
    expect(avocadoIdx).toBeLessThan(chickenIdx);

    // Cleanup the second recipe
    await chefbyte(ctx.client).from('recipes').delete().eq('recipe_id', second!.recipe_id);
  });

  /* ---------------------------------------------------------------- */
  /*  Recipe with no ingredients returns empty array                   */
  /* ---------------------------------------------------------------- */
  it('recipe with no ingredients returns empty recipe_ingredients array', async () => {
    // Create a recipe with no ingredients
    const { data: bare, error: bareErr } = await chefbyte(ctx.client)
      .from('recipes')
      .insert({
        user_id: ctx.userId,
        name: 'Empty Recipe',
        base_servings: 1,
      })
      .select('recipe_id')
      .single();
    expect(bareErr).toBeNull();

    // Exact query from RecipesPage.tsx
    const result = await chefbyte(ctx.client)
      .from('recipes')
      .select(
        '*, recipe_ingredients(*, products:product_id(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))',
      )
      .eq('user_id', ctx.userId)
      .order('name');

    const recipes = assertQuerySucceeds(result, 'bare recipe');
    const emptyRecipe = recipes.find((r: any) => r.recipe_id === bare!.recipe_id);
    expect(emptyRecipe).toBeTruthy();
    expect(emptyRecipe.recipe_ingredients).toEqual([]);

    // Cleanup
    await chefbyte(ctx.client).from('recipes').delete().eq('recipe_id', bare!.recipe_id);
  });

  /* ---------------------------------------------------------------- */
  /*  All recipe fields are present                                    */
  /* ---------------------------------------------------------------- */
  it('recipe row shape includes all fields used by the page', async () => {
    const result = await chefbyte(ctx.client)
      .from('recipes')
      .select(
        '*, recipe_ingredients(*, products:product_id(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))',
      )
      .eq('user_id', ctx.userId)
      .order('name');

    const recipes = assertQuerySucceeds(result, 'field shape');
    const recipe = recipes.find((r: any) => r.recipe_id === recipeId);
    expect(recipe).toBeTruthy();

    // All fields the page uses
    expect(recipe).toHaveProperty('recipe_id');
    expect(recipe).toHaveProperty('user_id');
    expect(recipe).toHaveProperty('name');
    expect(recipe).toHaveProperty('description');
    expect(recipe).toHaveProperty('base_servings');
    expect(recipe).toHaveProperty('active_time');
    expect(recipe).toHaveProperty('total_time');
    expect(recipe).toHaveProperty('instructions');
    expect(recipe).toHaveProperty('recipe_ingredients');

    // Ingredient fields
    const ing = recipe.recipe_ingredients[0];
    expect(ing).toHaveProperty('ingredient_id');
    expect(ing).toHaveProperty('quantity');
    expect(ing).toHaveProperty('unit');
    expect(ing).toHaveProperty('note');
    expect(ing).toHaveProperty('products');
  });
});
