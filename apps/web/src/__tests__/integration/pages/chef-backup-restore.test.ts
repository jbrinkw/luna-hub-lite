import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPageTestContext, chefbyte, seedAllChefByte, type PageTestContext, type ChefByteSeeds } from './helpers';

/**
 * Integration tests for chefbyte.export_chefbyte_backup /
 * chefbyte.restore_chefbyte_backup via the real PostgREST RPC surface the
 * Settings BackupTab calls. No stubs — each test drives the actual RPC and
 * verifies post-state via direct SELECTs.
 */

const EXPECTED_SCHEMA_VERSION = '20260423010000';

describe('ChefByte Backup & Restore RPCs', () => {
  let ctx: PageTestContext;
  let seeds: ChefByteSeeds;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-backup-restore');
    seeds = await seedAllChefByte(ctx);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // -----------------------------------------------------------------------
  // Export: shape
  // -----------------------------------------------------------------------
  it('export_chefbyte_backup returns the expected envelope + all tables', async () => {
    const { data, error } = await chefbyte(ctx.client).rpc('export_chefbyte_backup');
    expect(error).toBeNull();
    expect(data).toBeTruthy();
    const backup = data as any;

    expect(backup.schema_version).toBe(EXPECTED_SCHEMA_VERSION);
    expect(backup.user_id).toBe(ctx.userId);
    expect(typeof backup.generated_at).toBe('string');

    // All 10 included tables present
    expect(backup.tables).toBeTruthy();
    for (const key of [
      'locations',
      'products',
      'stock_lots',
      'recipes',
      'recipe_ingredients',
      'meal_plan_entries',
      'food_logs',
      'temp_items',
      'shopping_list',
      'user_config',
    ]) {
      expect(Array.isArray(backup.tables[key])).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // Export: content matches seeded data
  // -----------------------------------------------------------------------
  it('export payload row counts match seeded data', async () => {
    const { data } = await chefbyte(ctx.client).rpc('export_chefbyte_backup');
    const tables = (data as any).tables;

    expect(tables.products.length).toBe(5); // seedProducts inserts 5
    expect(tables.stock_lots.length).toBe(3); // seedStock inserts 3
    expect(tables.recipes.length).toBe(1);
    expect(tables.recipe_ingredients.length).toBe(2);
    expect(tables.user_config.length).toBe(4); // seedMacroGoals inserts 4 goal keys

    // locations come from activate_app — at least Fridge/Pantry/Freezer
    expect(tables.locations.length).toBeGreaterThanOrEqual(3);
  });

  // -----------------------------------------------------------------------
  // Restore roundtrip: snapshot → delete rows → restore → state returns
  // -----------------------------------------------------------------------
  it('restore_chefbyte_backup roundtrip recovers deleted rows with preserved UUIDs', async () => {
    // Snapshot current state.
    const { data: snapshot } = await chefbyte(ctx.client).rpc('export_chefbyte_backup');
    expect(snapshot).toBeTruthy();

    // Mutate: delete one product and its dependents.
    const targetProductId = seeds.productMap['Birds Eye Sweet Peas'];
    expect(targetProductId).toBeTruthy();

    const { error: delErr } = await chefbyte(ctx.client).from('products').delete().eq('product_id', targetProductId);
    expect(delErr).toBeNull();

    // Verify delete actually happened (products cascades to dependents).
    const { data: postDelete } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id')
      .eq('user_id', ctx.userId);
    expect(postDelete!.length).toBe(4);

    // Restore.
    const { data: result, error: restoreErr } = await chefbyte(ctx.client).rpc('restore_chefbyte_backup', {
      p_backup: snapshot,
    });
    expect(restoreErr).toBeNull();
    expect(result).toBeTruthy();

    // Post-restore: product is back with the SAME UUID.
    const { data: postRestore } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id, name')
      .eq('user_id', ctx.userId);
    expect(postRestore!.length).toBe(5);
    const found = postRestore!.find((p: any) => p.product_id === targetProductId);
    expect(found).toBeTruthy();
    expect(found.name).toBe('Birds Eye Sweet Peas');

    // Wiped / restored counts surfaced in the result envelope.
    const envelope = result as any;
    expect(envelope.schema_version).toBe(EXPECTED_SCHEMA_VERSION);
    expect(envelope.user_id).toBe(ctx.userId);
    expect(envelope.wiped.products).toBe(4); // 4 survived the pre-restore delete
    expect(envelope.restored.products).toBe(5); // 5 in the backup
  });

  // -----------------------------------------------------------------------
  // Wipe semantics: restore wipes rows not in the backup
  // -----------------------------------------------------------------------
  it('restore is wipe-and-replace: extras get removed', async () => {
    // Snapshot current state (5 products).
    const { data: snapshot } = await chefbyte(ctx.client).rpc('export_chefbyte_backup');

    // Insert a new product that is NOT in the snapshot.
    const { error: insertErr } = await chefbyte(ctx.client).from('products').insert({
      user_id: ctx.userId,
      name: 'Post-Snapshot Product',
      calories_per_serving: 100,
      carbs_per_serving: 0,
      protein_per_serving: 0,
      fat_per_serving: 0,
    });
    expect(insertErr).toBeNull();

    // Verify we now have 6 products.
    const { data: sixProducts } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id')
      .eq('user_id', ctx.userId);
    expect(sixProducts!.length).toBe(6);

    // Restore the 5-product snapshot.
    const { error: restoreErr } = await chefbyte(ctx.client).rpc('restore_chefbyte_backup', {
      p_backup: snapshot,
    });
    expect(restoreErr).toBeNull();

    // Post-restore: back to 5. The post-snapshot product is gone.
    const { data: backToFive } = await chefbyte(ctx.client).from('products').select('name').eq('user_id', ctx.userId);
    expect(backToFive!.length).toBe(5);
    expect(backToFive!.find((p: any) => p.name === 'Post-Snapshot Product')).toBeFalsy();
  });

  // -----------------------------------------------------------------------
  // schema_version mismatch rejection
  // -----------------------------------------------------------------------
  it('restore rejects a schema_version mismatch', async () => {
    const { data: snapshot } = await chefbyte(ctx.client).rpc('export_chefbyte_backup');
    const tampered = { ...(snapshot as any), schema_version: '99999999999999' };

    // Count products before the bad restore.
    const { data: preCount } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id', { count: 'exact' })
      .eq('user_id', ctx.userId);

    const { error } = await chefbyte(ctx.client).rpc('restore_chefbyte_backup', {
      p_backup: tampered,
    });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/schema_version mismatch/i);

    // State unchanged.
    const { data: postCount } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id')
      .eq('user_id', ctx.userId);
    expect(postCount!.length).toBe(preCount!.length);
  });

  // -----------------------------------------------------------------------
  // Cross-user rejection (top-level user_id differs from auth.uid)
  // -----------------------------------------------------------------------
  it('restore rejects a backup owned by a different user', async () => {
    const { data: snapshot } = await chefbyte(ctx.client).rpc('export_chefbyte_backup');
    const foreign = {
      ...(snapshot as any),
      user_id: '00000000-0000-0000-0000-0000000000ff',
    };

    const { error } = await chefbyte(ctx.client).rpc('restore_chefbyte_backup', {
      p_backup: foreign,
    });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/different user/i);
  });

  // -----------------------------------------------------------------------
  // Per-row user_id guard (mixed-user payload)
  // -----------------------------------------------------------------------
  it('restore rejects a payload with a row carrying a foreign user_id', async () => {
    const { data: snapshot } = await chefbyte(ctx.client).rpc('export_chefbyte_backup');
    const mixed = JSON.parse(JSON.stringify(snapshot)) as any; // deep clone
    // Tamper the first product's user_id to a foreign UUID.
    mixed.tables.products[0].user_id = '00000000-0000-0000-0000-0000000000ff';

    const { error } = await chefbyte(ctx.client).rpc('restore_chefbyte_backup', {
      p_backup: mixed,
    });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/foreign user_id/i);

    // And state should NOT have been wiped.
    const { data: stillFive } = await chefbyte(ctx.client)
      .from('products')
      .select('product_id')
      .eq('user_id', ctx.userId);
    expect(stillFive!.length).toBe(5);
  });
});
