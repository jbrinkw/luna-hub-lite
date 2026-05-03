import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

// ─── Branded ID types (cross-process boundary) ───────────────────────
// Mirrors apps/web/src/shared/types/branded.ts. A UUID known to exist in
// cloud chefbyte.stock_lots.lot_id — prevents passing a Pi-local lot UUID
// where a cloud lot UUID is expected. Defined here because Deno edge
// functions can't import from the apps/web module graph.

/** A UUID known to exist in cloud `chefbyte.stock_lots.lot_id`. */
type CloudLotId = string & { readonly __brand: 'CloudLotId' };

const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Promote a raw string to CloudLotId after verifying it exists in
 * chefbyte.stock_lots for the given user. Rejects format-valid UUIDs
 * that are absent from the table (e.g. Pi-local lot UUIDs).
 *
 * Returns null when the raw value is null/empty (callers handle
 * optional lot_id fields). Throws on DB errors so the caller can 500.
 */
async function parseCloudLotId(
  raw: string | null,
  supabase: SupabaseClient,
  userId: string,
): Promise<CloudLotId | null> {
  if (!raw || raw.length === 0) return null;
  if (!_UUID_RE.test(raw)) return null; // format guard — not a UUID, skip
  const { data, error } = await supabase
    .schema('chefbyte')
    .from('stock_lots')
    .select('lot_id')
    .eq('lot_id', raw)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null; // UUID absent from cloud stock_lots
  return raw as CloudLotId;
}

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
 *   GET  /shelf-ingest/settings      — per-user classifier toggles (chefbyte_classifier_fallback_enabled, …)
 *   POST /shelf-ingest/event         — apply one scale event via private.apply_shelf_event
 *   POST /shelf-ingest/intake        — upsert a product (barcode flow)
 *   POST /shelf-ingest/heartbeat     — update device + scale_pairings rows
 *   POST /shelf-ingest/review-create — UPSERT a Pi-created review_queue row
 *                                      (sync-audit finding #5; idempotent on
 *                                      (user_id, pi_review_id))
 *   POST /shelf-ingest/review-resolve — Pi-driven push-back when the operator
 *                                       resolved a review on the Pi /inventory
 *                                       UI; cloud mirrors status+user_response
 *   GET  /shelf-ingest/review-resolved-since?updated_since=<iso>
 *                                      — Pi poller endpoint that returns cloud-
 *                                       side resolutions newer than the watermark
 *                                       so the Pi can mirror cloud UI resolutions
 *                                       back into its local review_queue.
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
  // Manual discard from Pi /inventory remove button. Zeros qty + clears
  // in_flight_since/pickup_event_id WITHOUT writing food_logs (no macro
  // tracking by design — spilled / fed-to-pet / given-away). See
  // migration 20260427020000_shelf_event_discarded.sql.
  'discarded',
  // Catch-all delta-capture pair (added 2026-04-27). The first event
  // snapshots the measured weight and reconciles stock_lots.qty_containers
  // (no macros). The second event references the first via pi_event_id,
  // computes consumption from the snapshotted pickup_weight_g, and writes
  // food_logs for the consumed delta. See migration
  // 20260427130000_catch_all_delta_apply.sql.
  'catch_all_first_measurement',
  'catch_all_second_measurement',
  // Per-lot live-weight observation stream from the Pi for live_shelf
  // and live_scale lots (catch_all already streams via the delta-capture
  // pair). Updates ONLY stock_lots.last_observed_weight_g +
  // last_observed_at — qty stays event-driven, no food_logs. See
  // migration 20260429030000_live_weight_sync.sql.
  'live_weight_sync',
] as const;

// Allowed values for chefbyte.scanner_state.last_active_mode and
// .locked_mode. Must stay in lockstep with the CHECK constraints in
// migration 20260503100000_scanner_state_and_transactions.sql.
const VALID_SCAN_MODES = new Set<string>(['purchase', 'consume_macros', 'consume_no_macros', 'shopping']);

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

  // Defensive ledger fallback (2026-04-29 — drains the
  // ledger-ize-is_active item from ignore.md). If the live row says
  // inactive but the most-recent ledger entry says became_active=true,
  // we trust the ledger. Rationale: the 2026-04-24 silent-revoke
  // incident flipped is_active=false on a row that was actively
  // heart-beating; a rogue UPDATE that bypasses the self-heal trigger
  // (e.g. a future migration's consolidation sweep) could repeat the
  // class. Reading the ledger here means a Pi whose live row has been
  // "silently revoked" can still authenticate as long as the ledger's
  // most-recent reality says active. The opposite (ledger inactive,
  // live active) keeps live as the source of truth — explicit Revoke
  // via the UI flips both, so trusting live there is correct.
  if (!data.is_active) {
    const { data: latestLedger } = await supabase
      .schema('chefbyte')
      .from('live_shelf_device_state_changes')
      .select('became_active, change_reason')
      .eq('device_id', data.device_id)
      .order('changed_at', { ascending: false })
      .order('change_id', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latestLedger || latestLedger.became_active === false) {
      return { ok: false, reason: 'inactive_device' };
    }
    // Ledger disagrees with live row — trust ledger and log so the
    // discrepancy is grep-able.
    console.warn('shelf-ingest: ledger overrides live is_active=false', {
      device_id: data.device_id,
      latest_ledger_reason: latestLedger.change_reason ?? null,
    });
  }
  return { ok: true, device: { device_id: data.device_id, user_id: data.user_id } };
}

// ─── Route handlers ──────────────────────────────────────────────────

async function handleCatalog(supabase: SupabaseClient, device: Device, url: URL): Promise<Response> {
  const userId = device.user_id;

  // Delta-sync support: when the Pi's product_sync_poller sends
  // ?updated_since=<iso8601>, narrow each list query to rows touched
  // since that timestamp.
  //
  // Sync-audit finding #10 (2026-04-29): all four lists are now delta-
  // filtered (previously only ``products`` was). The watermark column
  // per list:
  //   * products    — updated_at (set by the products_set_updated_at trigger)
  //   * stock_lots  — last_update_ts (stamped by apply_shelf_event on every
  //                   mutation; NULL on rows that haven't been touched
  //                   since the column was added → treated as "always
  //                   newer than the watermark" for safety)
  //   * scale_pairings — last_heartbeat_ts (stamped on heartbeat /
  //                   pairing). NULL on never-paired rows → same fallback.
  //   * locations   — created_at (locations don't have updated_at; their
  //                   only mutation is rename, which is rare; created_at
  //                   is sufficient to bring a fresh location to the Pi
  //                   on first sync).
  //
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

  // Delta filtering. When `updated_since` is supplied, return only rows
  // whose tracked timestamp is STRICTLY greater than the watermark. NULL
  // watermark columns are EXCLUDED from delta windows on purpose — a row
  // with a NULL last_update_ts / last_heartbeat_ts predates any sync
  // watermark the Pi could send, so the Pi already saw it during the
  // initial (no-watermark) full pull. Re-emitting NULL-timestamp rows
  // every poll defeats the whole point of delta filtering and breaks
  // the test contract "future watermark → empty list".
  let stockQuery = supabase
    .schema('chefbyte')
    .from('stock_lots')
    .select('lot_id, product_id, location_id, qty_containers, expires_on, last_update_source, last_update_ts')
    .eq('user_id', userId)
    .gt('qty_containers', 0);
  if (updatedSince) {
    stockQuery = stockQuery.gt('last_update_ts', updatedSince);
  }

  let pairingsQuery = supabase
    .schema('chefbyte')
    .from('scale_pairings')
    .select('scale_id, kind, product_id, lot_id, last_heartbeat_ts')
    .eq('user_id', userId)
    .eq('device_id', device.device_id);
  if (updatedSince) {
    pairingsQuery = pairingsQuery.gt('last_heartbeat_ts', updatedSince);
  }

  let locationsQuery = supabase
    .schema('chefbyte')
    .from('locations')
    .select('location_id, name, created_at')
    .eq('user_id', userId);
  if (updatedSince) {
    locationsQuery = locationsQuery.gt('created_at', updatedSince);
  }

  const [productsRes, stockRes, pairingsRes, locationsRes] = await Promise.all([
    productsQuery,
    stockQuery,
    pairingsQuery,
    locationsQuery,
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
 *         in_flight_since, in_flight_kind, pickup_event_id, created_at,
 *         updated_at, deleted_at },
 *       ...
 *     ]
 *   }
 *
 * `in_flight_kind` discriminates live_shelf vs catch_all in-flight rows
 * (migration 20260427120000) so the Pi's catch-all candidate-pool builder
 * can filter to the catch-all-only in-flight tier without re-querying.
 * `created_at` is the lot's import time, used by the catch-all
 * "certified-not-on-any-shelf" tier to FEFO by oldest-imported lot.
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
      'lot_id, product_id, location_id, qty_containers, expires_on, in_flight_since, in_flight_kind, pickup_event_id, created_at, updated_at, deleted_at',
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

/**
 * GET /settings
 *
 * Return per-user classifier toggles for the authenticated device's
 * user. Currently a single flag — `chefbyte_classifier_fallback_enabled`
 * — but shaped as an object so future toggles land additively.
 *
 * The Pi polls this endpoint on the same 60s cadence as
 * /lot-snapshot and caches the result in-memory. When the flag is
 * TRUE and the classifier's first pass returns UNKNOWN / low
 * confidence, the Pi runs a SECOND pass against ALL certified
 * LiveTrack-tracked products as a recovery fallback.
 *
 * RLS: we filter explicitly on user_id (defense-in-depth — service
 * role bypasses RLS but we still scope so a future schema change
 * can't leak cross-user toggles by accident). Returns the default
 * (FALSE) for any user that somehow lacks a profiles row, so the Pi
 * never crashes on a missing profile.
 */
async function handleSettings(supabase: SupabaseClient, device: Device): Promise<Response> {
  const userId = device.user_id;
  const { data, error } = await supabase
    .schema('hub')
    .from('profiles')
    .select('chefbyte_classifier_fallback_enabled')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return jsonResponse({
    chefbyte_classifier_fallback_enabled: Boolean(data?.chefbyte_classifier_fallback_enabled ?? false),
  });
}

/**
 * GET /events-by-pi-id?pi_event_ids=<comma-separated>
 *
 * Return the SUBSET of supplied ``pi_event_ids`` that already exist in
 * ``shelf_event_log`` for this device's user. Used by the Pi-side
 * startup back-fill (server/cloud/integration.py) to avoid re-emitting
 * resolutions the cloud already has — which previously caused
 * duplicate stock mutations on Pi restart.
 *
 * Request:
 *   ``?pi_event_ids=uuid-a,uuid-b,uuid-c`` — up to 200 ids.
 *
 * Response:
 *   ``{ "known": ["uuid-a", "uuid-c"] }`` — the ids the cloud already
 *   has applied (caller treats anything else as missing). Order is
 *   not guaranteed; callers should set-compare.
 *
 * RLS: filtered explicitly on ``user_id``. shelf_event_log has an
 * UNIQUE constraint on (user_id, client_event_id) AND a separate
 * (user_id, pi_event_id) presence — we look up by pi_event_id since
 * that's the stable id the Pi always knows (client_event_id rotates
 * across restarts). pi_event_id is sometimes NULL for legacy events;
 * those are simply absent from the response.
 */
async function handleEventsByPiId(supabase: SupabaseClient, device: Device, url: URL): Promise<Response> {
  const raw = url.searchParams.get('pi_event_ids') ?? '';
  // Accept up to 200 ids per call. The Pi's back-fill window is
  // typically <100 resolutions in 168h so this gives plenty of head-
  // room for batching while still capping pathological loads.
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 200);
  if (ids.length === 0) {
    return jsonResponse({ known: [] });
  }
  // Validate each id is a plausible UUID (length 36 + hex/-) — defense-
  // in-depth so a bad client can't smuggle SQL fragments through .in().
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const valid = ids.filter((s) => uuidRe.test(s));
  if (valid.length === 0) {
    return jsonResponse({ known: [] });
  }
  const { data, error } = await supabase
    .schema('chefbyte')
    .from('shelf_event_log')
    .select('pi_event_id')
    .eq('user_id', device.user_id)
    .in('pi_event_id', valid);
  if (error) throw error;
  const known = (data ?? [])
    .map((r: any) => r.pi_event_id)
    .filter((s: any): s is string => typeof s === 'string' && s.length > 0);
  return jsonResponse({ known });
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
  // Sync-audit finding #6 (2026-04-29): the Pi's usage_log.kind
  // discriminator (in_flight_ttl_expired / in_flight_return /
  // reconciler_use_return / single_item_consumed / etc.) propagates to
  // cloud food_logs.usage_kind so cloud-side analytics + Chef UI can
  // distinguish provenance. Optional — older Pi binaries omit the
  // field and the cloud writes NULL (matches the historical row shape).
  // Length cap mirrors the longest known enum value with headroom.
  const usageKind: string | null =
    typeof body?.usage_kind === 'string' && body.usage_kind.length > 0 && body.usage_kind.length <= 64
      ? body.usage_kind
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

  // pi_lot_id is forwarded by the Pi for two flows:
  //   * Codex MEDIUM-6 (2026-04-28): catch-all empty-bottle ``discarded``
  //     short-circuit (lot-targeted, see apply_discard_with_lot_id).
  //   * 2026-04-29: ``live_weight_sync`` per-lot weight stream — the
  //     live_shelf/live_scale equivalent of the catch-all delta-capture
  //     stream. The Pi knows the cloud lot_id (cloud_lots mirror) and
  //     names it directly so we don't need product-level FEFO.
  const piLotId: string | null =
    typeof body?.pi_lot_id === 'string' && body.pi_lot_id.length > 0 && body.pi_lot_id.length <= 64
      ? body.pi_lot_id
      : null;
  const isLiveWeightSync = eventKind === 'live_weight_sync';

  // live_weight_sync dispatch — runs BEFORE the product_id resolve/require
  // gates because the helper looks up the lot by pi_lot_id alone (the
  // product is implied by the lot row). Validate inputs explicitly.
  if (isLiveWeightSync) {
    if (kind !== 'live_shelf' && kind !== 'live_scale') {
      return jsonResponse({ error: 'live_weight_sync requires kind in (live_shelf, live_scale)' }, 400);
    }
    if (!piLotId) {
      return jsonResponse({ error: 'pi_lot_id required for live_weight_sync' }, 400);
    }
    // delta_g is repurposed as the absolute observed weight in grams
    // (mirrors the catch_all_first_measurement convention so the Pi's
    // emitter doesn't need a new payload schema). Must be non-negative.
    if (deltaG < 0) {
      return jsonResponse({ error: 'live_weight_sync delta_g must be non-negative (absolute observed weight)' }, 400);
    }
    // Namespace check: piLotId must be a cloud stock_lots UUID for this
    // user — not a Pi-local lot UUID. parseCloudLotId verifies it against
    // the actual table. A format-valid-but-absent UUID returns null (the
    // RPC would silently apply=false; we surface 404 instead).
    const cloudLotId: CloudLotId | null = await parseCloudLotId(piLotId, supabase, device.user_id);
    if (!cloudLotId) {
      return jsonResponse(
        { error: 'pi_lot_id not found in cloud stock_lots (namespace mismatch or unknown lot)' },
        404,
      );
    }
    const { data: lwsData, error: lwsError } = await (supabase as any)
      .schema('chefbyte')
      .rpc('apply_live_weight_sync_admin', {
        p_user_id: device.user_id,
        p_device_id: device.device_id,
        p_scale_id: scaleId,
        p_kind: kind,
        p_pi_lot_id: cloudLotId,
        p_observed_weight_g: deltaG,
        p_observed_at: occurredAt,
        p_client_event_id: clientEventId,
        p_pi_event_id: piEventId,
      });

    if (lwsError) {
      console.error('shelf-ingest: apply_live_weight_sync failed', {
        client_event_id: clientEventId,
        code: (lwsError as any).code ?? null,
        message: (lwsError as any).message ?? null,
      });
      return jsonResponse({ error: 'apply_live_weight_sync failed' }, 500);
    }

    const row = Array.isArray(lwsData) ? lwsData[0] : lwsData;
    const applied = Boolean(row?.applied);
    const resolvedLotId = row?.resolved_lot_id ?? null;
    const reason = row?.reason ?? null;
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

  // Codex MEDIUM-6 fix (2026-04-28): catch-all empty-bottle short-circuit
  // sends a ``discarded`` event with an explicit ``pi_lot_id`` so the cloud
  // zeros the visually-identified lot rather than whatever a product-level
  // FEFO would pick. Route those requests through the lot-targeted helper
  // (private.apply_discard_with_lot_id) added in 20260428030000. The
  // legacy apply_shelf_event_admin path remains the default — older Pi
  // versions that don't include pi_lot_id continue to work unchanged.
  const isLotTargetedDiscard = eventKind === 'discarded' && kind === 'catch_all' && piLotId !== null;

  let data: any;
  let error: any;
  if (isLotTargetedDiscard) {
    // Namespace check: piLotId for a discarded event must be a cloud lot UUID.
    // parse against stock_lots to reject Pi-local lot UUIDs at the boundary.
    const discardLotId: CloudLotId | null = await parseCloudLotId(piLotId, supabase, device.user_id);
    if (!discardLotId) {
      return jsonResponse(
        { error: 'pi_lot_id not found in cloud stock_lots (namespace mismatch or unknown lot)' },
        404,
      );
    }
    ({ data, error } = await (supabase as any).schema('chefbyte').rpc('apply_discard_with_lot_id_admin', {
      p_user_id: device.user_id,
      p_device_id: device.device_id,
      p_scale_id: scaleId,
      p_kind: kind,
      p_pi_lot_id: discardLotId,
      p_product_id: productId,
      p_occurred_at: occurredAt,
      p_client_event_id: clientEventId,
      p_pi_event_id: piEventId,
    }));
  } else {
    // Hand off to the plpgsql function. It owns idempotency: if this
    // client_event_id was already processed, it replays the cached result
    // inside the same transaction (no race window).
    ({ data, error } = await (supabase as any).schema('chefbyte').rpc('apply_shelf_event_admin', {
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
      // Sync-audit finding #6: forward Pi-side usage_log.kind so the
      // resulting food_logs row carries the same provenance discriminator.
      p_usage_kind: usageKind,
    }));
  }

  if (error) {
    // Always include client_event_id so operators can correlate a 500 with
    // the Pi's retry queue. Forward the SQLSTATE code so callers can
    // distinguish '23503' (unknown product) from '22023' (bad weight) from
    // generic RPC failures.
    console.error('shelf-ingest: apply_shelf_event failed', {
      client_event_id: clientEventId,
      code: (error as any).code ?? null,
      message: (error as any).message ?? null,
    });
    return jsonResponse({ error: 'apply_shelf_event failed', code: (error as any).code ?? 'RPC_ERROR' }, 500);
  }

  // RPC returns the composite row as an object (or an array with one row
  // depending on the client version).
  const row = Array.isArray(data) ? data[0] : data;
  const applied = Boolean(row?.applied);
  const resolvedLotId = row?.resolved_lot_id ?? null;
  const reason = row?.reason ?? null;

  // Change A: applied=false with an unexpected reason must NOT be forwarded
  // as a 200 success-shaped response (which the Pi worker would silently ack).
  // Known-safe reasons are 'duplicate' and 'stale: manual edit is newer' —
  // those are valid idempotent no-ops. Everything else is a data-contract
  // failure that must be surfaced as 4xx so the Pi dead-letters the row.
  const EXPECTED_NOT_APPLIED_REASONS = new Set(['duplicate', 'stale: manual edit is newer']);

  if (!applied && !EXPECTED_NOT_APPLIED_REASONS.has(reason ?? '')) {
    console.error('shelf-ingest: apply_shelf_event returned applied=false with unexpected reason', {
      client_event_id: clientEventId,
      applied,
      reason,
    });
    return jsonResponse(
      {
        error: 'apply_shelf_event rejected',
        code: 'APPLIED_FALSE_UNEXPECTED',
        reason,
      },
      422,
    );
  }

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
 * POST /scanner-state — UPSERT chefbyte.scanner_state with PATCH semantics.
 *
 * Browser-JWT route (NOT x-api-key — the Pi USB scanner forwarder only
 * READS scanner_state via direct Realtime subscription on its own
 * JWT-impersonated session; only the web ScannerPage WRITES). The
 * dispatcher must skip the global x-api-key auth gate for this leaf and
 * call this handler directly, mirroring livetrack-session/create.
 *
 * Body shape (any subset; absent fields are NOT touched, hence PATCH):
 *   {
 *     "last_active_mode": "purchase" | "consume_macros" | "consume_no_macros" | "shopping",
 *     "locked_mode":      ... | null,   // null clears the lock
 *   }
 *
 * Validation:
 *   - At least one of (last_active_mode, locked_mode) must be present;
 *     an empty body is a 400 to make client-side bugs loud.
 *   - last_active_mode is required to be a valid mode string when present
 *     (the column is NOT NULL with a 'purchase' default).
 *   - locked_mode accepts a valid mode OR null (clears the lock).
 *
 * Auth: extracts the `Authorization: Bearer <jwt>` header, calls
 * supabase.auth.getUser() with a JWT-scoped client to verify the token,
 * then writes via service-role (bypassing RLS) scoped on user_id =
 * resolved auth.uid(). Defense-in-depth: the row's PRIMARY KEY is
 * user_id and `onConflict: 'user_id'` ensures cross-user upserts can't
 * race in.
 */
async function handleScannerState(req: Request, supabase: SupabaseClient): Promise<Response> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Missing authorization header' }, 401);
  }
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: authError,
  } = await userClient.auth.getUser();
  if (authError || !user) {
    return jsonResponse({ error: 'Invalid token' }, 401);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ error: 'invalid body' }, 400);
  }

  const updates: { last_active_mode?: string; locked_mode?: string | null } = {};

  if (body.last_active_mode !== undefined) {
    if (typeof body.last_active_mode !== 'string' || !VALID_SCAN_MODES.has(body.last_active_mode)) {
      return jsonResponse({ error: 'invalid last_active_mode' }, 400);
    }
    updates.last_active_mode = body.last_active_mode;
  }
  if (body.locked_mode !== undefined) {
    if (body.locked_mode === null) {
      updates.locked_mode = null;
    } else if (typeof body.locked_mode !== 'string' || !VALID_SCAN_MODES.has(body.locked_mode)) {
      return jsonResponse({ error: 'invalid locked_mode' }, 400);
    } else {
      updates.locked_mode = body.locked_mode;
    }
  }

  if (Object.keys(updates).length === 0) {
    return jsonResponse({ error: 'no fields to update' }, 400);
  }

  // UPSERT with PATCH semantics: when the row does not yet exist, last_active_mode
  // falls back to the column's 'purchase' default if absent from the payload.
  const upsertPayload: Record<string, unknown> = {
    user_id: user.id,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .schema('chefbyte')
    .from('scanner_state')
    .upsert(upsertPayload, { onConflict: 'user_id' })
    .select('user_id, last_active_mode, locked_mode')
    .single();
  if (error || !data) {
    console.error('shelf-ingest: scanner_state upsert failed', error);
    return jsonResponse({ error: error?.message ?? 'upsert failed' }, 500);
  }
  return jsonResponse({ ok: true, ...data });
}

/**
 * POST /barcode-scan — apply one USB-scanner / web-scanner barcode.
 *
 * Dual-auth route: accepts BOTH x-api-key (Pi) AND JWT (web). The
 * x-api-key header is tried first; if absent or invalid we fall back
 * to the Authorization: Bearer JWT path. ``source`` on the resulting
 * scan_transactions row is ``pi_usb`` when x-api-key auth succeeded,
 * else ``web``.
 *
 * Body shape:
 *   {
 *     "barcode":             string                     // required
 *     "pi_event_id":         string?                    // optional dedup key (Pi)
 *     "mode":                string?                    // valid mode override
 *     "qty":                 number?                    // defaults to 1
 *     "unit":                "container" | "serving"?   // mode-specific default
 *     "nutrition_snapshot":  object?                    // future-proofing
 *   }
 *
 * Mode resolution priority:
 *   1. ``scanner_state.locked_mode`` if set — ALWAYS wins (cloud-side
 *      trust boundary; even an explicit body.mode can't override a
 *      lock).
 *   2. ``body.mode`` when present + valid.
 *   3. ``scanner_state.last_active_mode`` if set.
 *   4. Default ``'purchase'``.
 *
 * Idempotency: the partial unique index
 *   chefbyte.scan_transactions_pi_event_id_unique
 *   ON (user_id, pi_event_id) WHERE pi_event_id IS NOT NULL
 * de-duplicates by ``(user_id, pi_event_id)`` — a duplicate POST returns
 * the prior transaction unchanged.
 *
 * On unknown barcode, the handler invokes the ``analyze-product`` edge
 * function and re-queries products. If the lookup still fails (or
 * analyze-product is unreachable in the test environment), an
 * ``errored`` transaction is logged and returned with status=200 so
 * the Pi's fire-and-forget caller doesn't retry.
 */
async function handleBarcodeScan(req: Request, supabase: SupabaseClient): Promise<Response> {
  // ─── Auth: try x-api-key (Pi) first, then JWT (web) ─────────────
  let userId: string | null = null;
  let deviceId: string | null = null;
  const apiKey = req.headers.get('x-api-key');
  if (apiKey) {
    const authRes = await authenticate(supabase, apiKey);
    if (authRes.ok) {
      userId = authRes.device.user_id;
      deviceId = authRes.device.device_id;
    }
  }
  if (!userId) {
    const authHeader = req.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: authHeader } },
      });
      const {
        data: { user },
        error: authError,
      } = await userClient.auth.getUser();
      if (!authError && user) {
        userId = user.id;
      }
    }
  }
  if (!userId) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const source: 'pi_usb' | 'web' = deviceId ? 'pi_usb' : 'web';

  // ─── Body parsing ───────────────────────────────────────────────
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ error: 'invalid body' }, 400);
  }

  const barcode = typeof body.barcode === 'string' ? body.barcode.trim() : '';
  if (!barcode) {
    return jsonResponse({ error: 'barcode required' }, 400);
  }

  const piEventId: string | null =
    typeof body.pi_event_id === 'string' && body.pi_event_id.length > 0 ? body.pi_event_id : null;

  // ─── Idempotency check ──────────────────────────────────────────
  // The unique index on (user_id, pi_event_id) WHERE pi_event_id IS NOT
  // NULL guarantees a successful prior insert is observable here.
  if (piEventId) {
    const existing = await supabase
      .schema('chefbyte')
      .from('scan_transactions')
      .select(
        'transaction_id, status, mode, product_id, applied_lot_id, applied_food_log_id, applied_cart_item_id, error_msg',
      )
      .eq('user_id', userId)
      .eq('pi_event_id', piEventId)
      .maybeSingle();
    if (existing.data) {
      return jsonResponse({
        transaction_id: existing.data.transaction_id,
        status: existing.data.status,
        mode: existing.data.mode,
        product_id: existing.data.product_id,
        applied_lot_id: existing.data.applied_lot_id,
        applied_food_log_id: existing.data.applied_food_log_id,
        applied_cart_item_id: existing.data.applied_cart_item_id,
        error_msg: existing.data.error_msg,
        idempotent: true,
      });
    }
  }

  // ─── Mode resolution ────────────────────────────────────────────
  // Locked mode ALWAYS wins (cloud-side trust boundary — a misbehaving
  // client can't bypass a user-applied lock by sending body.mode).
  const stateQ = await supabase
    .schema('chefbyte')
    .from('scanner_state')
    .select('last_active_mode, locked_mode')
    .eq('user_id', userId)
    .maybeSingle();
  let mode: string;
  if (stateQ.data?.locked_mode) {
    mode = stateQ.data.locked_mode;
  } else if (typeof body.mode === 'string' && VALID_SCAN_MODES.has(body.mode)) {
    mode = body.mode;
  } else if (stateQ.data?.last_active_mode) {
    mode = stateQ.data.last_active_mode;
  } else {
    mode = 'purchase';
  }

  // ─── Product lookup ─────────────────────────────────────────────
  const productQ = await supabase
    .schema('chefbyte')
    .from('products')
    .select('product_id')
    .eq('user_id', userId)
    .eq('barcode', barcode)
    .is('deleted_at', null)
    .maybeSingle();
  let productId: string | null = productQ.data?.product_id ?? null;

  // Unknown barcode → invoke analyze-product. analyze-product requires
  // a user JWT (verify_jwt=true), so the service-role-scoped invoke
  // call may fail in environments without a forwarded JWT (test +
  // Pi-only paths). On any error we fall through to the errored-
  // transaction log so the Pi sees a stable response shape.
  if (!productId) {
    let analyzeError: string | null = null;
    try {
      const analyzeRes = await supabase.functions.invoke('analyze-product', {
        body: { barcode },
      });
      if (analyzeRes.error) {
        const msg = (analyzeRes.error as { message?: string }).message ?? 'unknown error';
        analyzeError = `analyze-product: ${msg}`;
      } else {
        const re = await supabase
          .schema('chefbyte')
          .from('products')
          .select('product_id')
          .eq('user_id', userId)
          .eq('barcode', barcode)
          .is('deleted_at', null)
          .maybeSingle();
        productId = re.data?.product_id ?? null;
      }
    } catch (e) {
      analyzeError = `analyze-product: ${(e as Error).message ?? String(e)}`;
    }

    if (!productId) {
      const errored = await insertErroredScanTransaction(supabase, {
        userId,
        barcode,
        mode,
        source,
        piEventId,
        productId: null,
        qty: typeof body.qty === 'number' ? body.qty : null,
        unit: typeof body.unit === 'string' ? body.unit : null,
        errorMsg: analyzeError ?? 'product not found and analyze-product silent',
      });
      return jsonResponse(errored);
    }
  }

  // ─── Execute action via private.execute_scan_action ─────────────
  const defaultUnit = mode === 'consume_macros' || mode === 'consume_no_macros' ? 'serving' : 'container';
  const qty = typeof body.qty === 'number' ? body.qty : 1;
  const unit = typeof body.unit === 'string' ? body.unit : defaultUnit;
  const nutritionSnapshot =
    body.nutrition_snapshot && typeof body.nutrition_snapshot === 'object' ? body.nutrition_snapshot : null;

  // private.execute_scan_action via the chefbyte-schema PostgREST wrapper
  // (migration 20260503100150). PostgREST only exposes the schemas listed
  // in supabase/config.toml (public, graphql_public, hub, coachbyte,
  // chefbyte) — the wrapper is a thin SECURITY DEFINER pass-through that
  // delegates to private.execute_scan_action.
  const actionQ = await (supabase as any).schema('chefbyte').rpc('execute_scan_action', {
    p_user_id: userId,
    p_product_id: productId,
    p_mode: mode,
    p_qty: qty,
    p_unit: unit,
    p_nutrition_snapshot: nutritionSnapshot,
  });

  if (actionQ.error) {
    const errored = await insertErroredScanTransaction(supabase, {
      userId,
      barcode,
      mode,
      source,
      piEventId,
      productId,
      qty,
      unit,
      errorMsg: actionQ.error.message ?? 'execute_scan_action failed',
    });
    return jsonResponse(errored);
  }

  const result = (actionQ.data ?? {}) as {
    applied_lot_id?: string | null;
    applied_food_log_id?: string | null;
    applied_cart_item_id?: string | null;
  };

  // ─── Insert applied transaction ─────────────────────────────────
  const nowIso = new Date().toISOString();
  const logicalDate = nowIso.slice(0, 10);
  const tx = await supabase
    .schema('chefbyte')
    .from('scan_transactions')
    .insert({
      user_id: userId,
      barcode,
      product_id: productId,
      mode,
      qty,
      unit,
      nutrition_snapshot: nutritionSnapshot,
      status: 'applied',
      logical_date: logicalDate,
      source,
      pi_event_id: piEventId,
      applied_lot_id: result.applied_lot_id ?? null,
      applied_food_log_id: result.applied_food_log_id ?? null,
      applied_cart_item_id: result.applied_cart_item_id ?? null,
      applied_at: nowIso,
    })
    .select('transaction_id')
    .single();

  if (tx.error || !tx.data) {
    console.error('shelf-ingest: scan_transactions insert failed', tx.error);
    return jsonResponse({ error: tx.error?.message ?? 'transaction insert failed' }, 500);
  }

  return jsonResponse({
    transaction_id: tx.data.transaction_id,
    status: 'applied',
    product_id: productId,
    mode,
    applied_lot_id: result.applied_lot_id ?? null,
    applied_food_log_id: result.applied_food_log_id ?? null,
    applied_cart_item_id: result.applied_cart_item_id ?? null,
  });
}

/**
 * Helper: insert a scan_transactions row with status='errored' and
 * return the response shape callers expect. Used by both the unknown-
 * product path and the execute_scan_action failure path.
 */
async function insertErroredScanTransaction(
  supabase: SupabaseClient,
  params: {
    userId: string;
    barcode: string;
    mode: string;
    source: 'pi_usb' | 'web';
    piEventId: string | null;
    productId: string | null;
    qty: number | null;
    unit: string | null;
    errorMsg: string;
  },
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase
    .schema('chefbyte')
    .from('scan_transactions')
    .insert({
      user_id: params.userId,
      barcode: params.barcode,
      product_id: params.productId,
      mode: params.mode,
      qty: params.qty,
      unit: params.unit,
      status: 'errored',
      error_msg: params.errorMsg,
      logical_date: new Date().toISOString().slice(0, 10),
      source: params.source,
      pi_event_id: params.piEventId,
    })
    .select('transaction_id')
    .single();
  if (error || !data) {
    console.error('shelf-ingest: errored scan_transactions insert failed', error);
    // Best-effort: still return a response so the Pi doesn't retry on
    // cascade failure. transaction_id null signals upstream insert
    // failure to the client.
    return {
      transaction_id: null,
      status: 'errored',
      error_msg: params.errorMsg,
      mode: params.mode,
      product_id: params.productId,
    };
  }
  return {
    transaction_id: data.transaction_id,
    status: 'errored',
    error_msg: params.errorMsg,
    mode: params.mode,
    product_id: params.productId,
  };
}

/**
 * Apply Pi-captured tare-weight and/or measured_full_at to a products row.
 *
 * Called by the Pi after:
 *   1. The catch-all scale tare-capture interceptor fires
 *      (CATCH_ALL_TARE_CAPTURE_PLAN.md §4.2 cloud resolution) — pushes
 *      `tare_weight_g`.
 *   2. The catch-all auto-import dispatch (Task 9 of catch-all-livetrack
 *      auto-import plan) — pushes `measured_full_at` when scale ≈
 *      tare + net_weight_g, optionally alongside tare on first capture.
 *
 * Set-once enforcement: each field is only written when its column is
 * currently NULL on the row. Defense-in-depth — the Pi already guards
 * before dispatch, but transient retries (Pi → cloud) could otherwise
 * overwrite a user-corrected value. RLS via .eq('user_id', userId).
 *
 * The product row must already exist + belong to the authenticated
 * device's user. Missing / cross-user rows return 404 so the Pi's
 * fire-and-forget caller logs once and moves on.
 */
async function handleProductTare(supabase: SupabaseClient, device: Device, body: any): Promise<Response> {
  const productId: string | undefined = body?.product_id;
  if (typeof productId !== 'string' || productId.length === 0) {
    return jsonResponse({ error: 'product_id required' }, 400);
  }

  // Normalise inputs — both fields are optional but at least one must
  // be supplied or this call is a no-op (surface as 400 to make Pi-side
  // bugs loud).
  const updates: { tare_weight_g?: number; measured_full_at?: string } = {};

  if (body?.tare_weight_g !== undefined && body?.tare_weight_g !== null) {
    const tare = typeof body.tare_weight_g === 'number' ? body.tare_weight_g : Number(body.tare_weight_g);
    if (!Number.isFinite(tare) || tare < 0) {
      return jsonResponse({ error: 'tare_weight_g must be a non-negative number' }, 400);
    }
    updates.tare_weight_g = tare;
  }

  if (body?.measured_full_at !== undefined && body?.measured_full_at !== null) {
    if (typeof body.measured_full_at !== 'string' || Number.isNaN(Date.parse(body.measured_full_at))) {
      return jsonResponse({ error: 'measured_full_at must be an ISO 8601 timestamp' }, 400);
    }
    updates.measured_full_at = body.measured_full_at;
  }

  if (Object.keys(updates).length === 0) {
    return jsonResponse({ error: 'tare_weight_g or measured_full_at is required' }, 400);
  }

  const userId = device.user_id;

  // Set-once: read current values; only write fields whose column is
  // NULL. Preserves the user's "no overwrite after set" rule even if
  // the Pi re-pushes (idempotent retries are common in fire-and-forget
  // callers).
  const { data: existing, error: existingErr } = await supabase
    .schema('chefbyte')
    .from('products')
    .select('tare_weight_g, measured_full_at')
    .eq('product_id', productId)
    .eq('user_id', userId)
    .maybeSingle();
  if (existingErr) throw existingErr;
  if (!existing) {
    return jsonResponse({ error: 'product not found' }, 404);
  }

  const filtered: typeof updates = {};
  if (updates.tare_weight_g !== undefined && existing.tare_weight_g === null) {
    filtered.tare_weight_g = updates.tare_weight_g;
  }
  if (updates.measured_full_at !== undefined && existing.measured_full_at === null) {
    filtered.measured_full_at = updates.measured_full_at;
  }

  // All requested fields already set — no-op success so Pi retries
  // don't surface as errors. Echo back the existing row state.
  if (Object.keys(filtered).length === 0) {
    return jsonResponse({
      ok: true,
      product_id: productId,
      tare_weight_g: existing.tare_weight_g,
      measured_full_at: existing.measured_full_at,
      skipped: 'all requested fields already set (set-once)',
    });
  }

  const { data: updated, error: updErr } = await supabase
    .schema('chefbyte')
    .from('products')
    .update(filtered)
    .eq('product_id', productId)
    .eq('user_id', userId)
    .select('product_id, tare_weight_g, measured_full_at')
    .maybeSingle();
  if (updErr) throw updErr;
  if (!updated) {
    return jsonResponse({ error: 'product not found' }, 404);
  }
  return jsonResponse({
    ok: true,
    product_id: updated.product_id,
    tare_weight_g: updated.tare_weight_g,
    measured_full_at: updated.measured_full_at,
  });
}

// ─── Review queue handlers (sync-audit finding #5) ──────────────────

const VALID_REVIEW_KINDS = [
  'unknown_item_add',
  'low_confidence',
  'weight_mismatch',
  'unpaired_remove',
  'multi_match',
  'failed_intake',
  'sensor_anomaly',
] as const;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_REGEX.test(s);
}

/**
 * POST /review-create — UPSERT a review_queue row from the Pi.
 *
 * Called by the Pi's cloud_outbox worker for every ``review_queue_create``
 * outbox event (one per Pi-side review row insert). Idempotent on
 * (user_id, pi_review_id) — replays from the worker after an ambiguous
 * timeout don't double-insert.
 *
 * Required body:
 *   {
 *     "pi_review_id": "<uuid>",
 *     "kind": "low_confidence" | ...,
 *     "client_event_id": "<uuid>",       // outbox dedup key (mirrored in shelf_event_log? no — review_queue uses its own dedup via pi_review_id)
 *   }
 *
 * Optional:
 *   {
 *     "pi_session_id": "<uuid>",
 *     "pi_event_id": "<uuid>",
 *     "proposed": { ... },                // classifier blob — JSON object
 *     "images": ["events/<id>/before.jpg", ...],
 *     "created_at": "<iso8601>"           // Pi's row creation ts; falls back to now()
 *   }
 */
async function handleReviewCreate(supabase: SupabaseClient, device: Device, body: any): Promise<Response> {
  const piReviewId: string | undefined = body?.pi_review_id;
  const kind: string | undefined = body?.kind;
  const clientEventId: string | undefined = body?.client_event_id;

  if (!isUuid(piReviewId)) {
    return jsonResponse({ error: 'pi_review_id must be a UUID' }, 400);
  }
  if (!kind || !VALID_REVIEW_KINDS.includes(kind as (typeof VALID_REVIEW_KINDS)[number])) {
    return jsonResponse({ error: 'invalid kind' }, 400);
  }
  if (!clientEventId || typeof clientEventId !== 'string' || clientEventId.length > MAX_CLIENT_EVENT_ID_LEN) {
    return jsonResponse({ error: 'client_event_id required' }, 400);
  }

  const piSessionId: string | null = isUuid(body?.pi_session_id) ? body.pi_session_id : null;
  const piEventId: string | null = isUuid(body?.pi_event_id) ? body.pi_event_id : null;
  const proposed = body?.proposed ?? null;
  const images = Array.isArray(body?.images) ? body.images : null;
  const createdAtRaw: string | undefined = body?.created_at;
  const createdAt = createdAtRaw && isValidIsoTimestamp(createdAtRaw) ? createdAtRaw : null;
  // Cloud image URLs (mixed-content fix) — populated by Pi after Storage upload.
  const beforeImageUrl: string | null =
    typeof body?.before_image_url === 'string' && body.before_image_url ? body.before_image_url : null;
  const afterImageUrl: string | null =
    typeof body?.after_image_url === 'string' && body.after_image_url ? body.after_image_url : null;

  console.log('shelf-ingest: review-create', {
    client_event_id: clientEventId,
    device_id: device.device_id,
    pi_review_id: piReviewId,
    kind,
    has_cloud_images: !!(beforeImageUrl || afterImageUrl),
  });

  const { data, error } = await (supabase as any).schema('chefbyte').rpc('upsert_review_queue_from_pi_admin', {
    p_user_id: device.user_id,
    p_pi_review_id: piReviewId,
    p_kind: kind,
    p_pi_session_id: piSessionId,
    p_pi_event_id: piEventId,
    p_proposed: proposed,
    p_images: images,
    p_created_at: createdAt,
    p_before_image_url: beforeImageUrl,
    p_after_image_url: afterImageUrl,
  });

  if (error) {
    console.error('shelf-ingest: review_queue_create failed', {
      client_event_id: clientEventId,
      code: (error as any).code ?? null,
      message: (error as any).message ?? null,
    });
    return jsonResponse({ error: 'review_queue_create failed' }, 500);
  }

  const row = Array.isArray(data) ? data[0] : data;
  return jsonResponse({
    ok: true,
    review_id: row?.review_id ?? null,
    status: row?.status ?? null,
  });
}

/**
 * POST /review-resolve — Pi-side push-back when the operator resolved a review
 * on the Pi /inventory UI. Cloud mirrors status + user_response.
 *
 * Required body:
 *   {
 *     "pi_review_id": "<uuid>",
 *     "status": "resolved" | "dismissed",
 *     "client_event_id": "<uuid>"      // outbox dedup
 *   }
 *
 * Optional: ``user_response`` (JSON), ``resolved_at`` (iso8601).
 */
async function handleReviewResolve(supabase: SupabaseClient, device: Device, body: any): Promise<Response> {
  const piReviewId: string | undefined = body?.pi_review_id;
  const status: string | undefined = body?.status;
  const clientEventId: string | undefined = body?.client_event_id;

  if (!isUuid(piReviewId)) {
    return jsonResponse({ error: 'pi_review_id must be a UUID' }, 400);
  }
  if (status !== 'resolved' && status !== 'dismissed') {
    return jsonResponse({ error: 'status must be resolved or dismissed' }, 400);
  }
  if (!clientEventId || typeof clientEventId !== 'string' || clientEventId.length > MAX_CLIENT_EVENT_ID_LEN) {
    return jsonResponse({ error: 'client_event_id required' }, 400);
  }

  const userResponse = body?.user_response ?? null;

  // Look up the cloud row by (user_id, pi_review_id) so we can hand
  // chefbyte.resolve_review the cloud's review_id (its primary key). We
  // scope on user_id so a malicious Pi can't resolve someone else's row.
  const { data: row, error: lookupErr } = await supabase
    .schema('chefbyte')
    .from('review_queue')
    .select('review_id, status')
    .eq('user_id', device.user_id)
    .eq('pi_review_id', piReviewId)
    .maybeSingle();

  if (lookupErr) {
    console.error('shelf-ingest: review-resolve lookup failed', {
      client_event_id: clientEventId,
      code: (lookupErr as any).code ?? null,
    });
    return jsonResponse({ error: 'review lookup failed' }, 500);
  }

  if (!row) {
    // Pi resolved a review the cloud never received (ordering: outbox
    // worker may not have drained the create yet). Surface a 409 so the
    // Pi can retry after the create lands.
    return jsonResponse({ error: 'review not found in cloud yet' }, 409);
  }

  // Idempotent: if already resolved/dismissed at the cloud, return ok.
  if (row.status === 'resolved' || row.status === 'dismissed') {
    return jsonResponse({ ok: true, review_id: row.review_id, status: row.status, idempotent: true });
  }

  const { data: resolved, error: resolveErr } = await (supabase as any).schema('chefbyte').rpc('resolve_review', {
    p_review_id: row.review_id,
    p_status: status,
    p_user_response: userResponse,
  });

  if (resolveErr) {
    console.error('shelf-ingest: review-resolve failed', {
      client_event_id: clientEventId,
      code: (resolveErr as any).code ?? null,
      message: (resolveErr as any).message ?? null,
    });
    return jsonResponse({ error: 'review resolve failed' }, 500);
  }

  const out = Array.isArray(resolved) ? resolved[0] : resolved;
  return jsonResponse({
    ok: true,
    review_id: out?.review_id ?? row.review_id,
    status: out?.status ?? status,
  });
}

/**
 * GET /review-resolved-since?updated_since=<iso>
 *
 * Pi poller endpoint that returns cloud-side resolutions newer than the
 * watermark so the Pi can mirror cloud UI resolutions back into its
 * local review_queue. Bidirectional mirror — the Pi /inventory UI will
 * see status='resolved' immediately after the user clicks Accept on the
 * cloud /chef/reviews page.
 *
 * Response shape:
 *   {
 *     "reviews": [
 *       { "pi_review_id", "status", "resolved_at", "user_response" }, ...
 *     ]
 *   }
 *
 * Watermark is the cloud's resolved_at; out-of-order arrivals are fine
 * because the Pi's apply path is idempotent on the same row.
 */
async function handleReviewResolvedSince(supabase: SupabaseClient, device: Device, url: URL): Promise<Response> {
  const updatedSinceRaw = url.searchParams.get('updated_since');
  const updatedSince = updatedSinceRaw && isValidIsoTimestamp(updatedSinceRaw) ? updatedSinceRaw : null;

  let q = supabase
    .schema('chefbyte')
    .from('review_queue')
    .select('pi_review_id, status, resolved_at, user_response')
    .eq('user_id', device.user_id)
    .in('status', ['resolved', 'dismissed'])
    .order('resolved_at', { ascending: true });
  if (updatedSince) {
    q = q.gt('resolved_at', updatedSince);
  }

  const { data, error } = await q;
  if (error) throw error;

  return jsonResponse({ reviews: data ?? [] });
}

// Per-lot snapshot from the Pi heartbeat. Powers the
// pi_cloud_lot_id_match invariant in invariant-monitor — every cloud
// stock_lots row touched by a live_shelf/live_scale source must have a
// matching Pi snapshot row with consistent state. See migration
// 20260429170000_pi_lot_snapshots.sql for the table contract.
const MAX_LOTS_PER_HEARTBEAT = 256;
const MAX_PI_LOT_ID_LEN = 64;

function sanitizeHeartbeatLots(rawLots: unknown): { ok: true; lots: any[] } | { ok: false; error: string } {
  if (!Array.isArray(rawLots)) {
    // Backward-compatible: older Pi heartbeats omit `lots` entirely.
    // Treat missing array as "no snapshot delta this tick".
    return { ok: true, lots: [] };
  }
  if (rawLots.length > MAX_LOTS_PER_HEARTBEAT) {
    return { ok: false, error: 'too many lots in heartbeat' };
  }
  const out: any[] = [];
  for (const raw of rawLots) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'invalid lots entry' };
    }
    const r: any = raw;
    const piLotId = r.pi_lot_id;
    if (typeof piLotId !== 'string' || piLotId.length === 0 || piLotId.length > MAX_PI_LOT_ID_LEN) {
      return { ok: false, error: 'invalid pi_lot_id' };
    }
    out.push({
      pi_lot_id: piLotId,
      cloud_lot_id: typeof r.cloud_lot_id === 'string' ? r.cloud_lot_id : null,
      qty_containers: typeof r.qty_containers === 'number' ? r.qty_containers : null,
      status: typeof r.status === 'string' ? r.status : null,
      last_update_source: typeof r.last_update_source === 'string' ? r.last_update_source : null,
      in_flight_since: typeof r.in_flight_since === 'string' ? r.in_flight_since : null,
      in_flight_kind: typeof r.in_flight_kind === 'string' ? r.in_flight_kind : null,
      current_weight_g: typeof r.current_weight_g === 'number' ? r.current_weight_g : null,
      scale_id_paired_to: typeof r.scale_id_paired_to === 'string' ? r.scale_id_paired_to : null,
    });
  }
  return { ok: true, lots: out };
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

  // Per-lot snapshots. Older Pi clients omit ``lots`` entirely, so a
  // missing array isn't an error — older snapshots simply persist
  // until a newer-shape heartbeat replaces them or the row is GC'd.
  const lotsValidation = sanitizeHeartbeatLots(body?.lots);
  if (!lotsValidation.ok) {
    return jsonResponse({ error: lotsValidation.error }, 400);
  }
  const sanitizedLots = lotsValidation.lots;

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

  // Per-lot snapshot UPSERT. Same admin-only RPC pattern as the
  // pairings upsert above. Powers the pi_cloud_lot_id_match invariant.
  if (sanitizedLots.length > 0) {
    const { error: lotErr } = await (supabase as any).schema('chefbyte').rpc('upsert_pi_lot_snapshots_admin', {
      p_device_id: device.device_id,
      p_user_id: userId,
      p_lots: sanitizedLots,
    });
    if (lotErr) {
      console.error('shelf-ingest: upsert_pi_lot_snapshots_admin failed', {
        device_id: device.device_id,
        code: (lotErr as any).code ?? null,
        message: (lotErr as any).message ?? null,
      });
      // Don't fail the whole heartbeat over a snapshot upsert error —
      // pairings/heartbeat already landed and the next tick can retry.
      // Worst case: the cloud invariant flags drift, which is exactly
      // what pi_cloud_drift is for.
    }
  }

  return jsonResponse({ ok: true });
}

/**
 * POST /scan-transaction/:transaction_id/void — reverse an applied scan.
 *
 * Browser-JWT route (no x-api-key path). The Settings → Scanner
 * Transactions tab calls this when the user taps "Void" on an audit
 * row. Per-mode reversal is delegated to private.void_scan_transaction
 * (purchase deletes the stock_lot, consume_macros deletes the food_log,
 * shopping deletes the cart row, consume_no_macros only flips status).
 *
 * Auth + ownership:
 *   1. Resolve user from `Authorization: Bearer <jwt>`.
 *   2. SELECT chefbyte.scan_transactions WHERE transaction_id = :id
 *      AND user_id = auth.uid(). Missing → 404 (don't leak existence
 *      across users).
 *   3. RPC chefbyte.void_scan_transaction (PostgREST wrapper, since
 *      private isn't on the API surface). Wrapper does NOT enforce
 *      ownership — that's why step 2 is mandatory.
 *
 * Idempotency: private.void_scan_transaction is idempotent on
 * already-voided rows (no-op return). Calling void twice → 200 both
 * times; UI debounce isn't required.
 *
 * Response: { ok: true, transaction_id: <uuid> }.
 */
async function handleVoidScanTransaction(
  req: Request,
  supabase: SupabaseClient,
  transactionId: string,
): Promise<Response> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: authError,
  } = await userClient.auth.getUser();
  if (authError || !user) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  // Ownership gate: the wrapper RPC is service-role-impersonated and
  // does not check user_id. We MUST verify the caller owns the row
  // before invoking, or any authenticated user could void any row.
  // 404 (not 403) on cross-user attempts so existence isn't leaked.
  const { data: own, error: ownErr } = await supabase
    .schema('chefbyte')
    .from('scan_transactions')
    .select('transaction_id')
    .eq('user_id', user.id)
    .eq('transaction_id', transactionId)
    .maybeSingle();
  if (ownErr) {
    console.error('shelf-ingest: void ownership check failed', ownErr);
    return jsonResponse({ error: ownErr.message }, 500);
  }
  if (!own) {
    return jsonResponse({ error: 'not found' }, 404);
  }

  const { error: rpcErr } = await supabase
    .schema('chefbyte')
    .rpc('void_scan_transaction', { p_transaction_id: transactionId });
  if (rpcErr) {
    console.error('shelf-ingest: void_scan_transaction rpc failed', rpcErr);
    return jsonResponse({ error: rpcErr.message }, 500);
  }
  return jsonResponse({ ok: true, transaction_id: transactionId });
}

// ─── Entrypoint ──────────────────────────────────────────────────────

// Path-param route matcher for /scan-transaction/<uuid>/void. UUID
// regex matches RFC 4122 form (36 chars, hex + dashes); the dispatcher
// uses this BEFORE the leaf-based switch because the URL has trailing
// segments after the transaction id and `leaf` only sees `void`.
//
// Supabase routes the function at /functions/v1/shelf-ingest/<subpath>,
// so cleanedPath is the FULL pathname (e.g.
// `/functions/v1/shelf-ingest/scan-transaction/<uuid>/void`). The regex
// matches the trailing tail; an unanchored `\/scan-transaction` allows
// the prefix to vary across hosting environments while still pinning
// the UUID + `/void` suffix.
const VOID_SCAN_TX_RE = /\/scan-transaction\/([0-9a-f-]{36})\/void$/i;

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

    // Browser-JWT routes — must be dispatched BEFORE the global x-api-key
    // auth gate below (they authenticate via Authorization: Bearer <jwt>
    // inside the handler, mirroring livetrack-session/create).
    if (req.method === 'POST' && leaf === 'scanner-state') {
      return await handleScannerState(req, supabase);
    }

    // Path-param route: /scan-transaction/<uuid>/void. Browser-JWT only.
    // Matched against cleanedPath because the leaf switch sees only the
    // last segment (`void`), which would also match unrelated URLs.
    // Must be evaluated BEFORE the x-api-key gate; the handler 401s on
    // missing JWT.
    if (req.method === 'POST') {
      const voidMatch = cleanedPath.match(VOID_SCAN_TX_RE);
      if (voidMatch) {
        return await handleVoidScanTransaction(req, supabase, voidMatch[1]);
      }
    }

    // Dual-auth route — accepts BOTH x-api-key (Pi) AND JWT (web). Must
    // be dispatched before the global x-api-key gate so a JWT-only web
    // call isn't 401'd on the missing api key. The handler resolves
    // auth itself (x-api-key tried first → JWT fallback) and 401s if
    // neither succeeds.
    if (req.method === 'POST' && leaf === 'barcode-scan') {
      return await handleBarcodeScan(req, supabase);
    }

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

    if (req.method === 'GET' && leaf === 'settings') {
      return await handleSettings(supabase, device);
    }

    if (req.method === 'GET' && leaf === 'events-by-pi-id') {
      return await handleEventsByPiId(supabase, device, url);
    }

    if (req.method === 'GET' && leaf === 'review-resolved-since') {
      return await handleReviewResolvedSince(supabase, device, url);
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));

      if (leaf === 'event') return await handleEvent(supabase, device, body);
      if (leaf === 'intake') return await handleIntake(supabase, device, body);
      if (leaf === 'heartbeat') return await handleHeartbeat(supabase, device, body);
      if (leaf === 'product-tare') return await handleProductTare(supabase, device, body);
      if (leaf === 'review-create') return await handleReviewCreate(supabase, device, body);
      if (leaf === 'review-resolve') return await handleReviewResolve(supabase, device, body);
    }

    return jsonResponse({ error: 'not found' }, 404);
  } catch (error: any) {
    // Log full error server-side for debugging; return only a generic
    // message to the client so stack traces + DB internals never leak.
    console.error('shelf-ingest error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});
