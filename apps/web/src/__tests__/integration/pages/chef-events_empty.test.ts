import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPageTestContext, chefbyte, assertQuerySucceeds, type PageTestContext } from './helpers';

/* Empty-fixture sibling for chef-events.test.ts (L9 audit) */

describe('ChefByte EventViewer queries — empty fixture', () => {
  let ctx: PageTestContext;

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-events-empty');
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('shelf_event_log returns [] for a user with no live-shelf devices', async () => {
    // This is exactly the Pi `scale_pairings`-empty class: the EventViewer
    // page must render an empty state (not crash, not show a spinner forever)
    // when the user has never paired a Pi.
    const result = await chefbyte(ctx.client)
      .from('shelf_event_log')
      .select('event_id,client_event_id,applied,reason,created_at')
      .eq('user_id', ctx.userId)
      .order('created_at', { ascending: false })
      .limit(50);

    const data = assertQuerySucceeds(result, 'shelf_event_log');
    expect(data).toEqual([]);
  });

  it('apply_event_override RPC fails for a non-existent event', async () => {
    const { error } = await (ctx.client as any).schema('chefbyte').rpc('apply_event_override', {
      p_client_event_id: 'no-such-event-empty-fixture',
      p_decision: 'accept',
      p_corrected_product_id: null,
    });
    // Empty-table case must surface a clear error, not silently succeed.
    expect(error).not.toBeNull();
  });
});
