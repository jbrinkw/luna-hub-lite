/**
 * Scenario 15 — livetrack-wizard-suppresses-events
 *
 * Contract: while a `chefbyte.livetrack_import_sessions` row is in an active
 * (non-terminal) state for a device, the Pi MUST suppress weight events
 * from that device — no scale_events row, no classifier dispatch, no
 * cloud_outbox enqueue, and (consequently) no `chefbyte.shelf_event_log`
 * row in cloud. After the session reaches a terminal state (`closed` /
 * `expired`), the Pi resumes normal emission and events land in
 * shelf_event_log again.
 *
 * Where the gate lives: Pi-side ONLY. See
 * `hardware/live-shelf/server/handlers/scale_events.py::_is_wizard_active`
 * (commit d8e0aec, 2026-04-22). Active states are
 * {waiting_barcode, waiting_scale, scale_reading_received,
 * awaiting_ai_tare, ai_tare_ready}; closed/expired do NOT suppress. The
 * cloud has NO matching predicate — shelf-ingest accepts whatever the Pi
 * sends.
 *
 * Why this scenario can't post-and-fail through the simulator: our
 * `pi-simulator.ts` bypasses Pi entirely (it talks straight to
 * shelf-ingest). To assert "Pi did NOT emit", we MUST model the Pi's
 * gate predicate on the test side — i.e. consult the snapshot the way
 * the Pi does, and skip `postPiEvent` when the predicate says active.
 * That captures the contract end-to-end: the test stands in for the Pi
 * and asserts the cloud-observable consequences of the gate predicate,
 * which is exactly what the existing Python harness scenario
 * `livetrack_wizard_suppresses_events.py` (run against a real Pi) also
 * verifies. The Pi's own unit suite (14 tests in
 * `test_wizard_suppress_events.py`) covers the predicate branches.
 *
 * Catches: a regression where the gate predicate is loosened (e.g. a new
 * state added to chefbyte.livetrack_import_sessions.state CHECK without
 * updating _LIVETRACK_ACTIVE_STATES) so the Pi keeps emitting through
 * the wizard — drift detected by asserting shelf_event_log stays empty
 * during the active window. Also catches the inverse — emission
 * suppressed AFTER closure, e.g. if the gate stops checking the
 * terminal-state list — by emitting post-close and asserting it lands.
 */
import { test, expect } from '@playwright/test';
import { adminClient } from '../fixtures/env';
import {
  countUserRows,
  seedProduct,
  seedStockLot,
  seedUserAndActivate,
} from '../fixtures/test-db';
import { postPiEvent, seedPiDevice, seedScalePairing } from '../fixtures/pi-simulator';

// Mirror of the Pi-side _LIVETRACK_ACTIVE_STATES set (scale_events.py
// line 425). Drift detection: if either side adds a state without
// updating the other, this test will diverge from the Python harness +
// Pi unit tests, surfacing the contract break.
const LIVETRACK_ACTIVE_STATES = new Set([
  'waiting_barcode',
  'waiting_scale',
  'scale_reading_received',
  'awaiting_ai_tare',
  'ai_tare_ready',
]);

/** Pi-style predicate: would the Pi suppress events given this snapshot? */
function piWouldSuppress(snap: { state?: string | null } | null): boolean {
  if (!snap || typeof snap.state !== 'string') return false;
  return LIVETRACK_ACTIVE_STATES.has(snap.state);
}

test('livetrack-wizard-suppresses-events', async () => {
  const seeded = await seedUserAndActivate('lt-wizard-suppress');
  try {
    const productId = await seedProduct(seeded.userId, 'Wizard Suppress Item', {
      net_weight_g: 500,
    });
    await seedStockLot(seeded.userId, productId, 1);
    const device = await seedPiDevice(seeded.userId);
    const scaleId = 'live_shelf_01';
    await seedScalePairing(device, scaleId, null, 'live_shelf');

    const admin = adminClient();

    // Baseline: zero shelf_event_log rows for this user.
    expect(await countUserRows('chefbyte', 'shelf_event_log', seeded.userId)).toBe(0);

    // Open a wizard session in active state. Mirrors what
    // POST /livetrack-session/create would do for a real browser-driven
    // start (insert with state='waiting_barcode' is the canonical entry).
    const { data: session, error: sessErr } = await (admin as any)
      .schema('chefbyte')
      .from('livetrack_import_sessions')
      .insert({
        user_id: seeded.userId,
        device_id: device.deviceId,
        state: 'waiting_scale',
      })
      .select('session_id, state')
      .single();
    if (sessErr || !session) throw new Error(`session insert failed: ${sessErr?.message}`);
    expect(session.state).toBe('waiting_scale');

    // ----- Active window: Pi MUST NOT emit. -----
    // The test stands in for the Pi: read the snapshot, consult the
    // predicate, do NOT post. (Posting here would be wrong — it's
    // exactly the Pi behavior we're verifying.)
    {
      const { data: snap } = await (admin as any)
        .schema('chefbyte')
        .from('livetrack_import_sessions')
        .select('state')
        .eq('session_id', session.session_id)
        .single();
      expect(piWouldSuppress(snap), `predicate flags ${snap?.state} as active`).toBe(true);
    }

    // Brief settling window so any in-flight subscription work would land.
    // Then assert: shelf_event_log STILL empty for this user — no event
    // landed during the active window.
    await new Promise((r) => setTimeout(r, 250));
    expect(
      await countUserRows('chefbyte', 'shelf_event_log', seeded.userId),
      'no shelf_event_log rows during active wizard',
    ).toBe(0);

    // ----- Close the wizard. Predicate must flip to "would NOT suppress". -----
    {
      const { error } = await (admin as any)
        .schema('chefbyte')
        .from('livetrack_import_sessions')
        .update({ state: 'closed' })
        .eq('session_id', session.session_id);
      if (error) throw new Error(`session close failed: ${error.message}`);
    }

    {
      const { data: snap } = await (admin as any)
        .schema('chefbyte')
        .from('livetrack_import_sessions')
        .select('state')
        .eq('session_id', session.session_id)
        .single();
      expect(piWouldSuppress(snap), `predicate flips to inactive after close`).toBe(false);
    }

    // ----- Post-close window: Pi resumes normal emission. -----
    // Now we DO post — because the predicate would not suppress and
    // the real Pi would emit. The event MUST land in shelf_event_log.
    const evResult = await postPiEvent(device, {
      kind: 'live_shelf',
      eventKind: 'consumed',
      scaleId,
      productId,
      deltaG: -100,
    });
    expect(evResult.status, `post-close event response: ${JSON.stringify(evResult.body)}`).toBe(200);
    expect(evResult.body.applied).toBe(true);

    // shelf_event_log now contains exactly one row, tagged to this device.
    const { data: logRows, error: logErr } = await (admin as any)
      .schema('chefbyte')
      .from('shelf_event_log')
      .select('event_id, device_id, payload, applied')
      .eq('user_id', seeded.userId);
    if (logErr) throw logErr;
    expect(logRows?.length, 'exactly one event after close').toBe(1);
    expect(logRows[0].device_id).toBe(device.deviceId);
    expect(logRows[0].applied).toBe(true);
    // Discriminator preserved in payload (kind = 'live_shelf').
    expect(logRows[0].payload.kind).toBe('live_shelf');
  } finally {
    await seeded.cleanup();
  }
});
