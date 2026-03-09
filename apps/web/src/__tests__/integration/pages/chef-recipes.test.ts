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
    expect(recipes.length).toBe(1);

    // Find the seeded recipe
    const recipe = recipes.find((r: any) => r.recipe_id === recipeId);
    expect(recipe).toBeDefined();
    expect(recipe.name).toBe('Chicken & Rice');
    expect(recipe.description).toBe('Simple chicken and rice meal');
    expect(Number(recipe.base_servings)).toBe(2);
    expect(Number(recipe.active_time)).toBe(15);
    expect(Number(recipe.total_time)).toBe(30);

    // Verify recipe_ingredients join
    expect(recipe.recipe_ingredients).not.toBeNull();
    expect(Array.isArray(recipe.recipe_ingredients)).toBe(true);
    expect(recipe.recipe_ingredients.length).toBe(2);

    // Verify Chicken Breast ingredient with exact seed values
    const chickenIng = recipe.recipe_ingredients.find(
      (i: any) => i.product_id === productMap['Great Value Boneless Skinless Chicken Breasts'],
    );
    expect(chickenIng).toBeDefined();
    expect(chickenIng.products).not.toBeNull();
    expect(chickenIng.products.name).toBe('Great Value Boneless Skinless Chicken Breasts');
    expect(Number(chickenIng.products.calories_per_serving)).toBe(165);
    expect(Number(chickenIng.products.protein_per_serving)).toBe(31);
    expect(Number(chickenIng.products.carbs_per_serving)).toBe(0);
    expect(Number(chickenIng.products.fat_per_serving)).toBeCloseTo(3.6, 1);
    expect(Number(chickenIng.products.servings_per_container)).toBe(4);
    expect(Number(chickenIng.quantity)).toBe(0.5);
    expect(chickenIng.unit).toBe('container');

    // Verify Brown Rice ingredient with exact seed values
    const riceIng = recipe.recipe_ingredients.find(
      (i: any) => i.product_id === productMap['Great Value Long Grain Brown Rice'],
    );
    expect(riceIng).toBeDefined();
    expect(riceIng.products).not.toBeNull();
    expect(riceIng.products.name).toBe('Great Value Long Grain Brown Rice');
    expect(Number(riceIng.products.calories_per_serving)).toBe(216);
    expect(Number(riceIng.products.protein_per_serving)).toBe(5);
    expect(Number(riceIng.products.carbs_per_serving)).toBe(45);
    expect(Number(riceIng.products.fat_per_serving)).toBeCloseTo(1.8, 1);
    expect(Number(riceIng.products.servings_per_container)).toBe(8);
    expect(Number(riceIng.quantity)).toBe(0.25);
    expect(riceIng.unit).toBe('container');
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
    expect(emptyRecipe).toBeDefined();
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
    expect(recipe).toBeDefined();

    // Verify exact values from seed
    expect(recipe.recipe_id).toBe(recipeId);
    expect(recipe.user_id).toBe(ctx.userId);
    expect(recipe.name).toBe('Chicken & Rice');
    expect(recipe.description).toBe('Simple chicken and rice meal');
    expect(Number(recipe.base_servings)).toBe(2);
    expect(Number(recipe.active_time)).toBe(15);
    expect(Number(recipe.total_time)).toBe(30);
    expect(recipe.instructions).toBeNull();
    expect(recipe.recipe_ingredients.length).toBe(2);

    // Ingredient fields — verify exact shape and values
    const ing = recipe.recipe_ingredients[0];
    expect(typeof ing.ingredient_id).toBe('string');
    expect(typeof Number(ing.quantity)).toBe('number');
    expect(typeof ing.unit).toBe('string');
    // note can be null or string
    expect(ing.products).not.toBeNull();
  });
});
