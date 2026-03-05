import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPageTestContext,
  chefbyte,
  seedAllChefByte,
  getLocations,
  assertQuerySucceeds,
  type PageTestContext,
  type ChefByteSeeds,
} from './helpers';

describe('ChefByte SettingsPage queries', () => {
  let ctx: PageTestContext;
  let seeds: ChefByteSeeds;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-settings');
    seeds = await seedAllChefByte(ctx);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // -----------------------------------------------------------------------
  // Exact query from SettingsPage.tsx line 125-129 (loadProducts)
  // -----------------------------------------------------------------------
  it('products select * query matches page pattern', async () => {
    const result = await chefbyte(ctx.client).from('products').select('*').eq('user_id', ctx.userId).order('name');

    const data = assertQuerySucceeds(result, 'products *');
    expect(data.length).toBeGreaterThanOrEqual(5);

    // Verify first product (alphabetically: Bananas) with exact seed values
    const first = data[0];
    expect(typeof first.product_id).toBe('string');
    expect(first.user_id).toBe(ctx.userId);
    expect(first.name).toBe('Bananas');
    expect(first.barcode).toBeNull();
    expect(first.description).toBeNull();
    expect(Number(first.servings_per_container)).toBe(1);
    expect(Number(first.calories_per_serving)).toBe(105);
    expect(Number(first.carbs_per_serving)).toBe(27);
    expect(Number(first.protein_per_serving)).toBeCloseTo(1.3, 1);
    expect(Number(first.fat_per_serving)).toBeCloseTo(0.4, 1);
    expect(Number(first.min_stock_amount)).toBe(3);
    expect(first.is_placeholder).toBe(false);
    expect(first.walmart_link).toBeNull();
    expect(first.price).toBeNull();

    // Verify alphabetical sort
    const names = data.map((p: any) => p.name);
    const sorted = [...names].sort((a: string, b: string) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  // -----------------------------------------------------------------------
  // Exact query from SettingsPage.tsx line 136-139 (loadDevices)
  // -----------------------------------------------------------------------
  it('liquidtrack_devices query matches page pattern (empty initially)', async () => {
    const result = await chefbyte(ctx.client)
      .from('liquidtrack_devices')
      .select('*, products:product_id(name)')
      .eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'liquidtrack_devices');
    // No devices seeded, so should be empty
    expect(data).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Exact insert from SettingsPage.tsx addProduct (line 166-167)
  // -----------------------------------------------------------------------
  it('add product insert matches page pattern', async () => {
    const newProduct = {
      user_id: ctx.userId,
      name: 'Test Oatmeal',
      barcode: null,
      description: null,
      servings_per_container: 10,
      calories_per_serving: 150,
      carbs_per_serving: 27,
      protein_per_serving: 5,
      fat_per_serving: 3,
      min_stock_amount: 1,
      is_placeholder: false,
      walmart_link: null,
      price: null,
    };

    const insertResult = await chefbyte(ctx.client).from('products').insert(newProduct);

    expect(insertResult.error).toBeNull();

    // Verify via reload
    const { data: products } = await chefbyte(ctx.client)
      .from('products')
      .select('*')
      .eq('user_id', ctx.userId)
      .eq('name', 'Test Oatmeal');

    expect(products).toHaveLength(1);
    expect(Number(products![0].servings_per_container)).toBe(10);
    expect(Number(products![0].calories_per_serving)).toBe(150);
  });

  // -----------------------------------------------------------------------
  // Exact update from SettingsPage.tsx saveProduct (line 154-158)
  // -----------------------------------------------------------------------
  it('save product update matches page pattern', async () => {
    const productId = seeds.productMap['Eggs'];

    // Simulate the page: spread product, remove product_id and user_id, update remaining
    const updates = {
      name: 'Eggs (Organic)',
      barcode: '123456789',
      description: 'Free range organic eggs',
      servings_per_container: 12,
      calories_per_serving: 72,
      carbs_per_serving: 0.4,
      protein_per_serving: 6.3,
      fat_per_serving: 4.8,
      min_stock_amount: 1,
      is_placeholder: false,
      walmart_link: null,
      price: null,
    };

    const updateResult = await chefbyte(ctx.client).from('products').update(updates).eq('product_id', productId);

    expect(updateResult.error).toBeNull();

    // Verify
    const { data: product } = await chefbyte(ctx.client)
      .from('products')
      .select('name, barcode, description')
      .eq('product_id', productId)
      .single();

    expect(product!.name).toBe('Eggs (Organic)');
    expect(product!.barcode).toBe('123456789');
    expect(product!.description).toBe('Free range organic eggs');
  });

  // -----------------------------------------------------------------------
  // Exact delete from SettingsPage.tsx deleteProduct (line 174-178)
  // -----------------------------------------------------------------------
  it('delete product matches page pattern', async () => {
    // Create a product to delete (so we don't break other tests' seeds)
    const { data: tempProduct } = await chefbyte(ctx.client)
      .from('products')
      .insert({
        user_id: ctx.userId,
        name: 'To Delete',
        servings_per_container: 1,
      })
      .select('product_id')
      .single();

    const productId = tempProduct!.product_id;

    const deleteResult = await chefbyte(ctx.client).from('products').delete().eq('product_id', productId);

    expect(deleteResult.error).toBeNull();

    // Verify deleted
    const { data: remaining } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id')
      .eq('product_id', productId);

    expect(remaining).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Locations query (used by SettingsPage indirectly + helpers)
  // -----------------------------------------------------------------------
  it('locations query returns seeded locations', async () => {
    const locations = await getLocations(ctx);

    // ChefByte activation seeds 3 default locations: Fridge, Pantry, Freezer
    expect(locations.length).toBeGreaterThanOrEqual(3);

    const names = locations.map((l) => l.name);
    expect(names).toContain('Fridge');
    expect(names).toContain('Pantry');
    expect(names).toContain('Freezer');
  });

  // -----------------------------------------------------------------------
  // Location create
  // -----------------------------------------------------------------------
  it('location create succeeds', async () => {
    const insertResult = await chefbyte(ctx.client)
      .from('locations')
      .insert({
        user_id: ctx.userId,
        name: 'Garage',
      })
      .select('location_id, name')
      .single();

    const data = assertQuerySucceeds(insertResult, 'location create');
    expect(data.name).toBe('Garage');
    expect(typeof data.location_id).toBe('string');
  });

  // -----------------------------------------------------------------------
  // Location update
  // -----------------------------------------------------------------------
  it('location update succeeds', async () => {
    // Get the Garage location we just created
    const { data: locs } = await chefbyte(ctx.client)
      .from('locations')
      .select('location_id, name')
      .eq('user_id', ctx.userId)
      .eq('name', 'Garage');

    expect(locs).toHaveLength(1);
    const locationId = locs![0].location_id;

    const updateResult = await chefbyte(ctx.client)
      .from('locations')
      .update({ name: 'Garage Fridge' })
      .eq('location_id', locationId);

    expect(updateResult.error).toBeNull();

    // Verify
    const { data: updated } = await chefbyte(ctx.client)
      .from('locations')
      .select('name')
      .eq('location_id', locationId)
      .single();

    expect(updated!.name).toBe('Garage Fridge');
  });

  // -----------------------------------------------------------------------
  // Exact flow from SettingsPage.tsx deleteLocation (line 316-335)
  // Location delete blocked when stock_lots exist
  // -----------------------------------------------------------------------
  it('location delete blocked when stock_lots exist at location', async () => {
    // Create a location to test with
    const { data: loc } = await chefbyte(ctx.client)
      .from('locations')
      .insert({ user_id: ctx.userId, name: 'Delete Test Loc' })
      .select('location_id')
      .single();
    expect(loc).not.toBeNull();
    const locationId = loc!.location_id;

    // Add a stock lot at that location
    const productId = seeds.productMap['Bananas'];
    const insertResult = await chefbyte(ctx.client).from('stock_lots').insert({
      user_id: ctx.userId,
      product_id: productId,
      location_id: locationId,
      qty_containers: 1,
      expires_on: '2099-11-11',
    });
    expect(insertResult.error).toBeNull();

    // Exact query from SettingsPage.tsx line 318-321 (count check)
    const { count } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('*', { count: 'exact', head: true })
      .eq('location_id', locationId);

    expect(count).toBeGreaterThan(0);

    // Verify location still exists (page would block delete here)
    const { data: stillThere } = await chefbyte(ctx.client)
      .from('locations')
      .select('location_id')
      .eq('location_id', locationId);
    expect(stillThere).toHaveLength(1);

    // Cleanup: remove stock lot then location
    await chefbyte(ctx.client).from('stock_lots').delete().eq('location_id', locationId);
    await chefbyte(ctx.client).from('locations').delete().eq('location_id', locationId);
  });

  // -----------------------------------------------------------------------
  // Location delete succeeds when no stock at location
  // -----------------------------------------------------------------------
  it('location delete succeeds when no stock_lots at location', async () => {
    // Create a location with no stock
    const { data: loc } = await chefbyte(ctx.client)
      .from('locations')
      .insert({ user_id: ctx.userId, name: 'Empty Loc' })
      .select('location_id')
      .single();
    expect(loc).not.toBeNull();
    const locationId = loc!.location_id;

    // Exact count query from SettingsPage.tsx line 318-321
    const { count } = await chefbyte(ctx.client)
      .from('stock_lots')
      .select('*', { count: 'exact', head: true })
      .eq('location_id', locationId);

    expect(count).toBe(0);

    // Delete location (exact pattern from SettingsPage.tsx line 327)
    const deleteResult = await chefbyte(ctx.client).from('locations').delete().eq('location_id', locationId);
    expect(deleteResult.error).toBeNull();

    // Verify deleted
    const { data: remaining } = await chefbyte(ctx.client)
      .from('locations')
      .select('location_id')
      .eq('location_id', locationId);
    expect(remaining).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Exact insert from SettingsPage.tsx generateDevice (line 199-207)
  // -----------------------------------------------------------------------
  it('liquidtrack device insert matches page pattern', async () => {
    const deviceId = crypto.randomUUID();
    const rawKey = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');

    // Hash the key with SHA-256 (exact pattern from SettingsPage.tsx line 194-197)
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(rawKey));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const keyHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    const productId = seeds.productMap['Protein Powder'];

    const insertResult = await chefbyte(ctx.client).from('liquidtrack_devices').insert({
      device_id: deviceId,
      user_id: ctx.userId,
      device_name: 'Water Bottle Scale',
      product_id: productId,
      import_key_hash: keyHash,
    });

    expect(insertResult.error).toBeNull();

    // Verify device appears in the page query
    const result = await chefbyte(ctx.client)
      .from('liquidtrack_devices')
      .select('*, products:product_id(name)')
      .eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'devices after insert');
    expect(data.length).toBeGreaterThanOrEqual(1);

    const device = data.find((d: any) => d.device_id === deviceId);
    expect(device).toBeDefined();
    expect(device.device_name).toBe('Water Bottle Scale');
    expect(device.is_active).toBe(true);
    expect(device.import_key_hash).toBe(keyHash);

    // Verify products join with exact values
    expect(device.products).not.toBeNull();
    expect(device.products.name).toBe('Protein Powder');
  });

  // -----------------------------------------------------------------------
  // Exact update from SettingsPage.tsx revokeDevice (line 217-220)
  // -----------------------------------------------------------------------
  it('revoke device update matches page pattern', async () => {
    // Get device we inserted above
    const { data: devices } = await chefbyte(ctx.client)
      .from('liquidtrack_devices')
      .select('device_id')
      .eq('user_id', ctx.userId)
      .eq('is_active', true);

    expect(devices!.length).toBeGreaterThanOrEqual(1);
    const deviceId = devices![0].device_id;

    const updateResult = await chefbyte(ctx.client)
      .from('liquidtrack_devices')
      .update({ is_active: false })
      .eq('device_id', deviceId);

    expect(updateResult.error).toBeNull();

    // Verify
    const { data: device } = await chefbyte(ctx.client)
      .from('liquidtrack_devices')
      .select('is_active')
      .eq('device_id', deviceId)
      .single();

    expect(device!.is_active).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Exact query from SettingsPage.tsx loadDeviceEvents (line 232-238)
  // -----------------------------------------------------------------------
  it('liquidtrack_events query matches page pattern', async () => {
    // Get a device
    const { data: devices } = await chefbyte(ctx.client)
      .from('liquidtrack_devices')
      .select('device_id')
      .eq('user_id', ctx.userId);

    expect(devices!.length).toBeGreaterThanOrEqual(1);
    const deviceId = devices![0].device_id;

    // Query events using exact page pattern
    const result = await chefbyte(ctx.client)
      .from('liquidtrack_events')
      .select('*')
      .eq('device_id', deviceId)
      .eq('user_id', ctx.userId)
      .order('created_at', { ascending: false })
      .limit(50);

    const data = assertQuerySucceeds(result, 'liquidtrack_events');
    // No events seeded, so should be empty
    expect(data).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Insert a liquidtrack event and verify the query returns it
  // -----------------------------------------------------------------------
  it('liquidtrack_events query returns inserted events', async () => {
    const { data: devices } = await chefbyte(ctx.client)
      .from('liquidtrack_devices')
      .select('device_id')
      .eq('user_id', ctx.userId);

    const deviceId = devices![0].device_id;
    const logicalDate = new Date().toISOString().split('T')[0];

    // Insert an event
    const insertResult = await chefbyte(ctx.client).from('liquidtrack_events').insert({
      user_id: ctx.userId,
      device_id: deviceId,
      weight_before: 500,
      weight_after: 350,
      consumption: 150,
      is_refill: false,
      calories: 0,
      carbs: 0,
      protein: 0,
      fat: 0,
      logical_date: logicalDate,
    });

    expect(insertResult.error).toBeNull();

    // Query using exact page pattern
    const result = await chefbyte(ctx.client)
      .from('liquidtrack_events')
      .select('*')
      .eq('device_id', deviceId)
      .eq('user_id', ctx.userId)
      .order('created_at', { ascending: false })
      .limit(50);

    const data = assertQuerySucceeds(result, 'events after insert');
    expect(data).toHaveLength(1);

    const event = data[0];
    expect(typeof event.event_id).toBe('string');
    expect(typeof event.created_at).toBe('string');
    expect(event.is_refill).toBe(false);

    // Verify exact values from insert
    expect(Number(event.weight_before)).toBe(500);
    expect(Number(event.weight_after)).toBe(350);
    expect(Number(event.consumption)).toBe(150);
    expect(Number(event.calories)).toBe(0);
    expect(Number(event.carbs)).toBe(0);
    expect(Number(event.protein)).toBe(0);
    expect(Number(event.fat)).toBe(0);
  });
});
