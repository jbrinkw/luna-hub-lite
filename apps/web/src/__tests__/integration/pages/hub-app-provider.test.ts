import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPageTestContext, hub, assertQuerySucceeds, type PageTestContext } from './helpers';

describe('Hub AppProvider queries', () => {
  let ctx: PageTestContext;

  beforeAll(async () => {
    ctx = await createPageTestContext('hub-provider');
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // -------------------------------------------------------------------
  // AppProvider: app_activations query
  // Source: AppProvider.tsx line 31-35
  //   await supabase.schema('hub')
  //     .from('app_activations')
  //     .select('app_name')
  //     .eq('user_id', user.id)
  // -------------------------------------------------------------------
  it('app_activations query returns activated apps', async () => {
    const result = await hub(ctx.client).from('app_activations').select('app_name').eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'app_activations');
    expect(Array.isArray(data)).toBe(true);
    // createPageTestContext activates both coachbyte and chefbyte
    expect(data.length).toBe(2);

    const appNames = data.map((row: any) => row.app_name).sort();
    expect(appNames).toEqual(['chefbyte', 'coachbyte']);
  });

  // -------------------------------------------------------------------
  // AppProvider: map construction from app_activations
  // Source: AppProvider.tsx line 37-38
  //   const map = {};
  //   (data || []).forEach((row) => { map[row.app_name] = true; });
  // -------------------------------------------------------------------
  it('app_activations can be mapped to activation record', async () => {
    const result = await hub(ctx.client).from('app_activations').select('app_name').eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'activations for mapping');
    const map: Record<string, boolean> = {};
    (data || []).forEach((row: any) => {
      map[row.app_name] = true;
    });

    expect(map['coachbyte']).toBe(true);
    expect(map['chefbyte']).toBe(true);
    expect(map['nonexistent']).toBeUndefined();
  });

  // -------------------------------------------------------------------
  // Hub: profiles query (used across Hub pages)
  // Source: Multiple hub pages (ProfilePage, SettingsPage, etc.)
  //   supabase.schema('hub').from('profiles')
  //     .select('user_id, display_name, timezone, day_start_hour')
  //     .eq('user_id', user.id).single()
  // -------------------------------------------------------------------
  it('profiles query returns user profile with correct columns', async () => {
    const result = await hub(ctx.client)
      .from('profiles')
      .select('user_id, display_name, timezone, day_start_hour')
      .eq('user_id', ctx.userId)
      .single();

    const data = assertQuerySucceeds(result, 'profiles');
    expect(data.user_id).toBe(ctx.userId);
    expect(data).toHaveProperty('display_name');
    expect(data).toHaveProperty('timezone');
    expect(data).toHaveProperty('day_start_hour');
    // Defaults from schema
    expect(data.timezone).toBe('America/New_York');
    expect(data.day_start_hour).toBe(6);
  });

  // -------------------------------------------------------------------
  // Hub: deactivate_app RPC
  // Source: Hub SettingsPage / AppProvider refreshActivations
  //   hub.rpc('deactivate_app', { p_app_name: 'chefbyte' })
  // -------------------------------------------------------------------
  it('deactivate_app RPC removes app from activations', async () => {
    const deactivateResult = await hub(ctx.client).rpc('deactivate_app', {
      p_app_name: 'chefbyte',
    });
    expect(deactivateResult.error).toBeNull();

    // Verify chefbyte is no longer in activations (EXACT query from AppProvider)
    const result = await hub(ctx.client).from('app_activations').select('app_name').eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'activations after deactivate');
    const appNames = data.map((row: any) => row.app_name);
    expect(appNames).not.toContain('chefbyte');
    expect(appNames).toContain('coachbyte');
  });

  // -------------------------------------------------------------------
  // Hub: activate_app RPC
  // Source: Hub SettingsPage / AppProvider refreshActivations
  //   hub.rpc('activate_app', { p_app_name: 'chefbyte' })
  // -------------------------------------------------------------------
  it('activate_app RPC re-adds app to activations', async () => {
    const activateResult = await hub(ctx.client).rpc('activate_app', {
      p_app_name: 'chefbyte',
    });
    expect(activateResult.error).toBeNull();

    // Verify chefbyte is back (EXACT query from AppProvider)
    const result = await hub(ctx.client).from('app_activations').select('app_name').eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'activations after reactivate');
    const appNames = data.map((row: any) => row.app_name).sort();
    expect(appNames).toEqual(['chefbyte', 'coachbyte']);
  });

  // -------------------------------------------------------------------
  // Hub: user_tool_config query
  // Source: Hub SettingsPage (used when loading tool toggles)
  //   supabase.schema('hub').from('user_tool_config')
  //     .select('tool_name, enabled')
  //     .eq('user_id', user.id)
  // -------------------------------------------------------------------
  it('user_tool_config query succeeds (initially empty)', async () => {
    const result = await hub(ctx.client)
      .from('user_tool_config')
      .select('tool_name, enabled')
      .eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'user_tool_config');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);
  });

  // -------------------------------------------------------------------
  // Hub: user_tool_config upsert
  // Source: Hub SettingsPage (tool toggle handler)
  //   .from('user_tool_config')
  //     .upsert({ user_id, tool_name, enabled }, { onConflict: 'user_id,tool_name' })
  // -------------------------------------------------------------------
  it('user_tool_config upsert and read round-trip', async () => {
    const upsertResult = await hub(ctx.client)
      .from('user_tool_config')
      .upsert(
        { user_id: ctx.userId, tool_name: 'CHEFBYTE_SCAN_BARCODE', enabled: true },
        { onConflict: 'user_id,tool_name' },
      );
    expect(upsertResult.error).toBeNull();

    // Read it back
    const result = await hub(ctx.client)
      .from('user_tool_config')
      .select('tool_name, enabled')
      .eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'tool config after upsert');
    expect(data.length).toBe(1);
    expect(data[0].tool_name).toBe('CHEFBYTE_SCAN_BARCODE');
    expect(data[0].enabled).toBe(true);

    // Toggle it off
    const toggleResult = await hub(ctx.client)
      .from('user_tool_config')
      .upsert(
        { user_id: ctx.userId, tool_name: 'CHEFBYTE_SCAN_BARCODE', enabled: false },
        { onConflict: 'user_id,tool_name' },
      );
    expect(toggleResult.error).toBeNull();

    // Verify toggle
    const verifyResult = await hub(ctx.client)
      .from('user_tool_config')
      .select('tool_name, enabled')
      .eq('user_id', ctx.userId)
      .eq('tool_name', 'CHEFBYTE_SCAN_BARCODE')
      .single();

    const verifyData = assertQuerySucceeds(verifyResult, 'tool config after toggle');
    expect(verifyData.enabled).toBe(false);
  });

  // -------------------------------------------------------------------
  // Hub: profiles update
  // Source: Hub ProfilePage
  //   supabase.schema('hub').from('profiles')
  //     .update({ display_name, timezone, day_start_hour })
  //     .eq('user_id', user.id)
  // -------------------------------------------------------------------
  it('profiles update persists changes', async () => {
    const updateResult = await hub(ctx.client)
      .from('profiles')
      .update({
        display_name: 'Test User',
        timezone: 'America/Chicago',
        day_start_hour: 4,
      })
      .eq('user_id', ctx.userId);
    expect(updateResult.error).toBeNull();

    // Read back to verify
    const result = await hub(ctx.client)
      .from('profiles')
      .select('user_id, display_name, timezone, day_start_hour')
      .eq('user_id', ctx.userId)
      .single();

    const data = assertQuerySucceeds(result, 'profile after update');
    expect(data.display_name).toBe('Test User');
    expect(data.timezone).toBe('America/Chicago');
    expect(data.day_start_hour).toBe(4);
  });
});
