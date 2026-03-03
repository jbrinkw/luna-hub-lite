import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getInventory } from '../chefbyte/get-inventory';
import { consume } from '../chefbyte/consume';
import { getProducts } from '../chefbyte/get-products';
import { createProduct } from '../chefbyte/create-product';
import { addStock } from '../chefbyte/add-stock';
import { getMacros } from '../chefbyte/get-macros';
import { markDone } from '../chefbyte/mark-done';
import { belowMinStock } from '../chefbyte/below-min-stock';
import { getCookable } from '../chefbyte/get-cookable';
import { createRecipe } from '../chefbyte/create-recipe';

// ---------------------------------------------------------------------------
// Mock factory — same pattern as coachbyte tests
// ---------------------------------------------------------------------------

interface ChainMock {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  neq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  not: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  gte: ReturnType<typeof vi.fn>;
  lte: ReturnType<typeof vi.fn>;
  gt: ReturnType<typeof vi.fn>;
  lt: ReturnType<typeof vi.fn>;
  ilike: ReturnType<typeof vi.fn>;
  then?: (resolve: (v: any) => void, reject?: (e: any) => void) => void;
  data: any;
  error: any;
}

function createChain(): ChainMock {
  const chain: any = {};
  const methods = [
    'select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit',
    'single', 'maybeSingle', 'insert', 'update', 'delete', 'upsert',
    'gte', 'lte', 'gt', 'lt', 'ilike',
  ];
  methods.forEach((m) => {
    chain[m] = vi.fn(() => chain);
  });
  chain.data = null;
  chain.error = null;
  // Make the chain thenable so `await chain` resolves to { data, error }
  chain.then = function (
    resolve: (v: any) => void,
    _reject?: (e: any) => void,
  ) {
    return Promise.resolve({ data: chain.data, error: chain.error }).then(resolve, _reject);
  };
  return chain;
}

function createMockSupabase() {
  const hubChain = createChain();
  const cbChain = createChain();

  const hubFrom = vi.fn(() => hubChain);
  const hubRpc = vi.fn((): any => ({ data: null, error: null }));
  const cbFrom = vi.fn(() => cbChain);
  const cbRpc = vi.fn((): any => ({ data: null, error: null }));

  const schemaMap: Record<string, { from: any; rpc: any }> = {
    hub: { from: hubFrom, rpc: hubRpc },
    chefbyte: { from: cbFrom, rpc: cbRpc },
  };

  const schema = vi.fn((name: string) => schemaMap[name] ?? { from: vi.fn(), rpc: vi.fn() });

  // Top-level rpc (used when handler calls supabase.rpc() directly)
  const rpc = vi.fn((): any => ({ data: null, error: null }));

  return {
    supabase: { schema, rpc } as any,
    schema,
    rpc,
    hubChain,
    cbChain,
    hubFrom,
    cbFrom,
    hubRpc,
    cbRpc,
  };
}

const USER_ID = 'user-uuid-123';

function ctx(supabase: any) {
  return { userId: USER_ID, supabase };
}

/** Parse the JSON text from a toolSuccess/toolError result */
function parseResult(result: any) {
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return result.content[0].text;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CHEFBYTE_get_inventory', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('returns grouped inventory on success', async () => {
    mock.cbChain.data = [
      {
        lot_id: 'lot-1', product_id: 'p-1', qty_containers: 3,
        expires_on: '2026-04-01', meal_label: null, location_id: 'loc-1',
        created_at: '2026-03-01T00:00:00Z',
        products: { name: 'Chicken Breast', category: 'Protein' },
        locations: { name: 'Fridge' },
      },
      {
        lot_id: 'lot-2', product_id: 'p-1', qty_containers: 2,
        expires_on: '2026-03-20', meal_label: null, location_id: 'loc-1',
        created_at: '2026-03-01T00:00:00Z',
        products: { name: 'Chicken Breast', category: 'Protein' },
        locations: { name: 'Fridge' },
      },
      {
        lot_id: 'lot-3', product_id: 'p-2', qty_containers: 1,
        expires_on: null, meal_label: null, location_id: null,
        created_at: '2026-03-01T00:00:00Z',
        products: { name: 'Rice', category: 'Grain' },
        locations: null,
      },
    ];
    mock.cbChain.error = null;

    const result = await getInventory.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.total_products).toBe(2);
    expect(parsed.inventory).toHaveLength(2);

    const chicken = parsed.inventory.find((i: any) => i.product_name === 'Chicken Breast');
    expect(chicken.total_containers).toBe(5);
    expect(chicken.nearest_expiry).toBe('2026-03-20');

    const rice = parsed.inventory.find((i: any) => i.product_name === 'Rice');
    expect(rice.total_containers).toBe(1);
    expect(rice.nearest_expiry).toBeNull();
  });

  it('includes lot details when include_lots is true', async () => {
    mock.cbChain.data = [
      {
        lot_id: 'lot-1', product_id: 'p-1', qty_containers: 3,
        expires_on: '2026-04-01', meal_label: null, location_id: 'loc-1',
        created_at: '2026-03-01T00:00:00Z',
        products: { name: 'Oats', category: 'Grain' },
        locations: { name: 'Pantry' },
      },
    ];
    mock.cbChain.error = null;

    const result = await getInventory.handler({ include_lots: true }, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.inventory[0].lots).toHaveLength(1);
    expect(parsed.inventory[0].lots[0].lot_id).toBe('lot-1');
    expect(parsed.inventory[0].lots[0].location).toBe('Pantry');
  });

  it('returns error when query fails', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'db timeout' };

    const result = await getInventory.handler({}, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('db timeout');
  });
});

describe('CHEFBYTE_consume', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
    // getLogicalDate reads hub.profiles
    mock.hubChain.data = { timezone: 'America/New_York', day_start_hour: 6 };
    mock.hubChain.error = null;
  });

  it('calls consume_product_admin RPC with correct args', async () => {
    mock.rpc.mockReturnValue({
      data: { consumed: 2, remaining_stock: 3, macros_logged: true },
      error: null,
    });

    const result = await consume.handler(
      { product_id: 'p-1', qty: 2, unit: 'container' },
      ctx(mock.supabase),
    );

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.consumed).toBe(2);
    expect(parsed.macros_logged).toBe(true);

    expect(mock.rpc).toHaveBeenCalledWith(
      'consume_product_admin',
      expect.objectContaining({
        p_user_id: USER_ID,
        p_product_id: 'p-1',
        p_qty: 2,
        p_unit: 'container',
        p_log_macros: true,
      }),
      { schema: 'chefbyte' },
    );
  });

  it('rejects non-positive qty', async () => {
    const result = await consume.handler(
      { product_id: 'p-1', qty: 0, unit: 'serving' },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('qty must be positive');
  });

  it('returns error when RPC fails', async () => {
    mock.rpc.mockReturnValue({ data: null, error: { message: 'insufficient stock' } });

    const result = await consume.handler(
      { product_id: 'p-1', qty: 100, unit: 'container' },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('insufficient stock');
  });
});

describe('CHEFBYTE_get_products', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('returns product list on success', async () => {
    mock.cbChain.data = [
      { product_id: 'p-1', name: 'Chicken', category: 'Protein', calories_per_serving: 165 },
      { product_id: 'p-2', name: 'Rice', category: 'Grain', calories_per_serving: 200 },
    ];
    mock.cbChain.error = null;

    const result = await getProducts.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.total).toBe(2);
    expect(parsed.products).toHaveLength(2);
    // Verify chefbyte schema was used
    expect(mock.schema).toHaveBeenCalledWith('chefbyte');
    expect(mock.cbFrom).toHaveBeenCalledWith('products');
  });

  it('applies search and category filters', async () => {
    mock.cbChain.data = [
      { product_id: 'p-1', name: 'Chicken Breast', category: 'Protein' },
    ];
    mock.cbChain.error = null;

    const result = await getProducts.handler(
      { search: 'chicken', category: 'Protein' },
      ctx(mock.supabase),
    );

    expect(result.isError).toBeUndefined();
    expect(mock.cbChain.ilike).toHaveBeenCalledWith('name', '%chicken%');
    // eq is called twice: once for user_id, once for category
    expect(mock.cbChain.eq).toHaveBeenCalledWith('category', 'Protein');
  });

  it('returns error when query fails', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'query failed' };

    const result = await getProducts.handler({}, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('query failed');
  });
});

describe('CHEFBYTE_create_product', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('creates product and returns success with product data', async () => {
    mock.cbChain.data = {
      product_id: 'p-new',
      name: 'Greek Yogurt',
      barcode: '1234567890',
      category: 'Dairy',
    };
    mock.cbChain.error = null;

    const result = await createProduct.handler(
      {
        name: 'Greek Yogurt',
        barcode: '1234567890',
        calories_per_serving: 100,
        protein_per_serving: 17,
        category: 'Dairy',
      },
      ctx(mock.supabase),
    );

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.message).toContain('Greek Yogurt');
    expect(parsed.product.product_id).toBe('p-new');

    // Verify insert was called on products table
    expect(mock.cbFrom).toHaveBeenCalledWith('products');
    expect(mock.cbChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER_ID,
        name: 'Greek Yogurt',
        barcode: '1234567890',
        calories_per_serving: 100,
        protein_per_serving: 17,
        category: 'Dairy',
      }),
    );
  });

  it('only includes provided optional fields', async () => {
    mock.cbChain.data = { product_id: 'p-new', name: 'Water', barcode: null, category: null };
    mock.cbChain.error = null;

    await createProduct.handler({ name: 'Water' }, ctx(mock.supabase));

    // Insert should only have user_id and name
    expect(mock.cbChain.insert).toHaveBeenCalledWith({
      user_id: USER_ID,
      name: 'Water',
    });
  });

  it('returns error when insert fails', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'duplicate barcode' };

    const result = await createProduct.handler(
      { name: 'Duplicate Product' },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('duplicate barcode');
  });
});

describe('CHEFBYTE_add_stock', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('inserts stock lot and returns success', async () => {
    mock.cbChain.data = {
      lot_id: 'lot-new',
      qty_containers: 5,
      expires_on: '2026-06-01',
      location_id: 'loc-1',
    };
    mock.cbChain.error = null;

    const result = await addStock.handler(
      { product_id: 'p-1', qty_containers: 5, location_id: 'loc-1', expires_on: '2026-06-01' },
      ctx(mock.supabase),
    );

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.message).toContain('5 container(s)');
    expect(parsed.lot.lot_id).toBe('lot-new');

    expect(mock.cbFrom).toHaveBeenCalledWith('stock_lots');
    expect(mock.cbChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER_ID,
        product_id: 'p-1',
        qty_containers: 5,
        location_id: 'loc-1',
        expires_on: '2026-06-01',
      }),
    );
  });

  it('rejects non-positive qty_containers', async () => {
    const result = await addStock.handler(
      { product_id: 'p-1', qty_containers: 0 },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('qty_containers must be positive');
  });

  it('returns error when insert fails', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'FK violation: product not found' };

    const result = await addStock.handler(
      { product_id: 'nonexistent', qty_containers: 1 },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('FK violation');
  });
});

describe('CHEFBYTE_get_macros', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
    // getLogicalDate reads hub.profiles
    mock.hubChain.data = { timezone: 'America/New_York', day_start_hour: 6 };
    mock.hubChain.error = null;
  });

  it('calls get_daily_macros_admin RPC and returns data', async () => {
    mock.rpc.mockReturnValue({
      data: { calories: 1800, protein: 150, carbs: 200, fat: 60 },
      error: null,
    });

    const result = await getMacros.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.calories).toBe(1800);
    expect(parsed.protein).toBe(150);

    expect(mock.rpc).toHaveBeenCalledWith(
      'get_daily_macros_admin',
      expect.objectContaining({
        p_user_id: USER_ID,
      }),
      { schema: 'chefbyte' },
    );
  });

  it('uses explicit date when provided', async () => {
    mock.rpc.mockReturnValue({
      data: { calories: 2000, protein: 160, carbs: 220, fat: 70 },
      error: null,
    });

    const result = await getMacros.handler({ date: '2026-03-01' }, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    expect(mock.rpc).toHaveBeenCalledWith(
      'get_daily_macros_admin',
      expect.objectContaining({
        p_user_id: USER_ID,
        p_logical_date: '2026-03-01',
      }),
      { schema: 'chefbyte' },
    );
  });

  it('returns error when RPC fails', async () => {
    mock.rpc.mockReturnValue({ data: null, error: { message: 'function not found' } });

    const result = await getMacros.handler({}, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('function not found');
  });
});

describe('CHEFBYTE_mark_done', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('calls mark_meal_done_admin RPC with correct args', async () => {
    mock.rpc.mockReturnValue({
      data: { meal_id: 'meal-1', status: 'done', stock_deducted: true },
      error: null,
    });

    const result = await markDone.handler({ meal_id: 'meal-1' }, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.status).toBe('done');

    expect(mock.rpc).toHaveBeenCalledWith(
      'mark_meal_done_admin',
      {
        p_user_id: USER_ID,
        p_meal_id: 'meal-1',
      },
      { schema: 'chefbyte' },
    );
  });

  it('returns error when RPC fails', async () => {
    mock.rpc.mockReturnValue({ data: null, error: { message: 'meal not found' } });

    const result = await markDone.handler({ meal_id: 'nonexistent' }, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('meal not found');
  });
});

describe('CHEFBYTE_below_min_stock', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('finds products below minimum stock', async () => {
    // First query: products with min_stock_amount
    const productsChain = createChain();
    productsChain.data = [
      { product_id: 'p-1', name: 'Chicken', min_stock_amount: 5, category: 'Protein' },
      { product_id: 'p-2', name: 'Rice', min_stock_amount: 3, category: 'Grain' },
    ];

    // Second query: stock_lots
    const lotsChain = createChain();
    lotsChain.data = [
      { product_id: 'p-1', qty_containers: 2 },
      { product_id: 'p-2', qty_containers: 4 },
    ];

    mock.cbFrom
      .mockReturnValueOnce(productsChain)
      .mockReturnValueOnce(lotsChain);

    const result = await belowMinStock.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.total).toBe(1);
    expect(parsed.below_min).toHaveLength(1);
    expect(parsed.below_min[0].product_name).toBe('Chicken');
    expect(parsed.below_min[0].current_stock).toBe(2);
    expect(parsed.below_min[0].deficit).toBe(3);
    expect(parsed.added_to_shopping).toBe(false);
  });

  it('auto-adds deficit to shopping list when auto_add is true', async () => {
    const productsChain = createChain();
    productsChain.data = [
      { product_id: 'p-1', name: 'Eggs', min_stock_amount: 4, category: 'Dairy' },
    ];

    const lotsChain = createChain();
    lotsChain.data = [
      { product_id: 'p-1', qty_containers: 1 },
    ];

    // Third call: upsert into shopping_list
    const upsertChain = createChain();
    upsertChain.data = null;
    upsertChain.error = null;

    mock.cbFrom
      .mockReturnValueOnce(productsChain)
      .mockReturnValueOnce(lotsChain)
      .mockReturnValueOnce(upsertChain);

    const result = await belowMinStock.handler({ auto_add: true }, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.added_to_shopping).toBe(true);
    expect(parsed.total).toBe(1);

    // Verify upsert was called on shopping_list
    expect(upsertChain.upsert).toHaveBeenCalledWith(
      [expect.objectContaining({
        user_id: USER_ID,
        product_id: 'p-1',
        qty_containers: 3,
        notes: 'Auto-added: below minimum stock',
      })],
      { onConflict: 'user_id,product_id' },
    );
  });

  it('returns message when no products have min_stock set', async () => {
    const productsChain = createChain();
    productsChain.data = [];

    mock.cbFrom.mockReturnValueOnce(productsChain);

    const result = await belowMinStock.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.total).toBe(0);
    expect(parsed.message).toContain('No products have minimum stock set');
  });
});

describe('CHEFBYTE_get_cookable', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('returns cookable recipes with max batches', async () => {
    // First query: recipes with ingredients
    const recipesChain = createChain();
    recipesChain.data = [
      {
        recipe_id: 'r-1', name: 'Chicken Rice Bowl', servings: 2,
        recipe_ingredients: [
          { product_id: 'p-1', qty_containers: 1 },
          { product_id: 'p-2', qty_containers: 0.5 },
        ],
      },
      {
        recipe_id: 'r-2', name: 'Pasta', servings: 4,
        recipe_ingredients: [
          { product_id: 'p-3', qty_containers: 2 },
        ],
      },
    ];

    // Second query: stock lots
    const lotsChain = createChain();
    lotsChain.data = [
      { product_id: 'p-1', qty_containers: 3 },
      { product_id: 'p-2', qty_containers: 2 },
      // p-3 has no stock, so Pasta should not be cookable
    ];

    mock.cbFrom
      .mockReturnValueOnce(recipesChain)
      .mockReturnValueOnce(lotsChain);

    const result = await getCookable.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.total).toBe(1);
    expect(parsed.cookable).toHaveLength(1);
    expect(parsed.cookable[0].name).toBe('Chicken Rice Bowl');
    // p-1: floor(3/1) = 3, p-2: floor(2/0.5) = 4 → min = 3
    expect(parsed.cookable[0].max_batches).toBe(3);
    expect(parsed.cookable[0].max_servings).toBe(6);
  });

  it('returns empty when no recipes exist', async () => {
    const recipesChain = createChain();
    recipesChain.data = [];
    mock.cbFrom.mockReturnValueOnce(recipesChain);

    const result = await getCookable.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.total).toBe(0);
    expect(parsed.message).toContain('No recipes found');
  });

  it('returns error when recipe fetch fails', async () => {
    const recipesChain = createChain();
    recipesChain.data = null;
    recipesChain.error = { message: 'query timeout' };
    mock.cbFrom.mockReturnValueOnce(recipesChain);

    const result = await getCookable.handler({}, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('query timeout');
  });
});

describe('CHEFBYTE_create_recipe', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('creates recipe and ingredients in two steps', async () => {
    // First call: insert recipe
    const recipeInsertChain = createChain();
    recipeInsertChain.data = {
      recipe_id: 'r-new',
      name: 'Stir Fry',
      servings: 3,
      prep_time: 20,
    };

    // Second call: insert ingredients
    const ingredientInsertChain = createChain();
    ingredientInsertChain.data = null;
    ingredientInsertChain.error = null;

    mock.cbFrom
      .mockReturnValueOnce(recipeInsertChain)
      .mockReturnValueOnce(ingredientInsertChain);

    const result = await createRecipe.handler(
      {
        name: 'Stir Fry',
        servings: 3,
        prep_time: 20,
        ingredients: [
          { product_id: 'p-1', qty_containers: 1 },
          { product_id: 'p-2', qty_containers: 0.5 },
        ],
      },
      ctx(mock.supabase),
    );

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.message).toContain('Stir Fry');
    expect(parsed.message).toContain('2 ingredient(s)');
    expect(parsed.recipe.recipe_id).toBe('r-new');

    // Verify recipe insert
    expect(mock.cbFrom).toHaveBeenCalledWith('recipes');
    expect(recipeInsertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER_ID,
        name: 'Stir Fry',
        servings: 3,
        prep_time: 20,
      }),
    );

    // Verify ingredient insert
    expect(mock.cbFrom).toHaveBeenCalledWith('recipe_ingredients');
    expect(ingredientInsertChain.insert).toHaveBeenCalledWith([
      { recipe_id: 'r-new', product_id: 'p-1', qty_containers: 1 },
      { recipe_id: 'r-new', product_id: 'p-2', qty_containers: 0.5 },
    ]);
  });

  it('rejects empty ingredients list', async () => {
    const result = await createRecipe.handler(
      { name: 'Empty Recipe', ingredients: [] },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('At least one ingredient is required');
  });

  it('cleans up recipe when ingredient insert fails', async () => {
    // First call: insert recipe succeeds
    const recipeInsertChain = createChain();
    recipeInsertChain.data = { recipe_id: 'r-orphan', name: 'Bad Recipe', servings: null, prep_time: null };

    // Second call: insert ingredients fails
    const ingredientInsertChain = createChain();
    ingredientInsertChain.data = null;
    ingredientInsertChain.error = { message: 'FK violation on product_id' };

    // Third call: delete the orphaned recipe (cleanup)
    const deleteChain = createChain();
    deleteChain.data = null;
    deleteChain.error = null;

    mock.cbFrom
      .mockReturnValueOnce(recipeInsertChain)
      .mockReturnValueOnce(ingredientInsertChain)
      .mockReturnValueOnce(deleteChain);

    const result = await createRecipe.handler(
      {
        name: 'Bad Recipe',
        ingredients: [{ product_id: 'nonexistent', qty_containers: 1 }],
      },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('FK violation on product_id');

    // Verify cleanup: delete was called on recipes table
    expect(mock.cbFrom).toHaveBeenCalledWith('recipes');
    expect(deleteChain.delete).toHaveBeenCalled();
    expect(deleteChain.eq).toHaveBeenCalledWith('recipe_id', 'r-orphan');
  });
});
