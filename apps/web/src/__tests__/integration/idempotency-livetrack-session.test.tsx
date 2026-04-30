/**
 * LiveTrack Session Idempotency Contract Tests
 *
 * Verifies the idempotency and retry-safety contracts for the two write
 * routes in POST /livetrack-session:
 *
 *   POST /create   (browser, user JWT)
 *   POST /pi-update (Pi, x-api-key)
 *
 * Unlike shelf-ingest where idempotency is keyed on `client_event_id`,
 * livetrack-session has two distinct retry patterns:
 *
 *   /create:
 *     The browser-side wizard calls /create once per calibration session.
 *     On retry (network blip), a second /create call EXPIRES the prior
 *     live session for the same (device, scale) pair and inserts a fresh
 *     row. This is intentional "last-write-wins" idempotency: the Pi
 *     always sees the newest session via /active, and the browser always
 *     has the session_id from the most recent /create response. There is
 *     no semantic harm in creating a second session — the first is auto-
 *     expired. What we verify: after N /create calls on the same
 *     (device, scale) there is exactly ONE non-expired session, and the
 *     /active endpoint reflects the most recent one.
 *
 *   /pi-update:
 *     The Pi can call /pi-update multiple times with the same session_id
 *     and same payload (e.g. on retry after network loss). Each call
 *     returns the current session state. There is no separate dedup key
 *     here — the update is idempotent because writing the same value
 *     multiple times is a no-op in Postgres (UPDATE SET x=x has no
 *     side-effects). What we verify: two /pi-update calls with the same
 *     payload return 200 both times and produce the same session state.
 *
 * Test matrix (4 cases):
 *   1. /create called twice on same (device, scale): exactly one live session
 *   2. /create called concurrently on same (device, scale): exactly one live session
 *   3. /pi-update called twice with same session_id + payload → same result
 *   4. /pi-update on expired session → 410 on both retries (idempotent rejection)
 *
 * Environment: node (matches vitest.integration.config.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { adminClient, SUPABASE_URL } from '../../setup.integration';
import { createTestUser, cleanupUser } from '../../test-helpers';

const BASE_URL = `${SUPABASE_URL}/functions/v1/livetrack-session`;

// ─── Helpers ──────────────────────────────────────────────────────────────

function piHeaders(key: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-api-key': key };
}

function browserHeaders(jwt: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` };
}

/** Count non-expired sessions for a (device_id, scale_id) pair. */
async function activeSessions(deviceId: string, scaleId: string): Promise<number> {
  const { data, error } = await (adminClient as any)
    .schema('chefbyte')
    .from('livetrack_import_sessions')
    .select('session_id, state')
    .eq('device_id', deviceId)
    .eq('scale_id', scaleId)
    .not('state', 'in', '(closed,expired)');
  if (error) throw new Error(`activeSessions query failed: ${error.message}`);
  return (data ?? []).length;
}

/** Get the session state for a session_id. */
async function sessionState(sessionId: string): Promise<string | null> {
  const { data, error } = await (adminClient as any)
    .schema('chefbyte')
    .from('livetrack_import_sessions')
    .select('state')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error) throw new Error(`sessionState query failed: ${error.message}`);
  return data?.state ?? null;
}

// ─── Fixture setup ────────────────────────────────────────────────────────

describe('livetrack-session POST /create + /pi-update idempotency', () => {
  let userId: string;
  let userJwt: string;
  let deviceId: string;
  let importKey: string;

  // Scale IDs are stable across tests; each test uses a distinct scale
  // to avoid session-expiry interference between cases.
  const SCALE_CREATE_RETRY = 'scale-idem-create-retry';
  const SCALE_CREATE_CONCURRENT = 'scale-idem-create-concurrent';
  const SCALE_PI_UPDATE_RETRY = 'scale-idem-pi-update-retry';
  const SCALE_PI_UPDATE_EXPIRED = 'scale-idem-pi-update-expired';

  beforeAll(async () => {
    const user = await createTestUser('lts-idem');
    userId = user.userId;

    await (user.client as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
    const { data: session } = await user.client.auth.getSession();
    userJwt = session.session!.access_token;

    // Active device with a fresh heartbeat.
    importKey = 'lts_idem_' + randomBytes(16).toString('hex');
    const { data: dev, error: devErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('live_shelf_devices')
      .insert({
        user_id: userId,
        device_name: 'Idempotency Pi LTS',
        import_key_hash: createHash('sha256').update(importKey).digest('hex'),
        is_active: true,
        last_heartbeat_ts: new Date().toISOString(),
      })
      .select('device_id')
      .single();
    if (devErr) throw new Error(`create device: ${devErr.message}`);
    deviceId = dev.device_id;
  }, 60_000);

  afterAll(async () => {
    // Cascade: live_shelf_devices DELETE cascades to livetrack_import_sessions.
    await (adminClient as any).schema('chefbyte').from('live_shelf_devices').delete().eq('device_id', deviceId);
    await cleanupUser(userId);
  });

  // ─── Case 1: /create retry → exactly one live session ──────────────

  it('1: two sequential /create calls on the same (device, scale) → one live session', async () => {
    // First call.
    const res1 = await fetch(`${BASE_URL}/create`, {
      method: 'POST',
      headers: browserHeaders(userJwt),
      body: JSON.stringify({ device_id: deviceId, scale_id: SCALE_CREATE_RETRY }),
    });
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.session).toBeDefined();
    const session1Id = json1.session.session_id;

    // Second call — simulates a browser retry (e.g. network blip caused
    // the response to be lost; browser re-sends the same request).
    const res2 = await fetch(`${BASE_URL}/create`, {
      method: 'POST',
      headers: browserHeaders(userJwt),
      body: JSON.stringify({ device_id: deviceId, scale_id: SCALE_CREATE_RETRY }),
    });
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.session).toBeDefined();
    const session2Id = json2.session.session_id;

    // The second call creates a NEW session (fresh session_id).
    expect(session2Id).not.toBe(session1Id);

    // The first session must now be expired.
    const state1 = await sessionState(session1Id);
    expect(state1).toBe('expired');

    // Exactly ONE live session for this (device, scale).
    const live = await activeSessions(deviceId, SCALE_CREATE_RETRY);
    expect(live).toBe(1);

    // /active endpoint reflects the newest session only.
    const activeRes = await fetch(`${BASE_URL}/active?scale_id=${encodeURIComponent(SCALE_CREATE_RETRY)}`, {
      method: 'GET',
      headers: piHeaders(importKey),
    });
    expect(activeRes.status).toBe(200);
    const activeBody = await activeRes.json();
    // The Pi /active endpoint returns either `{ session }` or `{ sessions }`.
    const activeSess = activeBody.session ?? activeBody.sessions?.[0];
    expect(activeSess).toBeDefined();
    expect(activeSess.session_id).toBe(session2Id);
  });

  // ─── Case 2: Concurrent /create calls → exactly one live session ────

  it('2: concurrent /create calls on same (device, scale) → exactly one live session', async () => {
    // Fire two /create requests simultaneously.
    const [res1, res2] = await Promise.all([
      fetch(`${BASE_URL}/create`, {
        method: 'POST',
        headers: browserHeaders(userJwt),
        body: JSON.stringify({ device_id: deviceId, scale_id: SCALE_CREATE_CONCURRENT }),
      }),
      fetch(`${BASE_URL}/create`, {
        method: 'POST',
        headers: browserHeaders(userJwt),
        body: JSON.stringify({ device_id: deviceId, scale_id: SCALE_CREATE_CONCURRENT }),
      }),
    ]);

    const [json1, json2] = await Promise.all([res1.json(), res2.json()]);

    // The /create path has sequential expire-then-insert logic with no
    // ON CONFLICT guard. When two calls race on the same (user_id, scale_id)
    // the partial-unique index `livetrack_sessions_one_active_per_user_scale`
    // causes one INSERT to fail with 23505 (returned as 500). The other call
    // succeeds and produces exactly one live session.
    //
    // Idempotency guarantee here is at the DB state level: there is always
    // exactly ONE non-expired session for this (device, scale) pair after
    // both calls settle, regardless of which call won the race.
    const statuses = [res1.status, res2.status].sort();
    // At least one of the two calls must have created the live session (200).
    expect(statuses).toContain(200);
    // The winning caller has a valid session object.
    const winnerBody = res1.status === 200 ? json1 : json2;
    expect(winnerBody.session).toBeDefined();

    // After both settle: exactly ONE live session for this (device, scale).
    const live = await activeSessions(deviceId, SCALE_CREATE_CONCURRENT);
    expect(live).toBe(1);
  });

  // ─── Case 3: /pi-update retry → same result, second call idempotent ─

  it('3: /pi-update called twice with same session_id + payload → 200 both times, same state', async () => {
    // Create a session for the Pi to update.
    const createRes = await fetch(`${BASE_URL}/create`, {
      method: 'POST',
      headers: browserHeaders(userJwt),
      body: JSON.stringify({ device_id: deviceId, scale_id: SCALE_PI_UPDATE_RETRY }),
    });
    expect(createRes.status).toBe(200);
    const { session } = await createRes.json();
    const sessionId = session.session_id;

    const updatePayload = {
      session_id: sessionId,
      scale_reading_g: 850.5,
      scale_reading_ts: new Date().toISOString(),
      // 'scale_reading_received' is the valid state after the Pi records
      // a weight measurement. The allowed states are defined by the DB
      // check constraint livetrack_import_sessions_state_check:
      //   waiting_barcode | waiting_scale | scale_reading_received
      //   | awaiting_ai_tare | ai_tare_ready | closed | expired
      state: 'scale_reading_received',
    };

    // First /pi-update.
    const piRes1 = await fetch(`${BASE_URL}/pi-update`, {
      method: 'POST',
      headers: piHeaders(importKey),
      body: JSON.stringify(updatePayload),
    });
    expect(piRes1.status).toBe(200);
    const piJson1 = await piRes1.json();
    expect(piJson1.session).toBeDefined();
    expect(piJson1.session.state).toBe('scale_reading_received');
    expect(Number(piJson1.session.scale_reading_g)).toBeCloseTo(850.5, 1);

    // Second /pi-update — identical payload (retry after network loss).
    const piRes2 = await fetch(`${BASE_URL}/pi-update`, {
      method: 'POST',
      headers: piHeaders(importKey),
      body: JSON.stringify(updatePayload),
    });
    expect(piRes2.status).toBe(200);
    const piJson2 = await piRes2.json();
    expect(piJson2.session).toBeDefined();

    // Both calls must agree on the session state — the second write of
    // the same value is a no-op at the Postgres level.
    expect(piJson2.session.state).toBe('scale_reading_received');
    expect(piJson2.session.session_id).toBe(piJson1.session.session_id);
    expect(Number(piJson2.session.scale_reading_g)).toBeCloseTo(Number(piJson1.session.scale_reading_g), 1);
  });

  // ─── Case 4: /pi-update on expired session → 410 on both retries ────

  it('4: /pi-update on an expired session → 410 on first call AND retry (idempotent rejection)', async () => {
    // Create, then manually expire the session so we can test the expired path.
    const createRes = await fetch(`${BASE_URL}/create`, {
      method: 'POST',
      headers: browserHeaders(userJwt),
      body: JSON.stringify({ device_id: deviceId, scale_id: SCALE_PI_UPDATE_EXPIRED }),
    });
    expect(createRes.status).toBe(200);
    const { session } = await createRes.json();
    const sessionId = session.session_id;

    // Expire it directly in the DB.
    await (adminClient as any)
      .schema('chefbyte')
      .from('livetrack_import_sessions')
      .update({ state: 'expired', expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq('session_id', sessionId);

    const piPayload = {
      session_id: sessionId,
      scale_reading_g: 100,
      scale_reading_ts: new Date().toISOString(),
    };

    // First attempt — session is expired.
    const piRes1 = await fetch(`${BASE_URL}/pi-update`, {
      method: 'POST',
      headers: piHeaders(importKey),
      body: JSON.stringify(piPayload),
    });
    // The edge function returns 410 for expired sessions.
    expect(piRes1.status).toBe(410);
    const piJson1 = await piRes1.json();
    expect(piJson1.error).toMatch(/expired/i);

    // Second attempt (retry) — must still return 410, not 200.
    const piRes2 = await fetch(`${BASE_URL}/pi-update`, {
      method: 'POST',
      headers: piHeaders(importKey),
      body: JSON.stringify(piPayload),
    });
    expect(piRes2.status).toBe(410);
    const piJson2 = await piRes2.json();
    expect(piJson2.error).toMatch(/expired/i);

    // The session must still be expired in the DB — no state mutation.
    const state = await sessionState(sessionId);
    expect(state).toBe('expired');
  });
});
