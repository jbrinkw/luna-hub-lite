import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

/**
 * livetrack-session — edge function for the LiveTrack Import Wizard.
 *
 * Path-based routing from one deployment (Supabase edge functions mount at
 * a single URL). `verify_jwt = false` in config.toml to match the other
 * functions in this repo that do manual auth (ES256 relay-verify issue
 * in CLI 2.75 — see config.toml L375–378 comment).
 *
 * Routes:
 *   POST /livetrack-session/create     — browser; user JWT; creates a fresh
 *                                        session for the user's most
 *                                        recently-heartbeated device.
 *   POST /livetrack-session/pi-update  — Pi; x-api-key; writes scale
 *                                        readings + AI-tare results back.
 *   GET  /livetrack-session/active     — Pi; x-api-key; returns the active
 *                                        session row for the calling device
 *                                        (or `{ session: null }`).
 */

// ─── CORS ────────────────────────────────────────────────────────────
// Browser routes use supabase-js which sends x-client-info + apikey in
// addition to authorization + content-type. Pi routes use x-api-key. List
// them all so preflights succeed for any legitimate caller.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-api-key',
};

// How stale a device's heartbeat may be before /create refuses to arm it.
// Aligned with the UI's "Pi offline" threshold so both sides agree.
const DEVICE_FRESH_WINDOW_MS = 60_000;

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** SHA-256 hex digest via Web Crypto (Deno runtime). */
async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Auth helpers ────────────────────────────────────────────────────

type Device = { device_id: string; user_id: string };

/**
 * Resolve an x-api-key header to the owning device.
 *
 * Mirrors shelf-ingest: SHA-256 the key, look up live_shelf_devices by
 * import_key_hash, reject inactive or missing devices with 401. Returns the
 * device on success; null on any failure (caller responds 401 — leak no
 * detail to the client).
 */
async function authenticatePi(supabase: SupabaseClient, apiKey: string | null): Promise<Device | null> {
  if (!apiKey) return null;
  const hash = await sha256(apiKey);
  const { data, error } = await supabase
    .schema('chefbyte')
    .from('live_shelf_devices')
    .select('device_id, user_id, is_active')
    .eq('import_key_hash', hash)
    .maybeSingle();
  if (error || !data || !data.is_active) return null;
  return { device_id: data.device_id, user_id: data.user_id };
}

// ─── Route: POST /create (browser, user JWT) ─────────────────────────

/**
 * Default scale_id when the caller doesn't supply one. Legacy clients
 * (pre-2026-04-27) target the catch-all by convention, since that was
 * the only scale the wizard ever calibrated. New callers MUST send an
 * explicit scale_id; the default keeps the legacy path working with a
 * warning for one release cycle.
 */
const DEFAULT_LEGACY_SCALE_ID = 'scale-02';

/**
 * Create a fresh session scoped to (device_id, scale_id). Returns 409 when
 * the picked device's heartbeat is stale — the UI uses this signal to
 * render the "Pi offline" branch.
 *
 * Body shape:
 *   {
 *     device_id?: uuid,    // optional; defaults to user's freshest device
 *     scale_id?: string,   // optional; defaults to scale-02 (legacy catch-all)
 *   }
 *
 * device_id verification: when supplied, the row is loaded + checked to
 * belong to the calling user (cross-user device ids → 404). When omitted
 * we pick the user's freshest active device (same as before this fix).
 *
 * Multi-tab + multi-scale ergonomics: any prior row with state NOT IN
 * ('closed','expired') for THIS (device_id, scale_id) pair is flipped to
 * 'expired' before the insert. Sessions for OTHER scales on the same
 * device are left alone — they're independent calibrations.
 */
async function handleCreate(supabase: SupabaseClient, req: Request): Promise<Response> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Missing authorization header' }, 401);
  }

  // JWT-scoped client so we can call supabase.auth.getUser(); switching to
  // service_role for the writes lets us expire prior rows regardless of
  // RLS scoping (defense in depth — RLS would also allow it).
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

  // Parse + validate body. Body is optional today (legacy clients send
  // `{}`); when present, validate the shape so a malformed device_id
  // doesn't slip past as null.
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) ?? {};
  } catch {
    body = {};
  }
  const requestedDeviceId = typeof body.device_id === 'string' && body.device_id.length > 0 ? body.device_id : null;
  const requestedScaleId = typeof body.scale_id === 'string' && body.scale_id.length > 0 ? body.scale_id : null;
  // Fallback to legacy scale_id when omitted. Logged so a stuck legacy
  // client is visible in operator logs but doesn't break.
  const scaleId = requestedScaleId ?? DEFAULT_LEGACY_SCALE_ID;
  if (!requestedScaleId) {
    console.warn('livetrack-session/create: scale_id not supplied; defaulting to legacy %s', DEFAULT_LEGACY_SCALE_ID);
  }

  // Service-role client for the subsequent writes (bypasses RLS).
  const supabaseSR = supabase;

  // Resolve the device. Two paths:
  //   1. Caller specified device_id → look it up + assert ownership.
  //   2. Caller didn't → pick the freshest active device for this user.
  // Either way the row is checked against the freshness window before we
  // arm a session — a wizard against a dead Pi makes no sense.
  const cutoff = new Date(Date.now() - DEVICE_FRESH_WINDOW_MS).toISOString();
  let device: { device_id: string; last_heartbeat_ts: string | null; is_active: boolean } | null = null;
  if (requestedDeviceId) {
    const { data: row, error: lookupErr } = await supabaseSR
      .schema('chefbyte')
      .from('live_shelf_devices')
      .select('device_id, last_heartbeat_ts, is_active, user_id')
      .eq('device_id', requestedDeviceId)
      .maybeSingle();
    if (lookupErr) {
      console.error('livetrack-session/create: device lookup failed', lookupErr);
      return jsonResponse({ error: 'device lookup failed' }, 500);
    }
    // 404 (not 403) on cross-user device_ids — leak no detail about whether
    // a row exists at all.
    if (!row || row.user_id !== user.id || !row.is_active) {
      return jsonResponse({ error: 'device not found' }, 404);
    }
    if (!row.last_heartbeat_ts || new Date(row.last_heartbeat_ts).getTime() < new Date(cutoff).getTime()) {
      return jsonResponse({ error: 'no fresh live shelf device (heartbeat stale or missing)' }, 409);
    }
    device = { device_id: row.device_id, last_heartbeat_ts: row.last_heartbeat_ts, is_active: row.is_active };
  } else {
    const { data: row, error: deviceError } = await supabaseSR
      .schema('chefbyte')
      .from('live_shelf_devices')
      .select('device_id, last_heartbeat_ts, is_active')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .gt('last_heartbeat_ts', cutoff)
      .order('last_heartbeat_ts', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (deviceError) {
      console.error('livetrack-session/create: device lookup failed', deviceError);
      return jsonResponse({ error: 'device lookup failed' }, 500);
    }
    if (!row) {
      return jsonResponse({ error: 'no fresh live shelf device (heartbeat stale or missing)' }, 409);
    }
    device = row;
  }

  // Expire any prior live sessions for THIS (device, scale) pair only.
  // Sessions targeting other scales on the same device are independent
  // calibrations and must not be touched. Idempotent.
  const { error: expireError } = await supabaseSR
    .schema('chefbyte')
    .from('livetrack_import_sessions')
    .update({ state: 'expired', updated_at: new Date().toISOString() })
    .eq('device_id', device.device_id)
    .eq('scale_id', scaleId)
    .not('state', 'in', '(closed,expired)');
  if (expireError) {
    console.error('livetrack-session/create: prior-session expire failed', expireError);
    // Continue — an orphan live row is recoverable (Pi will just see the
    // newest); failing here would block the UI from ever recovering.
  }

  // Insert fresh row. Defaults handle created_at / updated_at / expires_at.
  const { data: inserted, error: insertError } = await supabaseSR
    .schema('chefbyte')
    .from('livetrack_import_sessions')
    .insert({
      user_id: user.id,
      device_id: device.device_id,
      scale_id: scaleId,
      state: 'waiting_barcode',
    })
    .select('*')
    .single();

  if (insertError || !inserted) {
    console.error('livetrack-session/create: insert failed', insertError);
    return jsonResponse({ error: 'session insert failed' }, 500);
  }

  return jsonResponse({ session: inserted });
}

// ─── Route: POST /pi-update (Pi, x-api-key) ──────────────────────────

/**
 * Allowed-field UPDATE from the Pi. The Pi may only mutate result fields —
 * barcode + product_id come from the browser, not here. Any caller field
 * outside ALLOWED is silently ignored so a misbehaving Pi can't stomp user
 * state.
 */
const ALLOWED_PI_FIELDS = new Set([
  'scale_reading_g',
  'scale_reading_ts',
  'ai_tare_g',
  'ai_tare_confidence',
  'ai_tare_reasoning',
  'state',
  'last_error',
]);

async function handlePiUpdate(supabase: SupabaseClient, device: Device, body: any): Promise<Response> {
  const sessionId: string | undefined = typeof body?.session_id === 'string' ? body.session_id : undefined;
  if (!sessionId) {
    return jsonResponse({ error: 'session_id required' }, 400);
  }

  // Validate the session belongs to this device — defense in depth vs. a
  // cross-device key leak.
  const { data: existing, error: lookupError } = await supabase
    .schema('chefbyte')
    .from('livetrack_import_sessions')
    .select('session_id, device_id, user_id, state, expires_at')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (lookupError) {
    console.error('livetrack-session/pi-update: lookup failed', lookupError);
    return jsonResponse({ error: 'lookup failed' }, 500);
  }
  if (!existing) {
    return jsonResponse({ error: 'session not found' }, 404);
  }
  if (existing.device_id !== device.device_id) {
    // Same device-user invariant as shelf-ingest — 403 so the Pi's retry
    // worker marks as permanent.
    return jsonResponse({ error: 'session does not belong to this device' }, 403);
  }
  if (existing.state === 'closed' || existing.state === 'expired') {
    return jsonResponse({ error: `session is ${existing.state}` }, 410);
  }
  if (existing.expires_at && new Date(existing.expires_at).getTime() < Date.now()) {
    // Flip the row to expired so the browser sees it, then 410. Best-
    // effort: ignore any write error since the 410 is the authoritative
    // signal for the Pi.
    const { error: expireErr } = await supabase
      .schema('chefbyte')
      .from('livetrack_import_sessions')
      .update({ state: 'expired', updated_at: new Date().toISOString() })
      .eq('session_id', sessionId);
    if (expireErr) {
      // Logged for debugging only — the 410 below is the authoritative
      // signal and we don't want to mask it with a 500 if Postgres is
      // momentarily unhappy.
      console.warn('livetrack-session/pi-update: expire flip failed', expireErr);
    }
    return jsonResponse({ error: 'session expired' }, 410);
  }

  // Build a narrow UPDATE payload from the allow-list. Anything else is
  // silently discarded — don't echo back keys we ignored.
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of Object.keys(body)) {
    if (ALLOWED_PI_FIELDS.has(key)) {
      patch[key] = body[key];
    }
  }

  if (Object.keys(patch).length === 1) {
    // Only updated_at — nothing to do. Return the existing row so the Pi
    // has something to ack against.
    return jsonResponse({ session: existing });
  }

  const { data: updated, error: updateError } = await supabase
    .schema('chefbyte')
    .from('livetrack_import_sessions')
    .update(patch)
    .eq('session_id', sessionId)
    .select('*')
    .single();

  if (updateError || !updated) {
    console.error('livetrack-session/pi-update: update failed', updateError);
    return jsonResponse({ error: 'update failed' }, 500);
  }
  return jsonResponse({ session: updated });
}

// ─── Route: GET /active (Pi, x-api-key) ──────────────────────────────

/**
 * Pi poller's "what should I be doing?" query.
 *
 * Two modes:
 *   * ``?scale_id=<id>`` — return the single active session for THIS
 *     (device, scale) tuple. This is the targeted-suppression mode the
 *     Pi uses post-2026-04-27 to keep unrelated scales flowing events
 *     while one is being calibrated.
 *   * No query params — return ``{ sessions: [{device_id, scale_id, ...}] }``
 *     for every active session on the device. The Pi caches this set
 *     of tuples and matches incoming events against it.
 *
 * Both modes always return 200 with a parseable body (never 204) so the
 * Pi client doesn't have to branch on empty.
 *
 * Backwards compatibility: legacy Pi callers that don't know about the
 * scoping receive the multi-session shape and treat ANY non-empty list
 * as "wizard active for this user/device" — same behavior as before
 * the fix (over-suppression). New callers that pass scale_id get the
 * scoped behavior.
 */
async function handleActive(supabase: SupabaseClient, device: Device, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const scaleId = url.searchParams.get('scale_id');

  if (scaleId) {
    // Scoped lookup — single session for this (device, scale) pair.
    const { data, error } = await supabase
      .schema('chefbyte')
      .from('livetrack_import_sessions')
      .select('*')
      .eq('device_id', device.device_id)
      .eq('scale_id', scaleId)
      .not('state', 'in', '(closed,expired)')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('livetrack-session/active: scoped lookup failed', error);
      return jsonResponse({ error: 'lookup failed' }, 500);
    }
    return jsonResponse({ session: data ?? null });
  }

  // Unscoped — list every active session on this device. Pi caches the
  // (device_id, scale_id) tuples and gates events per-tuple. Also keeps
  // the legacy ``session`` field (newest row) so old Pi binaries that
  // ignore ``sessions`` keep their pre-fix behavior — they over-suppress
  // but never under-suppress, which is the safer drift direction.
  const { data, error } = await supabase
    .schema('chefbyte')
    .from('livetrack_import_sessions')
    .select('*')
    .eq('device_id', device.device_id)
    .not('state', 'in', '(closed,expired)')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('livetrack-session/active: list lookup failed', error);
    return jsonResponse({ error: 'lookup failed' }, 500);
  }

  const sessions = data ?? [];
  return jsonResponse({
    sessions,
    // Legacy field — newest row, or null. Pre-fix Pi binaries read this.
    session: sessions[0] ?? null,
  });
}

// ─── Entrypoint ──────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Service-role client — used by every route. JWT-scoped client is
    // only built inside handleCreate to call auth.getUser().
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const url = new URL(req.url);
    const cleanedPath = url.pathname.replace(/\/+$/, '');
    const segments = cleanedPath.split('/').filter(Boolean);
    const leaf = segments[segments.length - 1] ?? '';

    if (req.method === 'POST' && leaf === 'create') {
      return await handleCreate(supabase, req);
    }

    if (req.method === 'POST' && leaf === 'pi-update') {
      const device = await authenticatePi(supabase, req.headers.get('x-api-key'));
      if (!device) return jsonResponse({ error: 'unauthorized' }, 401);
      const body = await req.json().catch(() => ({}));
      return await handlePiUpdate(supabase, device, body);
    }

    if (req.method === 'GET' && leaf === 'active') {
      const device = await authenticatePi(supabase, req.headers.get('x-api-key'));
      if (!device) return jsonResponse({ error: 'unauthorized' }, 401);
      return await handleActive(supabase, device, req);
    }

    return jsonResponse({ error: 'not found' }, 404);
  } catch (err: any) {
    console.error('livetrack-session error:', err);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});
