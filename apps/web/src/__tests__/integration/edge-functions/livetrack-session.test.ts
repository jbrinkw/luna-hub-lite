/**
 * livetrack-session Edge Function Integration Tests
 *
 * Closes audit item #6 (HIGH risk): "livetrack-session edge function has
 * zero tests at the edge-function layer." Prior to this file the routes
 * were only exercised end-to-end via the LiveTrack Import Wizard
 * (e2e/chefbyte/livetrack-import.spec.ts) — a JSON-validation or auth
 * regression on /create, /pi-update, or /active could slip through.
 *
 * Tests auth + validation + cross-user isolation for each route, mirroring
 * the shelf-ingest.test.ts pattern:
 *
 *   POST /livetrack-session/create     — browser; user JWT
 *   POST /livetrack-session/pi-update  — Pi; x-api-key
 *   GET  /livetrack-session/active     — Pi; x-api-key
 *
 * `verify_jwt = false` in config.toml — manual auth per route.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { adminClient, SUPABASE_URL } from '../../setup.integration';
import { createTestUser, cleanupUser } from '../../test-helpers';

const BASE_URL = `${SUPABASE_URL}/functions/v1/livetrack-session`;

describe('livetrack-session Edge Function', () => {
  // Primary user with a fresh-heartbeat device.
  let userA: { userId: string; jwt: string };
  let deviceA: string;
  let importKeyA: string;

  // Second user with their own device, used for cross-user isolation.
  let userB: { userId: string; jwt: string };
  let deviceB: string;
  let importKeyB: string;

  // Device with a STALE heartbeat (older than DEVICE_FRESH_WINDOW_MS) so
  // /create returns 409 even though auth passes.
  let staleDeviceId: string;
  let staleImportKey: string;

  // Disabled device — auth must reject.
  let disabledImportKey: string;

  beforeAll(async () => {
    // ─── User A ─────────────────────────────────────────────
    const a = await createTestUser('lts-a');
    await (a.client as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
    const { data: sA } = await a.client.auth.getSession();
    userA = { userId: a.userId, jwt: sA.session!.access_token };

    importKeyA = 'lts_' + randomBytes(16).toString('hex');
    const { data: devA, error: devAErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('live_shelf_devices')
      .insert({
        user_id: userA.userId,
        device_name: 'User A Pi',
        import_key_hash: createHash('sha256').update(importKeyA).digest('hex'),
        is_active: true,
        last_heartbeat_ts: new Date().toISOString(), // fresh
      })
      .select('device_id')
      .single();
    if (devAErr) throw new Error(`create deviceA: ${devAErr.message}`);
    deviceA = devA.device_id;

    // ─── User B ─────────────────────────────────────────────
    const b = await createTestUser('lts-b');
    await (b.client as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
    const { data: sB } = await b.client.auth.getSession();
    userB = { userId: b.userId, jwt: sB.session!.access_token };

    importKeyB = 'lts_' + randomBytes(16).toString('hex');
    const { data: devB } = await (adminClient as any)
      .schema('chefbyte')
      .from('live_shelf_devices')
      .insert({
        user_id: userB.userId,
        device_name: 'User B Pi',
        import_key_hash: createHash('sha256').update(importKeyB).digest('hex'),
        is_active: true,
        last_heartbeat_ts: new Date().toISOString(),
      })
      .select('device_id')
      .single();
    deviceB = devB.device_id;

    // ─── Stale-heartbeat device (for /create 409) ────────────
    staleImportKey = 'lts_' + randomBytes(16).toString('hex');
    const { data: staleDev } = await (adminClient as any)
      .schema('chefbyte')
      .from('live_shelf_devices')
      .insert({
        user_id: userA.userId, // userA owns this too — but we'll delete
                                // the fresh device before the 409 test.
        device_name: 'Stale Pi',
        import_key_hash: createHash('sha256').update(staleImportKey).digest('hex'),
        is_active: true,
        last_heartbeat_ts: new Date(Date.now() - 5 * 60_000).toISOString(), // 5 min old
      })
      .select('device_id')
      .single();
    staleDeviceId = staleDev.device_id;

    // ─── Disabled device ────────────────────────────────────
    disabledImportKey = 'lts_' + randomBytes(16).toString('hex');
    await (adminClient as any)
      .schema('chefbyte')
      .from('live_shelf_devices')
      .insert({
        user_id: userA.userId,
        device_name: 'Disabled Pi',
        import_key_hash: createHash('sha256').update(disabledImportKey).digest('hex'),
        is_active: false,
      });
  });

  afterAll(async () => {
    // Cascade from live_shelf_devices deletes livetrack_import_sessions.
    // Delete all devices owned by either user.
    await (adminClient as any)
      .schema('chefbyte')
      .from('live_shelf_devices')
      .delete()
      .in('user_id', [userA.userId, userB.userId]);
    await cleanupUser(userA.userId);
    await cleanupUser(userB.userId);
  });

  // ─────────────────────────────────────────────────────────────
  // POST /create — browser, user JWT
  // ─────────────────────────────────────────────────────────────

  describe('POST /create (browser)', () => {
    it('missing Authorization header → 401', async () => {
      const res = await fetch(`${BASE_URL}/create`, { method: 'POST' });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toMatch(/missing authorization/i);
    });

    it('bogus bearer token → 401', async () => {
      const res = await fetch(`${BASE_URL}/create`, {
        method: 'POST',
        headers: { Authorization: 'Bearer not.a.jwt' },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toMatch(/invalid token/i);
    });

    it('valid JWT + fresh device → 200 with a new session row', async () => {
      const res = await fetch(`${BASE_URL}/create`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userA.jwt}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session).toBeDefined();
      expect(body.session.session_id).toBeTruthy();
      expect(body.session.user_id).toBe(userA.userId);
      expect(body.session.device_id).toBe(deviceA);
      expect(body.session.state).toBe('waiting_barcode');

      // Cross-user isolation: user B calling /create must get userB's
      // device, never userA's.
      const resB = await fetch(`${BASE_URL}/create`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userB.jwt}` },
      });
      expect(resB.status).toBe(200);
      const bodyB = await resB.json();
      expect(bodyB.session.user_id).toBe(userB.userId);
      expect(bodyB.session.device_id).toBe(deviceB);
      // User B must NOT see userA's session in the response.
      expect(bodyB.session.device_id).not.toBe(deviceA);
    });

    it('expires prior live session on re-create (single live session per device)', async () => {
      // Pre-check: user A has a live session from the previous test.
      const { data: before } = await (adminClient as any)
        .schema('chefbyte')
        .from('livetrack_import_sessions')
        .select('session_id, state')
        .eq('device_id', deviceA)
        .not('state', 'in', '(closed,expired)');
      expect(before!.length).toBeGreaterThanOrEqual(1);
      const priorIds = before!.map((r: any) => r.session_id);

      // Re-create.
      const res = await fetch(`${BASE_URL}/create`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userA.jwt}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const newId: string = body.session.session_id;
      expect(priorIds).not.toContain(newId);

      // Prior rows flipped to expired.
      const { data: priorState } = await (adminClient as any)
        .schema('chefbyte')
        .from('livetrack_import_sessions')
        .select('session_id, state')
        .in('session_id', priorIds);
      for (const row of priorState ?? []) {
        expect(row.state).toBe('expired');
      }
    });

    it('no fresh device → 409 (Pi offline branch)', async () => {
      // Make userA's fresh device STALE so no fresh candidate remains.
      // Save original heartbeat so we can restore.
      const { data: beforeRow } = await (adminClient as any)
        .schema('chefbyte')
        .from('live_shelf_devices')
        .select('last_heartbeat_ts')
        .eq('device_id', deviceA)
        .single();
      const originalHeartbeat = beforeRow!.last_heartbeat_ts;

      await (adminClient as any)
        .schema('chefbyte')
        .from('live_shelf_devices')
        .update({ last_heartbeat_ts: new Date(Date.now() - 5 * 60_000).toISOString() })
        .eq('device_id', deviceA);

      try {
        const res = await fetch(`${BASE_URL}/create`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${userA.jwt}` },
        });
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error).toMatch(/fresh|heartbeat|offline/i);
      } finally {
        await (adminClient as any)
          .schema('chefbyte')
          .from('live_shelf_devices')
          .update({ last_heartbeat_ts: originalHeartbeat })
          .eq('device_id', deviceA);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  // POST /pi-update — Pi, x-api-key
  // ─────────────────────────────────────────────────────────────

  describe('POST /pi-update (Pi)', () => {
    let sessionIdA: string; // active session owned by userA/deviceA

    beforeAll(async () => {
      // Ensure userA has a fresh heartbeat so /create succeeds.
      await (adminClient as any)
        .schema('chefbyte')
        .from('live_shelf_devices')
        .update({ last_heartbeat_ts: new Date().toISOString() })
        .eq('device_id', deviceA);

      const res = await fetch(`${BASE_URL}/create`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userA.jwt}` },
      });
      const body = await res.json();
      sessionIdA = body.session.session_id;
    });

    it('missing x-api-key → 401', async () => {
      const res = await fetch(`${BASE_URL}/pi-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionIdA, scale_reading_g: 42 }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toMatch(/unauthorized/i);
    });

    it('bogus x-api-key → 401', async () => {
      const res = await fetch(`${BASE_URL}/pi-update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'totally-fake',
        },
        body: JSON.stringify({ session_id: sessionIdA }),
      });
      expect(res.status).toBe(401);
    });

    it('disabled device key → 401', async () => {
      const res = await fetch(`${BASE_URL}/pi-update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': disabledImportKey,
        },
        body: JSON.stringify({ session_id: sessionIdA }),
      });
      expect(res.status).toBe(401);
    });

    it('valid key, missing session_id → 400', async () => {
      const res = await fetch(`${BASE_URL}/pi-update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': importKeyA,
        },
        body: JSON.stringify({ scale_reading_g: 42 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/session_id/i);
    });

    it('valid key, unknown session_id → 404', async () => {
      const res = await fetch(`${BASE_URL}/pi-update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': importKeyA,
        },
        body: JSON.stringify({
          session_id: '00000000-0000-0000-0000-000000000000',
          scale_reading_g: 42,
        }),
      });
      expect(res.status).toBe(404);
    });

    it('valid key but session belongs to different device → 403 (cross-device scoping)', async () => {
      // UserB's device key updating userA's session must be rejected.
      const res = await fetch(`${BASE_URL}/pi-update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': importKeyB,
        },
        body: JSON.stringify({ session_id: sessionIdA, scale_reading_g: 99 }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/device/i);

      // And the session row was NOT mutated.
      const { data: row } = await (adminClient as any)
        .schema('chefbyte')
        .from('livetrack_import_sessions')
        .select('scale_reading_g')
        .eq('session_id', sessionIdA)
        .single();
      expect(row!.scale_reading_g).toBeNull();
    });

    it('valid matching key → 200, only ALLOWED fields written', async () => {
      const res = await fetch(`${BASE_URL}/pi-update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': importKeyA,
        },
        body: JSON.stringify({
          session_id: sessionIdA,
          scale_reading_g: 250.5,
          scale_reading_ts: new Date().toISOString(),
          state: 'scale_reading_received',
          // Disallowed fields — must be silently ignored, NOT 400.
          user_id: userB.userId,           // Pi cannot re-owner a row.
          current_barcode: 'evil-barcode', // browser territory.
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Number(body.session.scale_reading_g)).toBeCloseTo(250.5, 2);
      expect(body.session.state).toBe('scale_reading_received');
      // Disallowed field remained unchanged (user_id still userA).
      expect(body.session.user_id).toBe(userA.userId);
      // current_barcode wasn't set — the browser never wrote it.
      expect(body.session.current_barcode).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /active — Pi, x-api-key
  // ─────────────────────────────────────────────────────────────

  describe('GET /active (Pi)', () => {
    it('missing x-api-key → 401', async () => {
      const res = await fetch(`${BASE_URL}/active`, { method: 'GET' });
      expect(res.status).toBe(401);
    });

    it('bogus key → 401', async () => {
      const res = await fetch(`${BASE_URL}/active`, {
        method: 'GET',
        headers: { 'x-api-key': 'nope' },
      });
      expect(res.status).toBe(401);
    });

    it('valid key → 200 with the active session for THAT device only', async () => {
      // Ensure userA has a fresh heartbeat and a live session.
      await (adminClient as any)
        .schema('chefbyte')
        .from('live_shelf_devices')
        .update({ last_heartbeat_ts: new Date().toISOString() })
        .eq('device_id', deviceA);
      await fetch(`${BASE_URL}/create`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userA.jwt}` },
      });

      const res = await fetch(`${BASE_URL}/active`, {
        method: 'GET',
        headers: { 'x-api-key': importKeyA },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session).toBeDefined();
      expect(body.session.device_id).toBe(deviceA);
      expect(body.session.user_id).toBe(userA.userId);
    });

    it('cross-user isolation: device B key returns only device B sessions, never device A', async () => {
      const res = await fetch(`${BASE_URL}/active`, {
        method: 'GET',
        headers: { 'x-api-key': importKeyB },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // Either userB has their own session (from the earlier /create
      // call in the prior describe block) or null. Either way it must
      // NOT be userA's session.
      if (body.session !== null) {
        expect(body.session.user_id).toBe(userB.userId);
        expect(body.session.device_id).toBe(deviceB);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Unknown route
  // ─────────────────────────────────────────────────────────────

  it('unknown route → 404', async () => {
    const res = await fetch(`${BASE_URL}/bogus`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.jwt}` },
    });
    expect(res.status).toBe(404);
  });
});
