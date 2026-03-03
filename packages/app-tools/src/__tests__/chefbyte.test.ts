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
import { getProductLots } from '../chefbyte/get-product-lots';
import { getShoppingList } from '../chefbyte/get-shopping-list';
import { addToShopping } from '../chefbyte/add-to-shopping';
import { clearShopping } from '../chefbyte/clear-shopping';
import { getMealPlan } from '../chefbyte/get-meal-plan';
import { addMeal } from '../chefbyte/add-meal';
import { getRecipes } from '../chefbyte/get-recipes';
import { logTempItem } from '../chefbyte/log-temp-item';
import { setPrice } from '../chefbyte/set-price';

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
    'select',
    'eq',
    'neq',
    'in',
    'is',
    'not',
    'order',
    'limit',
    'single',
    'maybeSingle',
    'insert',
    'update',
    'delete',
    'upsert',
    'gte',
    'lte',
    'gt',
    'lt',
    'ilike',
  ];
  methods.forEach((m) => {
    chain[m] = vi.fn(() => chain);
  });
  chain.data = null;
  chain.error = null;
  // Make the chain thenable so `await chain` resolves to { data, error }
  chain.then = function (resolve: (v: any) => void, _reject?: (e: any) => void) {
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
        lot_id: 'lot-1',
        product_id: 'p-1',
        qty_containers: 3,
        expires_on: '2026-04-01',
        meal_label: null,
        location_id: 'loc-1',
        created_at: '2026-03-01T00:00:00Z',
        products: { name: 'Chicken Breast', category: 'Protein' },
        locations: { name: 'Fridge' },
      },
      {
        lot_id: 'lot-2',
        product_id: 'p-1',
        qty_containers: 2,
        expires_on: '2026-03-20',
        meal_label: null,
        location_id: 'loc-1',
        created_at: '2026-03-01T00:00:00Z',
        products: { name: 'Chicken Breast', category: 'Protein' },
        locations: { name: 'Fridge' },
      },
      {
        lot_id: 'lot-3',
        product_id: 'p-2',
        qty_containers: 1,
        expires_on: null,
        meal_label: null,
        location_id: null,
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
        lot_id: 'lot-1',
        product_id: 'p-1',
        qty_containers: 3,
        expires_on: '2026-04-01',
        meal_label: null,
        location_id: 'loc-1',
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
    mock.cbRpc.mockReturnValue({
      data: { consumed: 2, remaining_stock: 3, macros_logged: true },
      error: null,
    });

    const result = await consume.handler({ product_id: 'p-1', qty: 2, unit: 'container' }, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.consumed).toBe(2);
    expect(parsed.macros_logged).toBe(true);

    expect(mock.cbRpc).toHaveBeenCalledWith(
      'consume_product_admin',
      expect.objectContaining({
        p_user_id: USER_ID,
        p_product_id: 'p-1',
        p_qty: 2,
        p_unit: 'container',
        p_log_macros: true,
      }),
    );
  });

  it('rejects non-positive qty', async () => {
    const result = await consume.handler({ product_id: 'p-1', qty: 0, unit: 'serving' }, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('qty must be positive');
  });

  it('returns error when RPC fails', async () => {
    mock.cbRpc.mockReturnValue({ data: null, error: { message: 'insufficient stock' } });

    const result = await consume.handler({ product_id: 'p-1', qty: 100, unit: 'container' }, ctx(mock.supabase));

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

  it('applies search filter', async () => {
    mock.cbChain.data = [{ product_id: 'p-1', name: 'Chicken Breast' }];
    mock.cbChain.error = null;

    const result = await getProducts.handler({ search: 'chicken' }, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    expect(mock.cbChain.ilike).toHaveBeenCalledWith('name', '%chicken%');
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
    };
    mock.cbChain.error = null;

    const result = await createProduct.handler(
      {
        name: 'Greek Yogurt',
        barcode: '1234567890',
        calories_per_serving: 100,
        protein_per_serving: 17,
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

    const result = await createProduct.handler({ name: 'Duplicate Product' }, ctx(mock.supabase));

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
    const result = await addStock.handler({ product_id: 'p-1', qty_containers: 0 }, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('qty_containers must be positive');
  });

  it('returns error when insert fails', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'FK violation: product not found' };

    // Provide location_id to skip location lookup (which would also hit the mock chain)
    const result = await addStock.handler(
      { product_id: 'nonexistent', qty_containers: 1, location_id: 'loc-1' },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('FK violation');
  });

  it('returns error when no locations found and location_id not provided', async () => {
    mock.cbChain.data = [];
    mock.cbChain.error = null;

    const result = await addStock.handler({ product_id: 'p-1', qty_containers: 1 }, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No storage locations found');
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
    mock.cbRpc.mockReturnValue({
      data: { calories: 1800, protein: 150, carbs: 200, fat: 60 },
      error: null,
    });

    const result = await getMacros.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.calories).toBe(1800);
    expect(parsed.protein).toBe(150);

    expect(mock.cbRpc).toHaveBeenCalledWith(
      'get_daily_macros_admin',
      expect.objectContaining({
        p_user_id: USER_ID,
      }),
    );
  });

  it('uses explicit date when provided', async () => {
    mock.cbRpc.mockReturnValue({
      data: { calories: 2000, protein: 160, carbs: 220, fat: 70 },
      error: null,
    });

    const result = await getMacros.handler({ date: '2026-03-01' }, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    expect(mock.cbRpc).toHaveBeenCalledWith(
      'get_daily_macros_admin',
      expect.objectContaining({
        p_user_id: USER_ID,
        p_logical_date: '2026-03-01',
      }),
    );
  });

  it('returns error when RPC fails', async () => {
    mock.cbRpc.mockReturnValue({ data: null, error: { message: 'function not found' } });

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
    mock.cbRpc.mockReturnValue({
      data: { meal_id: 'meal-1', status: 'done', stock_deducted: true },
      error: null,
    });

    const result = await markDone.handler({ meal_id: 'meal-1' }, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.status).toBe('done');

    expect(mock.cbRpc).toHaveBeenCalledWith('mark_meal_done_admin', {
      p_user_id: USER_ID,
      p_meal_id: 'meal-1',
    });
  });

  it('returns error when RPC fails', async () => {
    mock.cbRpc.mockReturnValue({ data: null, error: { message: 'meal not found' } });

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

    mock.cbFrom.mockReturnValueOnce(productsChain).mockReturnValueOnce(lotsChain);

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
    productsChain.data = [{ product_id: 'p-1', name: 'Eggs', min_stock_amount: 4, category: 'Dairy' }];

    const lotsChain = createChain();
    lotsChain.data = [{ product_id: 'p-1', qty_containers: 1 }];

    // Third call: upsert into shopping_list
    const upsertChain = createChain();
    upsertChain.data = null;
    upsertChain.error = null;

    mock.cbFrom.mockReturnValueOnce(productsChain).mockReturnValueOnce(lotsChain).mockReturnValueOnce(upsertChain);

    const result = await belowMinStock.handler({ auto_add: true }, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.added_to_shopping).toBe(true);
    expect(parsed.total).toBe(1);

    // Verify upsert was called on shopping_list
    expect(upsertChain.upsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          user_id: USER_ID,
          product_id: 'p-1',
          qty_containers: 3,
        }),
      ],
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

  it('returns error when stock lots query fails (lotError path)', async () => {
    const productsChain = createChain();
    productsChain.data = [{ product_id: 'p-1', name: 'Chicken', min_stock_amount: 5, category: 'Protein' }];

    const lotsChain = createChain();
    lotsChain.data = null;
    lotsChain.error = { message: 'stock query timeout' };

    mock.cbFrom.mockReturnValueOnce(productsChain).mockReturnValueOnce(lotsChain);

    const result = await belowMinStock.handler({}, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('stock query timeout');
  });

  it('returns error when auto_add upsert to shopping_list fails', async () => {
    const productsChain = createChain();
    productsChain.data = [
      { product_id: 'p-1', name: 'Chicken', min_stock_amount: 5, category: 'Protein' },
      { product_id: 'p-2', name: 'Rice', min_stock_amount: 3, category: 'Grain' },
    ];

    const lotsChain = createChain();
    lotsChain.data = [{ product_id: 'p-1', qty_containers: 2 }];

    // Upsert fails
    const upsertChain = createChain();
    upsertChain.data = null;
    upsertChain.error = { message: 'upsert constraint violation' };

    mock.cbFrom.mockReturnValueOnce(productsChain).mockReturnValueOnce(lotsChain).mockReturnValueOnce(upsertChain);

    const result = await belowMinStock.handler({ auto_add: true }, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'Found 2 below-min products but failed to add to shopping list: upsert constraint violation',
    );
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
        recipe_id: 'r-1',
        name: 'Chicken Rice Bowl',
        base_servings: 2,
        recipe_ingredients: [
          { product_id: 'p-1', quantity: 1, unit: 'container' },
          { product_id: 'p-2', quantity: 0.5, unit: 'container' },
        ],
      },
      {
        recipe_id: 'r-2',
        name: 'Pasta',
        base_servings: 4,
        recipe_ingredients: [{ product_id: 'p-3', quantity: 2, unit: 'container' }],
      },
    ];

    // Second query: stock lots
    const lotsChain = createChain();
    lotsChain.data = [
      { product_id: 'p-1', qty_containers: 3 },
      { product_id: 'p-2', qty_containers: 2 },
      // p-3 has no stock, so Pasta should not be cookable
    ];

    mock.cbFrom.mockReturnValueOnce(recipesChain).mockReturnValueOnce(lotsChain);

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

  it('returns error when stock lots query fails (lotError path)', async () => {
    const recipesChain = createChain();
    recipesChain.data = [
      {
        recipe_id: 'r-1',
        name: 'Some Recipe',
        base_servings: 2,
        recipe_ingredients: [{ product_id: 'p-1', quantity: 1, unit: 'container' }],
      },
    ];

    const lotsChain = createChain();
    lotsChain.data = null;
    lotsChain.error = { message: 'stock connection lost' };

    mock.cbFrom.mockReturnValueOnce(recipesChain).mockReturnValueOnce(lotsChain);

    const result = await getCookable.handler({}, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('stock connection lost');
  });

  it('excludes recipes with zero ingredients', async () => {
    const recipesChain = createChain();
    recipesChain.data = [
      {
        recipe_id: 'r-empty',
        name: 'Empty Recipe',
        base_servings: 1,
        recipe_ingredients: [],
      },
      {
        recipe_id: 'r-has-ing',
        name: 'Full Recipe',
        base_servings: 2,
        recipe_ingredients: [{ product_id: 'p-1', quantity: 1, unit: 'container' }],
      },
    ];

    const lotsChain = createChain();
    lotsChain.data = [{ product_id: 'p-1', qty_containers: 5 }];

    mock.cbFrom.mockReturnValueOnce(recipesChain).mockReturnValueOnce(lotsChain);

    const result = await getCookable.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    // Empty Recipe should be excluded because it has no ingredients
    expect(parsed.total).toBe(1);
    expect(parsed.cookable).toHaveLength(1);
    expect(parsed.cookable[0].name).toBe('Full Recipe');
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
      base_servings: 3,
      active_time: 20,
      total_time: null,
    };

    // Second call: insert ingredients
    const ingredientInsertChain = createChain();
    ingredientInsertChain.data = null;
    ingredientInsertChain.error = null;

    mock.cbFrom.mockReturnValueOnce(recipeInsertChain).mockReturnValueOnce(ingredientInsertChain);

    const result = await createRecipe.handler(
      {
        name: 'Stir Fry',
        base_servings: 3,
        active_time: 20,
        ingredients: [
          { product_id: 'p-1', quantity: 1 },
          { product_id: 'p-2', quantity: 0.5 },
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
        base_servings: 3,
        active_time: 20,
      }),
    );

    // Verify ingredient insert
    expect(mock.cbFrom).toHaveBeenCalledWith('recipe_ingredients');
    expect(ingredientInsertChain.insert).toHaveBeenCalledWith([
      { recipe_id: 'r-new', product_id: 'p-1', user_id: USER_ID, quantity: 1, unit: 'container' },
      { recipe_id: 'r-new', product_id: 'p-2', user_id: USER_ID, quantity: 0.5, unit: 'container' },
    ]);
  });

  it('rejects empty ingredients list', async () => {
    const result = await createRecipe.handler({ name: 'Empty Recipe', ingredients: [] }, ctx(mock.supabase));

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

// ---------------------------------------------------------------------------
// 1. CHEFBYTE_get_product_lots
// ---------------------------------------------------------------------------

describe('CHEFBYTE_get_product_lots', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('returns lots for a product with location join data', async () => {
    mock.cbChain.data = [
      {
        lot_id: 'lot-1',
        qty_containers: 3,
        expires_on: '2026-04-01',
        location_id: 'loc-1',
        created_at: '2026-03-01T00:00:00Z',
        locations: { name: 'Fridge' },
      },
      {
        lot_id: 'lot-2',
        qty_containers: 1.5,
        expires_on: null,
        location_id: null,
        created_at: '2026-03-02T00:00:00Z',
        locations: null,
      },
    ];
    mock.cbChain.error = null;

    const result = await getProductLots.handler({ product_id: 'p-1' }, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.product_id).toBe('p-1');
    expect(parsed.total_lots).toBe(2);
    expect(parsed.lots).toHaveLength(2);
    expect(parsed.lots[0].lot_id).toBe('lot-1');
    expect(parsed.lots[0].qty_containers).toBe(3);
    expect(parsed.lots[0].location).toBe('Fridge');
    expect(parsed.lots[1].lot_id).toBe('lot-2');
    expect(parsed.lots[1].qty_containers).toBe(1.5);
    expect(parsed.lots[1].location).toBeNull();

    // Verify correct table and filters
    expect(mock.cbFrom).toHaveBeenCalledWith('stock_lots');
    expect(mock.cbChain.eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(mock.cbChain.eq).toHaveBeenCalledWith('product_id', 'p-1');
    expect(mock.cbChain.gt).toHaveBeenCalledWith('qty_containers', 0);
  });

  it('returns error when query fails', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'lots fetch failed' };

    const result = await getProductLots.handler({ product_id: 'p-1' }, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('lots fetch failed');
  });
});

// ---------------------------------------------------------------------------
// 2. CHEFBYTE_get_shopping_list
// ---------------------------------------------------------------------------

describe('CHEFBYTE_get_shopping_list', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('returns shopping list items with product join and cost calculation', async () => {
    mock.cbChain.data = [
      {
        cart_item_id: 'sl-1',
        product_id: 'p-1',
        qty_containers: 3,
        products: { name: 'Chicken Breast', price: '4.99' },
      },
      {
        cart_item_id: 'sl-2',
        product_id: 'p-2',
        qty_containers: 2,
        products: { name: 'Rice', price: null },
      },
    ];
    mock.cbChain.error = null;

    const result = await getShoppingList.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.total_items).toBe(2);
    expect(parsed.items).toHaveLength(2);

    // First item: has price, cost calculated
    expect(parsed.items[0].id).toBe('sl-1');
    expect(parsed.items[0].product_name).toBe('Chicken Breast');
    expect(parsed.items[0].qty_containers).toBe(3);
    expect(parsed.items[0].price).toBe(4.99);
    expect(parsed.items[0].estimated_cost).toBeCloseTo(14.97);

    // Second item: no price, cost null
    expect(parsed.items[1].product_name).toBe('Rice');
    expect(parsed.items[1].price).toBeNull();
    expect(parsed.items[1].estimated_cost).toBeNull();

    // Total cost should only include items with prices
    expect(parsed.estimated_total).toBeCloseTo(14.97);

    expect(mock.cbFrom).toHaveBeenCalledWith('shopping_list');
  });

  it('returns error when query fails', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'shopping list unavailable' };

    const result = await getShoppingList.handler({}, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('shopping list unavailable');
  });
});

// ---------------------------------------------------------------------------
// 3. CHEFBYTE_add_to_shopping
// ---------------------------------------------------------------------------

describe('CHEFBYTE_add_to_shopping', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('upserts item to shopping list and returns success', async () => {
    mock.cbChain.data = {
      cart_item_id: 'sl-new',
      product_id: 'p-1',
      qty_containers: 5,
    };
    mock.cbChain.error = null;

    const result = await addToShopping.handler({ product_id: 'p-1', qty_containers: 5 }, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.message).toContain('5 container(s)');
    expect(parsed.item.id).toBe('sl-new');

    expect(mock.cbFrom).toHaveBeenCalledWith('shopping_list');
    expect(mock.cbChain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER_ID,
        product_id: 'p-1',
        qty_containers: 5,
      }),
      { onConflict: 'user_id,product_id' },
    );
  });

  it('rejects non-positive qty_containers', async () => {
    const result = await addToShopping.handler({ product_id: 'p-1', qty_containers: 0 }, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('qty_containers must be positive');
  });

  it('returns error when upsert fails', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'upsert conflict error' };

    const result = await addToShopping.handler({ product_id: 'p-1', qty_containers: 2 }, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('upsert conflict error');
  });
});

// ---------------------------------------------------------------------------
// 4. CHEFBYTE_clear_shopping
// ---------------------------------------------------------------------------

describe('CHEFBYTE_clear_shopping', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('deletes all shopping list items and returns success', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = null;

    const result = await clearShopping.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.message).toContain('Shopping list cleared');

    expect(mock.cbFrom).toHaveBeenCalledWith('shopping_list');
    expect(mock.cbChain.delete).toHaveBeenCalled();
    expect(mock.cbChain.eq).toHaveBeenCalledWith('user_id', USER_ID);
  });

  it('returns error when delete fails', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'delete permission denied' };

    const result = await clearShopping.handler({}, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('delete permission denied');
  });
});

// ---------------------------------------------------------------------------
// 5. CHEFBYTE_get_meal_plan
// ---------------------------------------------------------------------------

describe('CHEFBYTE_get_meal_plan', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('returns meal plan entries with recipe/product joins', async () => {
    mock.cbChain.data = [
      {
        meal_id: 'm-1',
        logical_date: '2026-03-01',
        meal_prep: false,
        recipe_id: 'r-1',
        product_id: null,
        servings: 2,
        completed_at: '2026-03-01T12:00:00Z',
        recipes: { name: 'Oatmeal Bowl' },
        products: null,
      },
      {
        meal_id: 'm-2',
        logical_date: '2026-03-01',
        meal_prep: false,
        recipe_id: null,
        product_id: 'p-1',
        servings: null,
        completed_at: null,
        recipes: null,
        products: { name: 'Protein Bar' },
      },
    ];
    mock.cbChain.error = null;

    const result = await getMealPlan.handler({ start_date: '2026-03-01', end_date: '2026-03-07' }, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.total).toBe(2);
    expect(parsed.entries).toHaveLength(2);

    // First entry: recipe-based, completed
    expect(parsed.entries[0].meal_id).toBe('m-1');
    expect(parsed.entries[0].recipe_name).toBe('Oatmeal Bowl');
    expect(parsed.entries[0].product_name).toBeNull();
    expect(parsed.entries[0].servings).toBe(2);
    expect(parsed.entries[0].completed).toBe(true);

    // Second entry: product-based, not completed
    expect(parsed.entries[1].recipe_name).toBeNull();
    expect(parsed.entries[1].product_name).toBe('Protein Bar');
    expect(parsed.entries[1].completed).toBe(false);

    expect(mock.cbFrom).toHaveBeenCalledWith('meal_plan_entries');
    expect(mock.cbChain.gte).toHaveBeenCalledWith('logical_date', '2026-03-01');
    expect(mock.cbChain.lte).toHaveBeenCalledWith('logical_date', '2026-03-07');
  });

  it('returns error when query fails', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'meal plan query failed' };

    const result = await getMealPlan.handler({ start_date: '2026-03-01', end_date: '2026-03-07' }, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('meal plan query failed');
  });
});

// ---------------------------------------------------------------------------
// 6. CHEFBYTE_add_meal
// ---------------------------------------------------------------------------

describe('CHEFBYTE_add_meal', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('inserts meal plan entry and returns success', async () => {
    mock.cbChain.data = {
      meal_id: 'm-new',
      logical_date: '2026-03-05',
      meal_prep: false,
      recipe_id: 'r-1',
      product_id: null,
      servings: 3,
    };
    mock.cbChain.error = null;

    const result = await addMeal.handler(
      { logical_date: '2026-03-05', recipe_id: 'r-1', servings: 3 },
      ctx(mock.supabase),
    );

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.message).toContain('Meal plan entry added');
    expect(parsed.meal.meal_id).toBe('m-new');

    expect(mock.cbFrom).toHaveBeenCalledWith('meal_plan_entries');
    expect(mock.cbChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER_ID,
        logical_date: '2026-03-05',
        meal_prep: false,
        recipe_id: 'r-1',
        servings: 3,
      }),
    );
  });

  it('rejects when neither recipe_id nor product_id is provided', async () => {
    const result = await addMeal.handler({ logical_date: '2026-03-05' }, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('At least one of recipe_id or product_id is required');
  });

  it('returns error when insert fails', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'FK violation: recipe not found' };

    const result = await addMeal.handler({ logical_date: '2026-03-05', recipe_id: 'bad-id' }, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('FK violation: recipe not found');
  });
});

// ---------------------------------------------------------------------------
// 7. CHEFBYTE_get_recipes
// ---------------------------------------------------------------------------

describe('CHEFBYTE_get_recipes', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('returns recipes with ingredients and computed macros', async () => {
    mock.cbChain.data = [
      {
        recipe_id: 'r-1',
        name: 'Chicken Stir Fry',
        instructions: 'Cook it',
        servings: 4,
        prep_time: 30,
        created_at: '2026-03-01T00:00:00Z',
        recipe_ingredients: [
          {
            id: 'ri-1',
            product_id: 'p-1',
            qty_containers: 2,
            products: {
              name: 'Chicken Breast',
              calories_per_serving: 165,
              carbs_per_serving: 0,
              protein_per_serving: 31,
              fat_per_serving: 3.6,
              servings_per_container: 4,
            },
          },
          {
            id: 'ri-2',
            product_id: 'p-2',
            qty_containers: 1,
            products: {
              name: 'Rice',
              calories_per_serving: 200,
              carbs_per_serving: 45,
              protein_per_serving: 4,
              fat_per_serving: 0.5,
              servings_per_container: 8,
            },
          },
        ],
      },
    ];
    mock.cbChain.error = null;

    const result = await getRecipes.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.total).toBe(1);
    expect(parsed.recipes).toHaveLength(1);

    const recipe = parsed.recipes[0];
    expect(recipe.name).toBe('Chicken Stir Fry');
    expect(recipe.ingredients).toHaveLength(2);

    // Verify macros_per_container = per_serving * servings_per_container
    const chickenIng = recipe.ingredients[0];
    expect(chickenIng.product_name).toBe('Chicken Breast');
    expect(chickenIng.macros_per_container.calories).toBe(165 * 4);
    expect(chickenIng.macros_per_container.protein).toBe(31 * 4);

    expect(mock.cbFrom).toHaveBeenCalledWith('recipes');
  });

  it('applies search filter when provided', async () => {
    mock.cbChain.data = [];
    mock.cbChain.error = null;

    await getRecipes.handler({ search: 'pasta' }, ctx(mock.supabase));

    expect(mock.cbChain.ilike).toHaveBeenCalledWith('name', '%pasta%');
  });

  it('returns error when query fails', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'recipes table locked' };

    const result = await getRecipes.handler({}, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('recipes table locked');
  });
});

// ---------------------------------------------------------------------------
// 8. CHEFBYTE_log_temp_item
// ---------------------------------------------------------------------------

describe('CHEFBYTE_log_temp_item', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
    // getLogicalDate reads hub.profiles
    mock.hubChain.data = { timezone: 'America/New_York', day_start_hour: 6 };
    mock.hubChain.error = null;
  });

  it('inserts temp item with logical date and returns success', async () => {
    mock.cbChain.data = {
      id: 'ti-new',
      name: 'Pizza slice',
      calories: 300,
      carbs: 35,
      protein: 12,
      fat: 14,
      logical_date: '2026-03-03',
    };
    mock.cbChain.error = null;

    const result = await logTempItem.handler(
      { name: 'Pizza slice', calories: 300, carbs: 35, protein: 12, fat: 14 },
      ctx(mock.supabase),
    );

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.message).toContain('Pizza slice');
    expect(parsed.message).toContain('300 cal');
    expect(parsed.item.id).toBe('ti-new');

    // Verify hub profiles was queried for getLogicalDate
    expect(mock.hubFrom).toHaveBeenCalledWith('profiles');

    // Verify insert on temp_items
    expect(mock.cbFrom).toHaveBeenCalledWith('temp_items');
    expect(mock.cbChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER_ID,
        name: 'Pizza slice',
        calories: 300,
        carbs: 35,
        protein: 12,
        fat: 14,
      }),
    );
  });

  it('defaults optional macro fields to zero when not provided', async () => {
    mock.cbChain.data = {
      temp_id: 'ti-min',
      name: 'Apple',
      calories: 95,
      carbs: 0,
      protein: 0,
      fat: 0,
      logical_date: '2026-03-03',
    };
    mock.cbChain.error = null;

    await logTempItem.handler({ name: 'Apple', calories: 95 }, ctx(mock.supabase));

    // Insert should include carbs/protein/fat defaulted to 0
    expect(mock.cbChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        carbs: 0,
        protein: 0,
        fat: 0,
      }),
    );
  });

  it('returns error when insert fails', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'temp_items insert failed' };

    const result = await logTempItem.handler({ name: 'Bad Item', calories: 100 }, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('temp_items insert failed');
  });
});

// ---------------------------------------------------------------------------
// 9. CHEFBYTE_set_price
// ---------------------------------------------------------------------------

describe('CHEFBYTE_set_price', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('updates product price and returns success', async () => {
    mock.cbChain.data = {
      product_id: 'p-1',
      name: 'Chicken Breast',
      price: '4.99',
    };
    mock.cbChain.error = null;

    const result = await setPrice.handler({ product_id: 'p-1', price: 4.99 }, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.message).toContain('Chicken Breast');
    expect(parsed.message).toContain('$4.99');
    expect(parsed.product.product_id).toBe('p-1');

    expect(mock.cbFrom).toHaveBeenCalledWith('products');
    expect(mock.cbChain.update).toHaveBeenCalledWith({ price: 4.99 });
    expect(mock.cbChain.eq).toHaveBeenCalledWith('product_id', 'p-1');
    expect(mock.cbChain.eq).toHaveBeenCalledWith('user_id', USER_ID);
  });

  it('rejects negative price', async () => {
    const result = await setPrice.handler({ product_id: 'p-1', price: -5 }, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Price cannot be negative');
  });

  it('returns error when update fails', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'product not found for update' };

    const result = await setPrice.handler({ product_id: 'nonexistent', price: 9.99 }, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('product not found for update');
  });
});
