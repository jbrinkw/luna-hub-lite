import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

/**
 * shelf-ingest — cloud endpoint for the Live Shelf Raspberry Pi.
 *
 * Single entrypoint with path-based routing (Supabase edge functions mount
 * at one URL). Auth is `x-api-key` → SHA-256 → lookup in
 * chefbyte.live_shelf_devices. `verify_jwt = false` in config.toml.
 *
 * Routes:
 *   GET  /shelf-ingest/catalog       — products + stock + pairings + locations
 *   GET  /shelf-ingest/overrides     — event_overrides since watermark (+ lot state)
 *   GET  /shelf-ingest/lot-snapshot  — stock_lots delta since watermark (full row + tombstones)
 *   POST /shelf-ingest/event         — apply one scale event via private.apply_shelf_event
 *   POST /shelf-ingest/intake        — upsert a product (barcode flow)
 *   POST /shelf-ingest/heartbeat     — update device + scale_pairings rows
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
};

// ─── Validation constants ────────────────────────────────────────────
// Centralized so tests + future tuning land in one place.
const MAX_CLIENT_EVENT_ID_LEN = 128;
const MAX_SCALE_ID_LEN = 128;
const MAX_SCALES_PER_HEARTBEAT = 32;
// occurred_at must be within [now-30d, now+5m]. The upper bound catches 2099
// typos without rejecting minor clock drift on the Pi; the lower bound keeps
// an offline backlog reasonable.
const OCCURRED_AT_PAST_MS = 30 * 24 * 60 * 60 * 1000;
const OCCURRED_AT_FUTURE_MS = 5 * 60 * 1000;

const VALID_KINDS = ['live_shelf', 'live_scale', 'catch_all'] as const;
const VALID_EVENT_KINDS = [
  'consumed',
  'added',
  'refilled',
  'depleted',
  // In-flight markers — non-stock-mutating events that mirror the Pi's
  // on_shelf ↔ in_flight transitions into cloud stock_lots.in_flight_since.
  // See migration 20260425080000_shelf_event_in_flight_pickup.sql.
  'in_flight_pickup',
  'in_flight_return',
] as const;

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

/** True iff `s` round-trips through the Date ISO parser unchanged-ish. */
function isValidIsoTimestamp(s: unknown): s is string {
  if (typeof s !== 'string' || s.length === 0) return false;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return false;
  // Bound the year so wildly out-of-range parses (e.g. 99999-12-31) don't
  // slip through just because Date accepted them.
  const y = d.getUTCFullYear();
  return y >= 1970 && y <= 2999;
}

type Device = {
  device_id: string;
  user_id: string;
};

type AuthFailReason = 'bad_key' | 'inactive_device' | 'db_error';

type AuthResult = { ok: true; device: Device } | { ok: false; reason: AuthFailReason };

/** Authenticate by x-api-key header. Returns {ok, device} or failure reason. */
async function authenticate(supabase: SupabaseClient, apiKey: string | null): Promise<AuthResult> {
  if (!apiKey) return { ok: false, reason: 'bad_key' };
  const keyHash = await sha256(apiKey);
  const { data, error } = await supabase
    .schema('chefbyte')
    .from('live_shelf_devices')
    .select('device_id, user_id, is_active')
    .eq('import_key_hash', keyHash)
    .maybeSingle();

  if (error) return { ok: false, reason: 'db_error' };
  if (!data) return { ok: false, reason: 'bad_key' };
  if (!data.is_active) return { ok: false, reason: 'inactive_device' };
  return { ok: true, device: { device_id: data.device_id, user_id: data.user_id } };
}

// ─── Route handlers ──────────────────────────────────────────────────

async function handleCatalog(supabase: SupabaseClient, device: Device, url: URL): Promise<Response> {
  const userId = device.user_id;

  // Delta-sync support: when the Pi's product_sync_poller sends
  // ?updated_since=<iso8601>, narrow the products query to rows touched
  // since that timestamp. The other three lists (stock/pairings/locations)
  // are small + change constantly via scale events — no delta filter.
  // An invalid timestamp silently falls back to a full pull rather than
  // 400'ing; a stuck poller re-establishing its watermark is less painful
  // than a hard error at startup.
  const updatedSinceRaw = url.searchParams.get('updated_since');
  const updatedSince = updatedSinceRaw && isValidIsoTimestamp(updatedSinceRaw) ? updatedSinceRaw : null;
  if (updatedSinceRaw && !updatedSince) {
    console.warn('shelf-ingest: /catalog ignoring invalid updated_since', {
      value: updatedSinceRaw,
      device_id: device.device_id,
    });
  }

  // Projection includes updated_at so the Pi advances its high-watermark
  // to the max(updated_at) it just received — no reliance on the Pi's
  // own wall-clock (which may drift vs cloud).
  //
  // Soft-delete: deleted_at is included in the projection so the Pi
  // poller can apply local hard-deletes for tombstoned rows. Deleted
  // rows WITHIN the updated_since window must be returned — that's the
  // whole point of soft-delete for Pi propagation. Outside the window
  // (e.g. deleted 10 days ago, full catalog pull at boot), we filter
  // them out so the Pi's initial boot-sync stays clean. The poller
  // re-pulls any row it's already deleted locally; SQLite
  // DELETE-IF-EXISTS is idempotent anyway.
  let productsQuery = supabase
    .schema('chefbyte')
    .from('products')
    .select(
      'product_id, name, barcode, brand, variant, net_weight_g, gross_weight_g, tare_weight_g, serving_weight_g, container_type, unit_type, density_g_per_ml, certified, servings_per_container, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, updated_at, deleted_at',
    )
    .eq('user_id', userId);
  if (updatedSince) {
    // Delta pull: include both live + tombstoned rows changed since the
    // last watermark. The UPDATE that set deleted_at also bumped
    // updated_at via the products_set_updated_at trigger, so tombstones
    // naturally land in the delta window.
    productsQuery = productsQuery.gt('updated_at', updatedSince);
  } else {
    // Full pull (boot / fresh Pi): only live rows. A freshly-flashed Pi
    // has no ghost entries to reconcile against, so emitting the full
    // set of historical tombstones would be pure noise.
    productsQuery = productsQuery.is('deleted_at', null);
  }

  const [productsRes, stockRes, pairingsRes, locationsRes] = await Promise.all([
    productsQuery,
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

/**
 * GET /overrides?updated_since=<iso>
 *
 * Return event_overrides rows for the authenticated user whose updated_at
 * is strictly > the watermark, plus the derived post-reconcile lot state
 * (qty_containers, last_update_source, last_update_ts) for each override's
 * resolved_lot_id. The Pi consumes this to sync its local `lots` table
 * so a future scale event on that lot uses the correct baseline weight.
 *
 * Shape:
 *   {
 *     overrides: [
 *       { override_id, client_event_id, updated_at, stock_qty_override,
 *         macros_servings_override, event_kind_override, is_voided,
 *         macro_logging_enabled,
 *         // Denormalised from shelf_event_log so the Pi can map
 *         // override → lot without a second round-trip:
 *         resolved_lot_id, product_id, pi_event_id
 *       }, ...
 *     ],
 *     lots: [
 *       { lot_id, product_id, qty_containers, last_update_source,
 *         last_update_ts }
 *     ]
 *   }
 *
 * RLS: event_overrides.user_id = device.user_id is enforced at the DB
 * layer via the event_overrides_user_rls policy (service_role bypasses
 * RLS but we still filter explicitly in the query — defense-in-depth).
 * shelf_event_log join is also filtered on user_id so a malicious Pi
 * can't see cross-user rows by crafting a client_event_id collision.
 */
async function handleOverrides(supabase: SupabaseClient, device: Device, url: URL): Promise<Response> {
  const userId = device.user_id;

  const updatedSinceRaw = url.searchParams.get('updated_since');
  const updatedSince = updatedSinceRaw && isValidIsoTimestamp(updatedSinceRaw) ? updatedSinceRaw : null;
  if (updatedSinceRaw && !updatedSince) {
    console.warn('shelf-ingest: /overrides ignoring invalid updated_since', {
      value: updatedSinceRaw,
      device_id: device.device_id,
    });
  }

  // Pull overrides for this user, joined to the originating event row so
  // the Pi can resolve client_event_id → lot_id / product_id without a
  // second round-trip. Supabase PostgREST's implicit inner-join on the
  // embedded resource mirrors the SQL:
  //   SELECT ... FROM event_overrides
  //     JOIN shelf_event_log USING(user_id, client_event_id)
  //     WHERE event_overrides.updated_at > :watermark
  //
  // NOTE: there's no declared FK between these two tables (they share
  // user_id + client_event_id as a logical key), so we can't use
  // PostgREST's FK-embedding syntax. Instead we do two queries and join
  // in JS. That's fine for the expected volume — a heavy user might have
  // ~dozens of overrides per day, far below any N+1 concern.
  let overridesQuery = supabase
    .schema('chefbyte')
    .from('event_overrides')
    .select(
      'override_id, client_event_id, updated_at, stock_qty_override, macros_servings_override, calories_override, protein_override, carbs_override, fat_override, macro_logging_enabled, is_voided, event_kind_override',
    )
    .eq('user_id', userId)
    .order('updated_at', { ascending: true });
  if (updatedSince) {
    overridesQuery = overridesQuery.gt('updated_at', updatedSince);
  }

  const { data: overrides, error: overridesErr } = await overridesQuery;
  if (overridesErr) throw overridesErr;

  const overrideList = overrides ?? [];
  if (overrideList.length === 0) {
    return jsonResponse({ overrides: [], lots: [] });
  }

  // Resolve each override's client_event_id → originating shelf_event_log
  // row to get resolved_lot_id + pi_event_id. One IN-query batches all.
  const clientEventIds = overrideList.map((o: any) => o.client_event_id);
  const { data: eventRows, error: eventsErr } = await supabase
    .schema('chefbyte')
    .from('shelf_event_log')
    .select('client_event_id, resolved_lot_id, pi_event_id, payload')
    .eq('user_id', userId)
    .in('client_event_id', clientEventIds);
  if (eventsErr) throw eventsErr;

  const eventByClientId = new Map<string, any>();
  for (const row of eventRows ?? []) {
    eventByClientId.set(row.client_event_id, row);
  }

  // Enrich the override payload with the joined event fields so the Pi
  // has everything in one blob.
  const enriched = overrideList.map((o: any) => {
    const ev = eventByClientId.get(o.client_event_id);
    const payload = ev?.payload ?? {};
    return {
      ...o,
      resolved_lot_id: ev?.resolved_lot_id ?? null,
      pi_event_id: ev?.pi_event_id ?? null,
      product_id: payload?.product_id ?? null,
    };
  });

  // Post-reconcile lot state. apply_event_override mutates stock_lots
  // rows; the Pi needs the CURRENT qty_containers on each affected lot
  // so its local `lots.current_weight_g` can reflect reality. Pull the
  // distinct set of resolved_lot_ids that are non-null.
  const affectedLotIds = Array.from(
    new Set(
      enriched
        .map((o: any) => o.resolved_lot_id)
        .filter((x: string | null): x is string => typeof x === 'string' && x.length > 0),
    ),
  );

  let lots: any[] = [];
  if (affectedLotIds.length > 0) {
    const { data: lotRows, error: lotsErr } = await supabase
      .schema('chefbyte')
      .from('stock_lots')
      .select('lot_id, product_id, qty_containers, last_update_source, last_update_ts')
      .eq('user_id', userId)
      .in('lot_id', affectedLotIds);
    if (lotsErr) throw lotsErr;
    lots = lotRows ?? [];
  }

  return jsonResponse({
    overrides: enriched,
    lots,
  });
}

/**
 * GET /lot-snapshot?updated_since=<iso>
 *
 * Return chefbyte.stock_lots rows for the authenticated Pi's user whose
 * updated_at > watermark (or all rows when no watermark is supplied).
 * This is the cloud-side half of the lot-reconciliation loop: the Pi
 * polls this endpoint every 60s and mirrors deltas into its local
 * `cloud_lots` table so it has an authoritative view of cloud state.
 *
 * The companion to /catalog (products delta) — same shape, same
 * soft-delete semantics:
 *
 *   * Delta pull (updated_since supplied): returns live + tombstoned
 *     rows changed since the watermark. The Pi applies tombstones as
 *     local row deletes.
 *   * Full pull (no watermark): returns only live rows (deleted_at IS
 *     NULL). A freshly-flashed Pi doesn't need to see historical
 *     tombstones — just current state.
 *
 * Response shape:
 *   {
 *     lots: [
 *       { lot_id, product_id, location_id, qty_containers, expires_on,
 *         in_flight_since, pickup_event_id, updated_at, deleted_at },
 *       ...
 *     ]
 *   }
 *
 * An invalid updated_since silently degrades to a full pull (matches
 * /catalog + /overrides behavior — a stuck poller re-establishing its
 * watermark is less painful than a hard error at startup).
 *
 * RLS: we filter explicitly on user_id (defense-in-depth; service_role
 * bypasses RLS but the explicit filter limits the blast radius of any
 * future schema change).
 */
async function handleLotSnapshot(supabase: SupabaseClient, device: Device, url: URL): Promise<Response> {
  const userId = device.user_id;

  const updatedSinceRaw = url.searchParams.get('updated_since');
  const updatedSince = updatedSinceRaw && isValidIsoTimestamp(updatedSinceRaw) ? updatedSinceRaw : null;
  if (updatedSinceRaw && !updatedSince) {
    console.warn('shelf-ingest: /lot-snapshot ignoring invalid updated_since', {
      value: updatedSinceRaw,
      device_id: device.device_id,
    });
  }

  let q = supabase
    .schema('chefbyte')
    .from('stock_lots')
    .select(
      'lot_id, product_id, location_id, qty_containers, expires_on, in_flight_since, pickup_event_id, updated_at, deleted_at',
    )
    .eq('user_id', userId)
    .order('updated_at', { ascending: true });
  if (updatedSince) {
    // Delta pull: include tombstones. The stock_lots_set_updated_at
    // trigger (migration 20260426010000) bumps updated_at on every
    // UPDATE including the soft-delete UPDATE, so deleted_at IS NOT NULL
    // rows naturally land in the delta window.
    q = q.gt('updated_at', updatedSince);
  } else {
    // Full pull (boot / fresh Pi): live rows only. Historical tombstones
    // would be pure noise on first sync.
    q = q.is('deleted_at', null);
  }

  const { data, error } = await q;
  if (error) throw error;

  return jsonResponse({ lots: data ?? [] });
}

async function handleEvent(supabase: SupabaseClient, device: Device, body: any): Promise<Response> {
  const scaleId: string | undefined = body?.scale_id;
  const kind: string | undefined = body?.kind;
  const eventKind: string | undefined = body?.event_kind;
  const rawDelta: unknown = body?.delta_g;
  const deltaG: number | undefined = typeof rawDelta === 'number' ? rawDelta : undefined;
  const occurredAt: string | undefined = body?.occurred_at;
  const clientEventId: string | undefined =
    typeof body?.client_event_id === 'string' && body.client_event_id.length > 0 ? body.client_event_id : undefined;
  // Pi's scale_events.event_id — optional. Stored on shelf_event_log.pi_event_id
  // so the cloud event viewer can LAN-fetch the Pi's per-event images.
  // Backward-compatible: Pi versions predating this field omit it.
  const piEventId: string | null =
    typeof body?.pi_event_id === 'string' && body.pi_event_id.length > 0 && body.pi_event_id.length <= 128
      ? body.pi_event_id
      : null;
  let productId: string | null = body?.product_id ?? null;

  if (!scaleId || !kind || !eventKind || deltaG === undefined || !occurredAt) {
    return jsonResponse(
      {
        error: 'scale_id, kind, event_kind, delta_g, occurred_at are required',
      },
      400,
    );
  }

  // Structured log at event start. Logs every event, including duplicates +
  // validation failures downstream — gives a single grep point for a client
  // retrying / misbehaving.
  console.log('shelf-ingest: event', {
    client_event_id: clientEventId ?? null,
    device_id: device.device_id,
    scale_id: scaleId,
    kind,
    event_kind: eventKind,
  });

  // The Pi always sends client_event_id — absence is a client bug, not a
  // network hiccup. Bail early so retries can't slip through without a
  // dedup key.
  if (!clientEventId) {
    return jsonResponse({ error: 'client_event_id required' }, 400);
  }

  if (clientEventId.length > MAX_CLIENT_EVENT_ID_LEN) {
    return jsonResponse({ error: 'client_event_id too long' }, 400);
  }

  if (typeof scaleId !== 'string' || scaleId.length === 0 || scaleId.length > MAX_SCALE_ID_LEN) {
    return jsonResponse({ error: 'invalid scale_id' }, 400);
  }

  if (!VALID_KINDS.includes(kind as (typeof VALID_KINDS)[number])) {
    return jsonResponse({ error: 'invalid kind' }, 400);
  }

  if (!VALID_EVENT_KINDS.includes(eventKind as (typeof VALID_EVENT_KINDS)[number])) {
    return jsonResponse({ error: 'invalid event_kind' }, 400);
  }

  // delta_g must be a finite number. NaN is already excluded by the typeof
  // check above (typeof NaN === 'number') so !isFinite is the right filter.
  if (!Number.isFinite(deltaG)) {
    return jsonResponse({ error: 'invalid delta_g' }, 400);
  }

  if (!isValidIsoTimestamp(occurredAt)) {
    return jsonResponse({ error: 'invalid occurred_at' }, 400);
  }

  const occurredMs = new Date(occurredAt).getTime();
  const nowMs = Date.now();
  if (occurredMs < nowMs - OCCURRED_AT_PAST_MS || occurredMs > nowMs + OCCURRED_AT_FUTURE_MS) {
    // 422 (not 400) so the Pi's retry worker treats this as retryable —
    // wall-clock drift is a transient condition, not a permanent client bug.
    return jsonResponse({ error: 'occurred_at out of range' }, 422);
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

  // Hand off to the plpgsql function. It owns idempotency: if this
  // client_event_id was already processed, it replays the cached result
  // inside the same transaction (no race window).
  const { data, error } = await (supabase as any).schema('chefbyte').rpc('apply_shelf_event_admin', {
    p_user_id: device.user_id,
    p_device_id: device.device_id,
    p_scale_id: scaleId,
    p_kind: kind,
    p_event_kind: eventKind,
    p_product_id: productId,
    p_delta_g: deltaG,
    p_occurred_at: occurredAt,
    p_client_event_id: clientEventId,
    p_pi_event_id: piEventId,
  });

  if (error) {
    // Always include client_event_id so operators can correlate a 500 with
    // the Pi's retry queue.
    console.error('shelf-ingest: apply_shelf_event failed', {
      client_event_id: clientEventId,
      code: (error as any).code ?? null,
      message: (error as any).message ?? null,
    });
    return jsonResponse({ error: 'apply_shelf_event failed' }, 500);
  }

  // RPC returns the composite row as an object (or an array with one row
  // depending on the client version).
  const row = Array.isArray(data) ? data[0] : data;
  const applied = Boolean(row?.applied);
  const resolvedLotId = row?.resolved_lot_id ?? null;
  const reason = row?.reason ?? null;

  // Note: as of migration 20260419060000 the plpgsql no longer collapses
  // every replay to reason='duplicate'. A successful replay echoes the
  // cached applied=true + original reason + resolved_lot_id, so the Pi
  // can reconcile its retry queue against real outcomes.
  console.log('shelf-ingest: result', {
    client_event_id: clientEventId,
    applied,
    reason,
    resolved_lot_id: resolvedLotId,
  });

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
  // Build the payload from everything the Pi sends that we know how to
  // persist. Columns are all nullable (see migration 050000) so this
  // pass-through is safe.
  const payload: Record<string, unknown> = {
    user_id: userId,
    name,
    barcode: body?.barcode ?? null,
    brand: body?.brand ?? null,
    variant: body?.variant ?? null,
    description: body?.description ?? null,
    net_weight_g: body?.net_weight_g ?? null,
    gross_weight_g: body?.gross_weight_g ?? null,
    tare_weight_g: body?.tare_weight_g ?? null,
    serving_weight_g: body?.serving_weight_g ?? null,
    container_type: body?.container_type ?? null,
    unit_type: body?.unit_type ?? null,
    density_g_per_ml: body?.density_g_per_ml ?? null,
    certified: body?.certified ?? null,
  };
  // Only overwrite macro fields if provided — columns are NOT NULL with defaults.
  if (body?.servings_per_container !== undefined) payload.servings_per_container = body.servings_per_container;
  if (body?.calories_per_serving !== undefined) payload.calories_per_serving = body.calories_per_serving;
  if (body?.carbs_per_serving !== undefined) payload.carbs_per_serving = body.carbs_per_serving;
  if (body?.protein_per_serving !== undefined) payload.protein_per_serving = body.protein_per_serving;
  if (body?.fat_per_serving !== undefined) payload.fat_per_serving = body.fat_per_serving;

  // Upsert semantics on (user_id, barcode): if a row exists with the same
  // barcode for this user, update it; otherwise insert. The unique partial
  // index `products_user_barcode_unique` guarantees at most one match.
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
      const updatePayload = { ...payload };
      delete updatePayload.user_id;
      const { data: updated, error: updErr } = await supabase
        .schema('chefbyte')
        .from('products')
        .update(updatePayload)
        .eq('product_id', existing.product_id)
        .eq('user_id', userId)
        .select('*')
        .single();
      if (updErr) throw updErr;
      return jsonResponse(updated!);
    }
  }

  const { data: inserted, error: insErr } = await supabase
    .schema('chefbyte')
    .from('products')
    .insert(payload)
    .select('*')
    .single();

  if (insErr) throw insErr;
  return jsonResponse(inserted!);
}

/**
 * Apply a Pi-captured tare-weight to a single products row.
 *
 * Called by the Pi after the catch-all scale tare-capture interceptor
 * fires (see CATCH_ALL_TARE_CAPTURE_PLAN.md §4.2 cloud resolution).
 * Narrow by design: only bumps tare_weight_g, nothing else. The
 * product row must already exist + belong to the authenticated
 * device's user. Missing / cross-user rows return 404 so the Pi's
 * fire-and-forget caller logs once and moves on.
 */
async function handleProductTare(supabase: SupabaseClient, device: Device, body: any): Promise<Response> {
  const productId: string | undefined = body?.product_id;
  const tareRaw = body?.tare_weight_g;
  if (typeof productId !== 'string' || productId.length === 0) {
    return jsonResponse({ error: 'product_id required' }, 400);
  }
  const tare = typeof tareRaw === 'number' ? tareRaw : Number(tareRaw);
  if (!Number.isFinite(tare) || tare < 0) {
    return jsonResponse({ error: 'tare_weight_g must be a non-negative number' }, 400);
  }
  const userId = device.user_id;
  const { data: updated, error: updErr } = await supabase
    .schema('chefbyte')
    .from('products')
    .update({ tare_weight_g: tare })
    .eq('product_id', productId)
    .eq('user_id', userId)
    .select('product_id, tare_weight_g')
    .maybeSingle();
  if (updErr) throw updErr;
  if (!updated) {
    return jsonResponse({ error: 'product not found' }, 404);
  }
  return jsonResponse({
    ok: true,
    product_id: updated.product_id,
    tare_weight_g: updated.tare_weight_g,
  });
}

async function handleHeartbeat(supabase: SupabaseClient, device: Device, body: any): Promise<Response> {
  const pendingReviewCount: number = typeof body?.pending_review_count === 'number' ? body.pending_review_count : 0;
  // Scenario 7: the Pi heartbeat_provider includes these two counters so
  // the cloud UI can render backlog state (finding #10 of the cloud audit).
  // Non-negative guard: a bad client (or negative-number-as-string) must not
  // violate the CHECK constraint. Fall back to 0 silently — the next tick
  // will carry a valid number.
  const rawOutboxPending = body?.outbox_pending_count;
  const outboxPendingCount: number =
    typeof rawOutboxPending === 'number' && Number.isFinite(rawOutboxPending) && rawOutboxPending >= 0
      ? Math.trunc(rawOutboxPending)
      : 0;
  const rawOutboxPermanent = body?.outbox_permanent_failures;
  const outboxPermanentFailures: number =
    typeof rawOutboxPermanent === 'number' && Number.isFinite(rawOutboxPermanent) && rawOutboxPermanent >= 0
      ? Math.trunc(rawOutboxPermanent)
      : 0;
  const scales: Array<{ scale_id: string; kind: string }> = Array.isArray(body?.scales) ? body.scales : [];

  if (scales.length > MAX_SCALES_PER_HEARTBEAT) {
    return jsonResponse({ error: 'too many scales in heartbeat' }, 400);
  }

  // Pre-validate every scale entry so a 400 prevents partial writes.
  for (const s of scales) {
    if (!s || typeof s !== 'object') {
      return jsonResponse({ error: 'invalid scales entry' }, 400);
    }
    if (typeof s.scale_id !== 'string' || s.scale_id.length === 0 || s.scale_id.length > MAX_SCALE_ID_LEN) {
      return jsonResponse({ error: 'invalid scale_id' }, 400);
    }
    if (typeof s.kind !== 'string' || !VALID_KINDS.includes(s.kind as (typeof VALID_KINDS)[number])) {
      return jsonResponse({ error: 'invalid kind' }, 400);
    }
  }

  const now = new Date().toISOString();
  const userId = device.user_id;

  // Update device heartbeat + pending review count + outbox counters.
  // Scope on both device_id and user_id as defense-in-depth.
  const { error: devErr } = await supabase
    .schema('chefbyte')
    .from('live_shelf_devices')
    .update({
      last_heartbeat_ts: now,
      pending_review_count: pendingReviewCount,
      outbox_pending_count: outboxPendingCount,
      outbox_permanent_failures: outboxPermanentFailures,
    })
    .eq('device_id', device.device_id)
    .eq('user_id', userId);
  if (devErr) throw devErr;

  // Atomic bulk UPSERT via plpgsql helper. Critical properties:
  //   - Single round-trip (was up to 64 SELECT+INSERT/UPDATE before).
  //   - Concurrent heartbeats are race-free — ON CONFLICT (device_id,
  //     scale_id) DO UPDATE serializes on the unique index.
  //   - product_id is explicitly omitted from the UPDATE SET clause so
  //     existing pairings keep whatever product the user set via the UI.
  if (scales.length > 0) {
    const { error: hbErr } = await (supabase as any).schema('chefbyte').rpc('heartbeat_upsert_pairings_admin', {
      p_device_id: device.device_id,
      p_user_id: userId,
      p_scales: scales,
    });
    if (hbErr) {
      console.error('shelf-ingest: heartbeat_upsert_pairings_admin failed', {
        device_id: device.device_id,
        code: (hbErr as any).code ?? null,
        message: (hbErr as any).message ?? null,
      });
      throw hbErr;
    }
  }

  return jsonResponse({ ok: true });
}

// ─── Entrypoint ──────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const url = new URL(req.url);
    // Supabase routes /functions/v1/shelf-ingest/<subpath>. Strip trailing
    // slashes and derive the last path segment so `/catalog` matches exactly
    // (not `/catalogg`, `/catalog/evil`, etc.).
    const cleanedPath = url.pathname.replace(/\/+$/, '');
    const segments = cleanedPath.split('/').filter(Boolean);
    const leaf = segments[segments.length - 1] ?? '';

    const authRes = await authenticate(supabase, req.headers.get('x-api-key'));
    if (!authRes.ok) {
      console.warn('shelf-ingest: auth failed', { path: cleanedPath, reason: authRes.reason });
      return jsonResponse({ error: 'unauthorized' }, 401);
    }
    const device = authRes.device;

    if (req.method === 'GET' && leaf === 'catalog') {
      return await handleCatalog(supabase, device, url);
    }

    if (req.method === 'GET' && leaf === 'overrides') {
      return await handleOverrides(supabase, device, url);
    }

    if (req.method === 'GET' && leaf === 'lot-snapshot') {
      return await handleLotSnapshot(supabase, device, url);
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));

      if (leaf === 'event') return await handleEvent(supabase, device, body);
      if (leaf === 'intake') return await handleIntake(supabase, device, body);
      if (leaf === 'heartbeat') return await handleHeartbeat(supabase, device, body);
      if (leaf === 'product-tare') return await handleProductTare(supabase, device, body);
    }

    return jsonResponse({ error: 'not found' }, 404);
  } catch (error: any) {
    // Log full error server-side for debugging; return only a generic
    // message to the client so stack traces + DB internals never leak.
    console.error('shelf-ingest error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});
