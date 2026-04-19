import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

/**
 * shelf-ingest — cloud endpoint for the Live Shelf Raspberry Pi.
 *
 * Single entrypoint with path-based routing (Supabase edge functions mount
 * at one URL). Auth is `x-api-key` → SHA-256 → lookup in
 * chefbyte.live_shelf_devices. `verify_jwt = false` in config.toml.
 *
 * Routes:
 *   GET  /shelf-ingest/catalog    — products + stock + pairings + locations
 *   POST /shelf-ingest/event      — apply one scale event via private.apply_shelf_event
 *   POST /shelf-ingest/intake     — upsert a product (barcode flow)
 *   POST /shelf-ingest/heartbeat  — update device + scale_pairings rows
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** SHA-256 hash using Web Crypto API, returns hex string */
async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

type Device = {
  device_id: string;
  user_id: string;
};

/** Authenticate by x-api-key header. Returns device or null. */
async function authenticate(supabase: SupabaseClient, apiKey: string | null): Promise<Device | null> {
  if (!apiKey) return null;
  const keyHash = await sha256(apiKey);
  const { data, error } = await supabase
    .schema('chefbyte')
    .from('live_shelf_devices')
    .select('device_id, user_id, is_active')
    .eq('import_key_hash', keyHash)
    .maybeSingle();

  if (error || !data) return null;
  if (!data.is_active) return null;
  return { device_id: data.device_id, user_id: data.user_id };
}

// ─── Route handlers ──────────────────────────────────────────────────────

async function handleCatalog(supabase: SupabaseClient, device: Device): Promise<Response> {
  const userId = device.user_id;

  const [productsRes, stockRes, pairingsRes, locationsRes] = await Promise.all([
    supabase
      .schema('chefbyte')
      .from('products')
      .select(
        'product_id, name, barcode, net_weight_g, gross_weight_g, tare_weight_g, container_type, servings_per_container, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving',
      )
      .eq('user_id', userId),
    supabase
      .schema('chefbyte')
      .from('stock_lots')
      .select('lot_id, product_id, location_id, qty_containers, expires_on, last_update_source, last_update_ts')
      .eq('user_id', userId)
      .gt('qty_containers', 0),
    supabase
      .schema('chefbyte')
      .from('scale_pairings')
      .select('scale_id, kind, product_id')
      .eq('user_id', userId)
      .eq('device_id', device.device_id),
    supabase.schema('chefbyte').from('locations').select('location_id, name').eq('user_id', userId),
  ]);

  if (productsRes.error) throw productsRes.error;
  if (stockRes.error) throw stockRes.error;
  if (pairingsRes.error) throw pairingsRes.error;
  if (locationsRes.error) throw locationsRes.error;

  return jsonResponse({
    products: productsRes.data ?? [],
    stock: stockRes.data ?? [],
    pairings: pairingsRes.data ?? [],
    locations: locationsRes.data ?? [],
  });
}

async function handleEvent(supabase: SupabaseClient, device: Device, body: any): Promise<Response> {
  const scaleId: string | undefined = body?.scale_id;
  const kind: string | undefined = body?.kind;
  const eventKind: string | undefined = body?.event_kind;
  const deltaG: number | undefined = typeof body?.delta_g === 'number' ? body.delta_g : undefined;
  const occurredAt: string | undefined = body?.occurred_at;
  const clientEventId: string | undefined =
    typeof body?.client_event_id === 'string' && body.client_event_id.length > 0 ? body.client_event_id : undefined;
  let productId: string | null = body?.product_id ?? null;

  if (!scaleId || !kind || !eventKind || deltaG === undefined || !occurredAt) {
    return jsonResponse(
      {
        error: 'scale_id, kind, event_kind, delta_g, occurred_at are required',
      },
      400,
    );
  }

  // The Pi always sends client_event_id — absence is a client bug, not a
  // network hiccup. Bail early so retries can't slip through without a
  // dedup key.
  if (!clientEventId) {
    return jsonResponse({ error: 'client_event_id required' }, 400);
  }

  if (!['live_shelf', 'live_scale', 'catch_all'].includes(kind)) {
    return jsonResponse({ error: 'invalid kind' }, 400);
  }

  // Idempotency: if we've already processed this client_event_id for this
  // user, return the prior result and don't re-apply. Keyed on user_id so
  // different users can independently use the same UUID (defensive — the
  // Pi generates v4 so collisions are astronomically unlikely).
  const { data: existingLog } = await supabase
    .schema('chefbyte')
    .from('shelf_event_log')
    .select('applied, resolved_lot_id, reason')
    .eq('user_id', device.user_id)
    .eq('client_event_id', clientEventId)
    .maybeSingle();

  if (existingLog) {
    return jsonResponse({
      ok: true,
      applied: false,
      resolved_lot_id: existingLog.resolved_lot_id ?? null,
      reason: 'duplicate',
      original_reason: existingLog.reason ?? null,
    });
  }

  // Resolve product_id for live_scale via pairing when not provided.
  // Distinguish "scale unknown" (no pairing row) from "scale known but
  // product not set" (row with NULL product_id).
  if (!productId && kind === 'live_scale') {
    const { data: pairing } = await supabase
      .schema('chefbyte')
      .from('scale_pairings')
      .select('pairing_id, product_id')
      .eq('user_id', device.user_id)
      .eq('device_id', device.device_id)
      .eq('scale_id', scaleId)
      .maybeSingle();

    if (!pairing) {
      return jsonResponse({ error: 'scale not paired' }, 409);
    }
    productId = pairing.product_id ?? null;
    if (!productId) {
      return jsonResponse({ error: 'scale paired but product unset' }, 409);
    }
  }

  if (!productId) {
    return jsonResponse({ error: 'product_id required' }, 400);
  }

  // `private.apply_shelf_event` isn't exposed via PostgREST (schema not in
  // config.toml `schemas`), so we call it through the service-role-only
  // wrapper `chefbyte.apply_shelf_event_admin` (see migration
  // 20260419030000_shelf_ingest_wrapper.sql).
  const { data, error } = await (supabase as any).schema('chefbyte').rpc('apply_shelf_event_admin', {
    p_user_id: device.user_id,
    p_device_id: device.device_id,
    p_scale_id: scaleId,
    p_kind: kind,
    p_event_kind: eventKind,
    p_product_id: productId,
    p_delta_g: deltaG,
    p_occurred_at: occurredAt,
  });

  if (error) {
    console.error('apply_shelf_event error:', error);
    return jsonResponse({ error: 'apply_shelf_event failed' }, 500);
  }

  // RPC returns the composite row as an object.
  const row = Array.isArray(data) ? data[0] : data;
  const applied = Boolean(row?.applied);
  const resolvedLotId = row?.resolved_lot_id ?? null;
  const reason = row?.reason ?? null;

  // Log the result keyed on client_event_id so a retry returns the cached
  // outcome. ON CONFLICT DO NOTHING handles concurrent duplicates: the
  // losing INSERT returns no row, and we fetch the winner's result below.
  const { data: inserted, error: logErr } = await supabase
    .schema('chefbyte')
    .from('shelf_event_log')
    .upsert(
      {
        user_id: device.user_id,
        device_id: device.device_id,
        client_event_id: clientEventId,
        payload: {
          scale_id: scaleId,
          kind,
          event_kind: eventKind,
          product_id: productId,
          delta_g: deltaG,
          occurred_at: occurredAt,
        },
        applied,
        resolved_lot_id: resolvedLotId,
        reason,
      },
      { onConflict: 'user_id,client_event_id', ignoreDuplicates: true },
    )
    .select('applied, resolved_lot_id, reason')
    .maybeSingle();

  if (logErr) {
    // Don't fail the request if the log write fails — the stock mutation
    // already happened. Just surface the error in logs.
    console.error('shelf_event_log insert failed:', logErr);
  }

  // If the upsert didn't insert a row (concurrent duplicate), fetch the
  // winning row's result so the caller still sees the canonical outcome.
  if (!inserted) {
    const { data: winner } = await supabase
      .schema('chefbyte')
      .from('shelf_event_log')
      .select('applied, resolved_lot_id, reason')
      .eq('user_id', device.user_id)
      .eq('client_event_id', clientEventId)
      .maybeSingle();
    if (winner) {
      return jsonResponse({
        ok: true,
        applied: false,
        resolved_lot_id: winner.resolved_lot_id ?? null,
        reason: 'duplicate',
        original_reason: winner.reason ?? null,
      });
    }
  }

  return jsonResponse({
    ok: true,
    applied,
    resolved_lot_id: resolvedLotId,
    reason,
  });
}

async function handleIntake(supabase: SupabaseClient, device: Device, body: any): Promise<Response> {
  const name: string | undefined = body?.name;
  if (!name || typeof name !== 'string') {
    return jsonResponse({ error: 'name required' }, 400);
  }

  const userId = device.user_id;
  const payload: Record<string, unknown> = {
    user_id: userId,
    name,
    barcode: body?.barcode ?? null,
    description: body?.description ?? null,
    net_weight_g: body?.net_weight_g ?? null,
    gross_weight_g: body?.gross_weight_g ?? null,
    tare_weight_g: body?.tare_weight_g ?? null,
    container_type: body?.container_type ?? null,
  };
  // Only overwrite macro fields if provided — columns are NOT NULL with defaults.
  if (body?.servings_per_container !== undefined) payload.servings_per_container = body.servings_per_container;
  if (body?.calories_per_serving !== undefined) payload.calories_per_serving = body.calories_per_serving;
  if (body?.carbs_per_serving !== undefined) payload.carbs_per_serving = body.carbs_per_serving;
  if (body?.protein_per_serving !== undefined) payload.protein_per_serving = body.protein_per_serving;
  if (body?.fat_per_serving !== undefined) payload.fat_per_serving = body.fat_per_serving;

  // Upsert semantics on (user_id, barcode): if a row exists with the same
  // barcode for this user, update it; otherwise insert. No composite unique
  // constraint exists in the schema, so we check-then-write.
  const barcode = body?.barcode ?? null;
  if (barcode) {
    const { data: existing } = await supabase
      .schema('chefbyte')
      .from('products')
      .select('product_id')
      .eq('user_id', userId)
      .eq('barcode', barcode)
      .maybeSingle();

    if (existing?.product_id) {
      // Don't overwrite user_id on update.
      const updatePayload = { ...payload };
      delete updatePayload.user_id;
      // Scope the update on BOTH product_id AND user_id as defense-in-depth —
      // even though we only select products.product_id for the current
      // user above, pinning user_id guarantees we can never mutate another
      // user's row if the product_id lookup ever widens.
      const { error: updErr } = await supabase
        .schema('chefbyte')
        .from('products')
        .update(updatePayload)
        .eq('product_id', existing.product_id)
        .eq('user_id', userId);
      if (updErr) throw updErr;
      return jsonResponse({ product_id: existing.product_id });
    }
  }

  const { data: inserted, error: insErr } = await supabase
    .schema('chefbyte')
    .from('products')
    .insert(payload)
    .select('product_id')
    .single();

  if (insErr) throw insErr;
  return jsonResponse({ product_id: inserted!.product_id });
}

async function handleHeartbeat(supabase: SupabaseClient, device: Device, body: any): Promise<Response> {
  const pendingReviewCount: number = typeof body?.pending_review_count === 'number' ? body.pending_review_count : 0;
  const scales: Array<{ scale_id: string; kind: string }> = Array.isArray(body?.scales) ? body.scales : [];

  const now = new Date().toISOString();
  const userId = device.user_id;

  // Update device heartbeat + pending review count. Scope on both
  // device_id and user_id as defense-in-depth: we authenticated the
  // device via its import_key_hash, but pinning user_id prevents any
  // accidental cross-tenant write if the device row is ever reassigned.
  const { error: devErr } = await supabase
    .schema('chefbyte')
    .from('live_shelf_devices')
    .update({
      last_heartbeat_ts: now,
      pending_review_count: pendingReviewCount,
    })
    .eq('device_id', device.device_id)
    .eq('user_id', userId);
  if (devErr) throw devErr;

  // For each reported scale: upsert keyed on (device_id, scale_id) WITHOUT
  // overwriting product_id on subsequent heartbeats. We check-then-write
  // rather than relying on ON CONFLICT because the set of columns we want
  // to write differs between insert and update.
  for (const s of scales) {
    if (!s?.scale_id || !s?.kind) continue;
    if (!['live_shelf', 'live_scale', 'catch_all'].includes(s.kind)) continue;

    const { data: existing } = await supabase
      .schema('chefbyte')
      .from('scale_pairings')
      .select('pairing_id')
      .eq('user_id', userId)
      .eq('device_id', device.device_id)
      .eq('scale_id', s.scale_id)
      .maybeSingle();

    if (existing?.pairing_id) {
      const { error: upErr } = await supabase
        .schema('chefbyte')
        .from('scale_pairings')
        .update({
          kind: s.kind,
          last_heartbeat_ts: now,
        })
        .eq('pairing_id', existing.pairing_id)
        .eq('user_id', userId);
      if (upErr) throw upErr;
    } else {
      const { error: inErr } = await supabase.schema('chefbyte').from('scale_pairings').insert({
        user_id: userId,
        device_id: device.device_id,
        scale_id: s.scale_id,
        kind: s.kind,
        last_heartbeat_ts: now,
      });
      if (inErr) throw inErr;
    }
  }

  return jsonResponse({ ok: true });
}

// ─── Entrypoint ──────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const device = await authenticate(supabase, req.headers.get('x-api-key'));
    if (!device) return jsonResponse({ error: 'unauthorized' }, 401);

    const url = new URL(req.url);
    // Supabase routes /functions/v1/shelf-ingest/<subpath>. The function only
    // sees the tail; accept both with and without a /shelf-ingest prefix.
    const path = url.pathname.replace(/\/+$/, ''); // strip trailing slash

    if (req.method === 'GET' && path.endsWith('/catalog')) {
      return await handleCatalog(supabase, device);
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));

      if (path.endsWith('/event')) return await handleEvent(supabase, device, body);
      if (path.endsWith('/intake')) return await handleIntake(supabase, device, body);
      if (path.endsWith('/heartbeat')) return await handleHeartbeat(supabase, device, body);
    }

    return jsonResponse({ error: 'not found' }, 404);
  } catch (error: any) {
    // Log full error server-side for debugging; return only a generic
    // message to the client so stack traces + DB internals never leak.
    console.error('shelf-ingest error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});
