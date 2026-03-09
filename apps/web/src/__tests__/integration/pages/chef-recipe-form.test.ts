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
/*  chef-recipe-form page query integration tests                      */
/*                                                                     */
/*  Validates the EXACT Supabase queries used in RecipeFormPage.tsx    */
/*  against a real local Supabase database.                            */
/* ================================================================== */

let ctx: PageTestContext;
let productMap: Record<string, string>;
let recipeId: string;

beforeAll(async () => {
  ctx = await createPageTestContext('chef-recipe-form');
  productMap = await seedProducts(ctx);
  recipeId = await seedRecipe(ctx, productMap);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe('ChefByte RecipeFormPage queries', () => {
  /* ---------------------------------------------------------------- */
  /*  Single recipe fetch by ID — exact from RecipeFormPage.tsx        */
  /*  loadRecipe() line 97-103                                         */
  /* ---------------------------------------------------------------- */
  it('fetches single recipe by ID with ingredients + products join', async () => {
    // Exact query from RecipeFormPage.tsx loadRecipe()
    const result = await chefbyte(ctx.client)
      .from('recipes')
      .select(
        '*, recipe_ingredients(*, products:product_id(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))',
      )
      .eq('recipe_id', recipeId)
      .single();

    const recipe = assertQuerySucceeds(result, 'single recipe fetch');

    // Verify recipe fields the form page uses
    expect(recipe.name).toBe('Chicken & Rice');
    expect(recipe.description).toBe('Simple chicken and rice meal');
    expect(Number(recipe.base_servings)).toBe(2);
    expect(Number(recipe.active_time)).toBe(15);
    expect(Number(recipe.total_time)).toBe(30);
    // instructions is null for seeded recipe
    expect(recipe.instructions).toBeNull();

    // Verify recipe_ingredients with products sub-join
    expect(recipe.recipe_ingredients).not.toBeNull();
    expect(recipe.recipe_ingredients.length).toBe(2);

    // Verify Chicken Breast ingredient (0.5 container)
    const chickenIng = recipe.recipe_ingredients.find(
      (ri: any) => ri.product_id === productMap['Great Value Boneless Skinless Chicken Breasts'],
    );
    expect(chickenIng).toBeDefined();
    expect(Number(chickenIng.quantity)).toBe(0.5);
    expect(chickenIng.unit).toBe('container');
    expect(chickenIng.note).toBeNull();
    expect(chickenIng.products.name).toBe('Great Value Boneless Skinless Chicken Breasts');
    expect(Number(chickenIng.products.calories_per_serving)).toBe(165);
    expect(Number(chickenIng.products.protein_per_serving)).toBe(31);
    expect(Number(chickenIng.products.carbs_per_serving)).toBe(0);
    expect(Number(chickenIng.products.fat_per_serving)).toBeCloseTo(3.6, 1);
    expect(Number(chickenIng.products.servings_per_container)).toBe(4);

    // Verify Brown Rice ingredient (0.25 container)
    const riceIng = recipe.recipe_ingredients.find(
      (ri: any) => ri.product_id === productMap['Great Value Long Grain Brown Rice'],
    );
    expect(riceIng).toBeDefined();
    expect(Number(riceIng.quantity)).toBe(0.25);
    expect(riceIng.unit).toBe('container');
    expect(riceIng.products.name).toBe('Great Value Long Grain Brown Rice');
    expect(Number(riceIng.products.calories_per_serving)).toBe(216);
    expect(Number(riceIng.products.servings_per_container)).toBe(8);
  });

  /* ---------------------------------------------------------------- */
  /*  Products list query — exact from RecipeFormPage.tsx               */
  /*  searchProducts() line 149-155                                    */
  /* ---------------------------------------------------------------- */
  it('products list query for ingredient search dropdown', async () => {
    // Exact query from RecipeFormPage.tsx searchProducts()
    const result = await chefbyte(ctx.client)
      .from('products')
      .select(
        'product_id, name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container',
      )
      .eq('user_id', ctx.userId)
      .order('name');

    const products = assertQuerySucceeds(result, 'products list');
    expect(Array.isArray(products)).toBe(true);
    expect(products.length).toBe(5); // seedProducts creates 5

    // Verify ordering is alphabetical by name
    const names = products.map((p: any) => p.name);
    const sorted = [...names].sort((a: string, b: string) => a.localeCompare(b));
    expect(names).toEqual(sorted);

    // Verify all expected fields are returned
    for (const p of products) {
      expect(p).toHaveProperty('product_id');
      expect(p).toHaveProperty('name');
      expect(p).toHaveProperty('calories_per_serving');
      expect(p).toHaveProperty('carbs_per_serving');
      expect(p).toHaveProperty('protein_per_serving');
      expect(p).toHaveProperty('fat_per_serving');
      expect(p).toHaveProperty('servings_per_container');
    }

    // Check a specific product with exact seed values
    const chicken = products.find((p: any) => p.name === 'Great Value Boneless Skinless Chicken Breasts');
    expect(chicken).toBeDefined();
    expect(Number(chicken.calories_per_serving)).toBe(165);
    expect(Number(chicken.protein_per_serving)).toBe(31);
    expect(Number(chicken.carbs_per_serving)).toBe(0);
    expect(Number(chicken.fat_per_serving)).toBeCloseTo(3.6, 1);
    expect(Number(chicken.servings_per_container)).toBe(4);
  });

  /* ---------------------------------------------------------------- */
  /*  Recipe insert (create mode) — exact from RecipeFormPage.tsx       */
  /*  handleSave() line 281-293                                        */
  /* ---------------------------------------------------------------- */
  it('creates a new recipe with insert + select returning recipe_id', async () => {
    // Exact query from RecipeFormPage.tsx handleSave() create path
    const result = await chefbyte(ctx.client)
      .from('recipes')
      .insert({
        user_id: ctx.userId,
        name: 'Test Recipe Create',
        description: 'Integration test recipe',
        base_servings: 4,
        active_time: 20,
        total_time: 45,
        instructions: 'Step 1: Do the thing.\nStep 2: Do the other thing.',
      })
      .select('recipe_id')
      .single();

    const newRecipe = assertQuerySucceeds(result, 'recipe insert');
    expect(typeof newRecipe.recipe_id).toBe('string');
    expect(newRecipe.recipe_id.length).toBeGreaterThan(0);

    // Insert ingredients — exact from RecipeFormPage.tsx handleSave()
    const ingResult = await chefbyte(ctx.client).from('recipe_ingredients').insert({
      user_id: ctx.userId,
      recipe_id: newRecipe.recipe_id,
      product_id: productMap['Great Value Large White Eggs'],
      quantity: 3,
      unit: 'serving',
      note: 'scrambled',
    });
    expect(ingResult.error).toBeNull();

    // Verify the recipe was created by fetching it
    const fetchResult = await chefbyte(ctx.client)
      .from('recipes')
      .select(
        '*, recipe_ingredients(*, products:product_id(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))',
      )
      .eq('recipe_id', newRecipe.recipe_id)
      .single();

    const fetched = assertQuerySucceeds(fetchResult, 'verify created recipe');
    expect(fetched.name).toBe('Test Recipe Create');
    expect(fetched.description).toBe('Integration test recipe');
    expect(Number(fetched.base_servings)).toBe(4);
    expect(Number(fetched.active_time)).toBe(20);
    expect(Number(fetched.total_time)).toBe(45);
    expect(fetched.instructions).toBe('Step 1: Do the thing.\nStep 2: Do the other thing.');
    expect(fetched.recipe_ingredients.length).toBe(1);
    expect(fetched.recipe_ingredients[0].products.name).toBe('Great Value Large White Eggs');

    // Cleanup
    await chefbyte(ctx.client).from('recipe_ingredients').delete().eq('recipe_id', newRecipe.recipe_id);
    await chefbyte(ctx.client).from('recipes').delete().eq('recipe_id', newRecipe.recipe_id);
  });

  /* ---------------------------------------------------------------- */
  /*  Recipe update — exact from RecipeFormPage.tsx handleSave()        */
  /*  line 254-264                                                     */
  /* ---------------------------------------------------------------- */
  it('updates an existing recipe', async () => {
    // First, create a recipe to update
    const { data: created } = await chefbyte(ctx.client)
      .from('recipes')
      .insert({
        user_id: ctx.userId,
        name: 'Pre-Update Recipe',
        base_servings: 1,
      })
      .select('recipe_id')
      .single();
    expect(created).not.toBeNull();
    expect(typeof created!.recipe_id).toBe('string');
    const updateId = created!.recipe_id;

    // Exact update query from RecipeFormPage.tsx handleSave() edit path
    const updateResult = await chefbyte(ctx.client)
      .from('recipes')
      .update({
        name: 'Updated Recipe',
        description: 'Now has a description',
        base_servings: 3,
        active_time: 10,
        total_time: 25,
        instructions: 'Updated instructions',
      })
      .eq('recipe_id', updateId);
    expect(updateResult.error).toBeNull();

    // Verify
    const { data: fetched } = await chefbyte(ctx.client).from('recipes').select('*').eq('recipe_id', updateId).single();
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('Updated Recipe');
    expect(fetched!.description).toBe('Now has a description');
    expect(Number(fetched!.base_servings)).toBe(3);
    expect(Number(fetched!.active_time)).toBe(10);
    expect(Number(fetched!.total_time)).toBe(25);
    expect(fetched!.instructions).toBe('Updated instructions');

    // Cleanup
    await chefbyte(ctx.client).from('recipes').delete().eq('recipe_id', updateId);
  });

  /* ---------------------------------------------------------------- */
  /*  Recipe ingredients replace (delete old + insert new)             */
  /*  RecipeFormPage.tsx handleSave() edit path lines 267-278          */
  /* ---------------------------------------------------------------- */
  it('replaces recipe ingredients on update (delete + insert)', async () => {
    // Create a recipe with one ingredient
    const { data: r } = await chefbyte(ctx.client)
      .from('recipes')
      .insert({
        user_id: ctx.userId,
        name: 'Ingredient Replace Test',
        base_servings: 1,
      })
      .select('recipe_id')
      .single();
    expect(r).not.toBeNull();
    expect(typeof r!.recipe_id).toBe('string');
    const rid = r!.recipe_id;

    await chefbyte(ctx.client).from('recipe_ingredients').insert({
      user_id: ctx.userId,
      recipe_id: rid,
      product_id: productMap['Great Value Large White Eggs'],
      quantity: 2,
      unit: 'serving',
      note: null,
    });

    // Exact delete query from RecipeFormPage.tsx
    const delResult = await chefbyte(ctx.client).from('recipe_ingredients').delete().eq('recipe_id', rid);
    expect(delResult.error).toBeNull();

    // Exact insert query from RecipeFormPage.tsx (loop, one at a time)
    const ing1Result = await chefbyte(ctx.client).from('recipe_ingredients').insert({
      user_id: ctx.userId,
      recipe_id: rid,
      product_id: productMap['Banquet Chicken Breast Patties'],
      quantity: 1,
      unit: 'container',
      note: 'ripe',
    });
    expect(ing1Result.error).toBeNull();

    const ing2Result = await chefbyte(ctx.client).from('recipe_ingredients').insert({
      user_id: ctx.userId,
      recipe_id: rid,
      product_id: productMap['Birds Eye Sweet Peas'],
      quantity: 1,
      unit: 'serving',
      note: null,
    });
    expect(ing2Result.error).toBeNull();

    // Verify new ingredients
    const { data: ings } = await chefbyte(ctx.client)
      .from('recipe_ingredients')
      .select('product_id, quantity, unit, note')
      .eq('recipe_id', rid);
    expect(ings).toHaveLength(2);

    const banana = ings!.find((i: any) => i.product_id === productMap['Banquet Chicken Breast Patties']);
    expect(banana).toBeDefined();
    expect(Number(banana!.quantity)).toBe(1);
    expect(banana!.unit).toBe('container');
    expect(banana!.note).toBe('ripe');

    const protein = ings!.find((i: any) => i.product_id === productMap['Birds Eye Sweet Peas']);
    expect(protein).toBeDefined();
    expect(Number(protein!.quantity)).toBe(1);
    expect(protein!.unit).toBe('serving');

    // Cleanup
    await chefbyte(ctx.client).from('recipe_ingredients').delete().eq('recipe_id', rid);
    await chefbyte(ctx.client).from('recipes').delete().eq('recipe_id', rid);
  });

  /* ---------------------------------------------------------------- */
  /*  Recipe delete — exact from RecipeFormPage.tsx handleDelete()      */
  /*  line 318-319                                                     */
  /* ---------------------------------------------------------------- */
  it('deletes a recipe and its ingredients', async () => {
    // Create a recipe with an ingredient
    const { data: r } = await chefbyte(ctx.client)
      .from('recipes')
      .insert({
        user_id: ctx.userId,
        name: 'Delete Me Recipe',
        base_servings: 1,
      })
      .select('recipe_id')
      .single();
    expect(r).not.toBeNull();
    expect(typeof r!.recipe_id).toBe('string');
    const deleteId = r!.recipe_id;

    await chefbyte(ctx.client).from('recipe_ingredients').insert({
      user_id: ctx.userId,
      recipe_id: deleteId,
      product_id: productMap['Great Value Large White Eggs'],
      quantity: 1,
      unit: 'serving',
      note: null,
    });

    // Exact delete queries from RecipeFormPage.tsx handleDelete()
    const ingDel = await chefbyte(ctx.client).from('recipe_ingredients').delete().eq('recipe_id', deleteId);
    expect(ingDel.error).toBeNull();

    const recipeDel = await chefbyte(ctx.client).from('recipes').delete().eq('recipe_id', deleteId);
    expect(recipeDel.error).toBeNull();

    // Verify recipe is gone
    const { data: verify, error: verifyErr } = await chefbyte(ctx.client)
      .from('recipes')
      .select('recipe_id')
      .eq('recipe_id', deleteId);
    expect(verifyErr).toBeNull();
    expect(verify).toHaveLength(0);
  });

  /* ---------------------------------------------------------------- */
  /*  Recipe insert with null optional fields                          */
  /* ---------------------------------------------------------------- */
  it('creates recipe with null optional fields (description, active_time, total_time, instructions)', async () => {
    // Mirrors the page behavior when optional fields are left blank
    const result = await chefbyte(ctx.client)
      .from('recipes')
      .insert({
        user_id: ctx.userId,
        name: 'Minimal Recipe',
        description: null,
        base_servings: 1,
        active_time: null,
        total_time: null,
        instructions: null,
      })
      .select('recipe_id')
      .single();

    const created = assertQuerySucceeds(result, 'minimal recipe insert');

    const { data: fetched } = await chefbyte(ctx.client)
      .from('recipes')
      .select('*')
      .eq('recipe_id', created.recipe_id)
      .single();

    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('Minimal Recipe');
    expect(Number(fetched!.base_servings)).toBe(1);
    expect(fetched!.description).toBeNull();
    expect(fetched!.active_time).toBeNull();
    expect(fetched!.total_time).toBeNull();
    expect(fetched!.instructions).toBeNull();

    // Cleanup
    await chefbyte(ctx.client).from('recipes').delete().eq('recipe_id', created.recipe_id);
  });
});
