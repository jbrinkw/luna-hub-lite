import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminClient } from '../../setup.integration';
import { createPageTestContext, chefbyte, type PageTestContext } from './helpers';

/**
 * Integration tests for the Event Viewer page's direct RPC contract.
 *
 * Complements the e2e spec by exercising the RPC surface independently
 * of the UI rendering layer — catches signature-level regressions without
 * paying for a full Playwright boot. Follows the multi-call lesson:
 * every action is verified by re-querying DB state, never by reading
 * back the RPC's own return value.
 */
describe('ChefByte apply_event_override — classifier review + retry', () => {
  let ctx: PageTestContext;
  let productId: string;
  let altProductId: string;
  let lotId: string;
  let deviceId: string;
  let locationId: string;
  const clientEventId = 'chef-events-rpc-001';

  beforeAll(async () => {
    ctx = await createPageTestContext('chef-events-rpc');

    // Default Fridge location.
    const { data: loc } = await chefbyte(ctx.client)
      .from('locations')
      .select('location_id')
      .eq('user_id', ctx.userId)
      .limit(1)
      .single();
    locationId = loc!.location_id;

    // Pi-original product.
    const { data: prod } = await chefbyte(ctx.client)
      .from('products')
      .insert({
        user_id: ctx.userId,
        name: 'Pi-Original Integration Product',
        net_weight_g: 100,
        servings_per_container: 2,
        calories_per_serving: 200,
        protein_per_serving: 20,
        carbs_per_serving: 10,
        fat_per_serving: 5,
      })
      .select('product_id')
      .single();
    productId = prod!.product_id;

    // Alternative product used as the classifier override target.
    const { data: altProd } = await chefbyte(ctx.client)
      .from('products')
      .insert({
        user_id: ctx.userId,
        name: 'Classifier Alternative',
        net_weight_g: 100,
        servings_per_container: 2,
        calories_per_serving: 150,
        protein_per_serving: 10,
        carbs_per_serving: 5,
        fat_per_serving: 3,
      })
      .select('product_id')
      .single();
    altProductId = altProd!.product_id;

    // Stock lot on the Pi-original product.
    const { data: lot } = await chefbyte(ctx.client)
      .from('stock_lots')
      .insert({
        user_id: ctx.userId,
        product_id: productId,
        location_id: locationId,
        qty_containers: 4,
        last_update_source: 'live_shelf',
        last_update_ts: new Date().toISOString(),
      })
      .select('lot_id')
      .single();
    lotId = lot!.lot_id;

    // Device + shelf_event_log row — service_role client since authenticated
    // role can't INSERT on live_shelf_devices + shelf_event_log.
    const { data: dev } = await (adminClient as any)
      .schema('chefbyte')
      .from('live_shelf_devices')
      .insert({
        user_id: ctx.userId,
        device_name: 'integration-device',
        import_key_hash: `integration-hash-${Math.random().toString(36).slice(2)}`,
      })
      .select('device_id')
      .single();
    deviceId = dev!.device_id;

    await (adminClient as any)
      .schema('chefbyte')
      .from('shelf_event_log')
      .insert({
        user_id: ctx.userId,
        device_id: deviceId,
        client_event_id: clientEventId,
        pi_event_id: 'pi-integration-001',
        payload: {
          scale_id: 'scale-int',
          kind: 'live_shelf',
          event_kind: 'consumed',
          product_id: productId,
          delta_g: -100,
          occurred_at: new Date().toISOString(),
        },
        applied: true,
        resolved_lot_id: lotId,
        reason: 'decremented',
        classifier_status: 'review',
        classification: { item_id: productId, confidence: 0.45, multi_match: [] },
      });
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('p_classifier_override_item_id routes food_log to the chosen product', async () => {
    const { error } = await (ctx.client as any).schema('chefbyte').rpc('apply_event_override', {
      p_client_event_id: clientEventId,
      p_stock_qty_override: null,
      p_macros_servings_override: 2,
      p_calories_override: null,
      p_protein_override: null,
      p_carbs_override: null,
      p_fat_override: null,
      p_macro_logging_enabled: true,
      p_is_voided: false,
      p_event_kind: 'consumed',
      p_classifier_override_item_id: altProductId,
    });
    expect(error).toBeNull();

    const { data: fl } = await chefbyte(ctx.client)
      .from('food_logs')
      .select('product_id, calories')
      .eq('source_client_event_id', clientEventId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    // Re-query; never trust the RPC return value alone.
    expect(fl!.product_id).toBe(altProductId);
    // 2 servings × alt_product.calories_per_serving 150 = 300
    expect(Number(fl!.calories)).toBe(300);
  });

  it('classifier_status auto-transitions review → classified', async () => {
    // Reset to review via admin (authenticated role lacks UPDATE on
    // shelf_event_log).
    await (adminClient as any)
      .schema('chefbyte')
      .from('shelf_event_log')
      .update({ classifier_status: 'review' })
      .eq('client_event_id', clientEventId);

    const { error } = await (ctx.client as any).schema('chefbyte').rpc('apply_event_override', {
      p_client_event_id: clientEventId,
      p_stock_qty_override: null,
      p_macros_servings_override: 1,
      p_calories_override: null,
      p_protein_override: null,
      p_carbs_override: null,
      p_fat_override: null,
      p_macro_logging_enabled: true,
      p_is_voided: false,
      p_event_kind: 'consumed',
      p_classifier_override_item_id: null,
    });
    expect(error).toBeNull();

    const { data } = await chefbyte(ctx.client)
      .from('shelf_event_log')
      .select('classifier_status')
      .eq('client_event_id', clientEventId)
      .single();
    expect(data!.classifier_status).toBe('classified');
  });

  it('void on review event leaves classifier_status=review', async () => {
    await (adminClient as any)
      .schema('chefbyte')
      .from('shelf_event_log')
      .update({ classifier_status: 'review' })
      .eq('client_event_id', clientEventId);

    const { error } = await (ctx.client as any).schema('chefbyte').rpc('apply_event_override', {
      p_client_event_id: clientEventId,
      p_stock_qty_override: null,
      p_macros_servings_override: null,
      p_calories_override: null,
      p_protein_override: null,
      p_carbs_override: null,
      p_fat_override: null,
      p_macro_logging_enabled: true,
      p_is_voided: true,
      p_event_kind: null,
      p_classifier_override_item_id: null,
    });
    expect(error).toBeNull();

    const { data } = await chefbyte(ctx.client)
      .from('shelf_event_log')
      .select('classifier_status')
      .eq('client_event_id', clientEventId)
      .single();
    expect(data!.classifier_status).toBe('review');
  });
});
