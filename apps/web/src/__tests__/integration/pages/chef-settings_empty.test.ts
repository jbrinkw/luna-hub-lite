import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPageTestContext, chefbyte, assertQuerySucceeds, type PageTestContext } from './helpers';

/* Empty-fixture sibling for chef-settings.test.ts (L9 audit) */

describe('ChefByte SettingsPage queries — empty fixture', () => {
  let ctx: PageTestContext;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-settings-empty');
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('user_config returns [] for a fresh user (settings page must render defaults)', async () => {
    const result = await chefbyte(ctx.client).from('user_config').select('key,value').eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'user_config');
    expect(data).toEqual([]);
  });

  it('locations contains the auto-provisioned defaults for a fresh user', async () => {
    // Activation trigger seeds Fridge/Pantry/Freezer. Empty user_config
    // must NOT mean empty locations — page would have nowhere to put new lots.
    const result = await chefbyte(ctx.client)
      .from('locations')
      .select('name')
      .eq('user_id', ctx.userId)
      .order('created_at');

    const data = assertQuerySucceeds(result, 'locations');
    expect(data.length).toBeGreaterThan(0);
    const names = data.map((l: any) => l.name);
    expect(names).toContain('Fridge');
  });
});
