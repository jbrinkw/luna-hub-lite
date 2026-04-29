import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPageTestContext, type PageTestContext } from './helpers';

/* Empty-fixture sibling for chef-backup-restore.test.ts (L9 audit) */

describe('ChefByte backup_restore RPC — empty fixture', () => {
  let ctx: PageTestContext;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-backup-empty');
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('export_chefbyte_backup returns a structurally-valid empty payload for a fresh user', async () => {
    const { data, error } = await (ctx.client as any).schema('chefbyte').rpc('export_chefbyte_backup');
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    const backup = data as any;

    // Envelope is present even for an empty user
    expect(typeof backup.schema_version).toBe('string');
    expect(backup.user_id).toBe(ctx.userId);
    expect(typeof backup.generated_at).toBe('string');
    expect(backup.tables).toBeTruthy();

    // Every business-data table is an empty array (default Fridge/etc.
    // locations may be populated by the activation trigger — those are
    // expected, not user-created data).
    for (const key of [
      'products',
      'stock_lots',
      'recipes',
      'recipe_ingredients',
      'meal_plan_entries',
      'food_logs',
      'temp_items',
      'shopping_list',
    ]) {
      expect(Array.isArray(backup.tables[key])).toBe(true);
      expect(backup.tables[key]).toEqual([]);
    }
  });
});
