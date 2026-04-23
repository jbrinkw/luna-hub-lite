# LiveTrack Wizard Suppression Gate

> **Status:** Live on `scale-01` / `scale-02` / `scale-03` as of 2026-04-22.
> Added in the same branch as the LiveTrack Import Wizard productionization.

## What it does

While the browser-side **LiveTrack Import wizard** is running, the Pi's
scale-event pipeline is fully short-circuited:

- No `scale_events` row is written.
- The classifier is **not** invoked (no Anthropic API call).
- No `cloud_outbox` row is enqueued → nothing mirrors to
  `chefbyte.shelf_event_log`.

Weight readings still hit the rolling **weight trace** (with a
`kind='event_suppressed'` marker) so diagnostics / `/api/diag/dump-session`
still see the activity for debugging. Heartbeats keep flowing through
their normal path too — the gate only covers the event pipeline.

## Why

While the wizard is active, the user is **deliberately placing items on
the scale** for calibration, pairing, or initial inventory import. Those
placements are intentional human actions already being handled by the
wizard's own round-trip (Pi posts the scale reading back to the cloud
session row via the `waiting_scale` interception). Letting those deltas
also flow through the normal event pipeline produces:

- Phantom pickup / remove / add sessions on the shelf.
- Wrong `in_flight` states on lots that aren't moving.
- Spurious classifier calls (money + noise).
- Bogus `shelf_event_log` rows in the cloud UI.

## State sync (poll, not push)

**The LiveTrack session row is the signal — no new column.**

The Pi already runs a `LiveTrackPoller` thread (see
`hardware/live-shelf/server/cloud/livetrack_poller.py`) that polls
`GET /livetrack-session/active` at 500ms when a session is known active
and 2s when idle. Its cached `snapshot()` is read by
`ScaleHandler._is_wizard_active()` at the top of `handle_scale_event`.

**Active = non-terminal**. Any of these states suppress:

- `waiting_barcode`
- `waiting_scale`
- `scale_reading_received`
- `awaiting_ai_tare`
- `ai_tare_ready`

**Terminal (no suppression):** `closed`, `expired`. The cloud edge
function already filters these out of `/active` via a partial index, so
the Pi's snapshot clears on the next poll tick (500ms–2s).

Why poll (not push): the poller already exists and handles the catch-all
waiting_scale + AI-tare branches. Reusing it costs zero new code paths
and matches the existing live-shelf pattern of "cloud is source of
truth, Pi reads on a schedule." Adding a push channel (new edge function
route, websocket) would mean a second state-sync pathway for the same
piece of state.

## Safety timeout

**Primary clock: cloud-side.** The `livetrack_import_sessions` schema
stamps `expires_at = now() + interval '10 minutes'` at INSERT. The edge
function filters expired rows out of `/active`, so a cleanly-closed or
abandoned browser releases suppression within 10 minutes + one poll
tick.

**Defensive Pi-side clamp: 15 minutes.** `_is_wizard_active` also
checks `created_at` on the snapshot. If the row is older than 15
minutes (beyond the cloud's 10-minute window), the Pi refuses to
suppress even if the snapshot still says "active" — a belt-and-
suspenders against a wedged poll thread or a cached snapshot where the
cloud has flipped the row to `expired` but the poller hasn't re-run.

The 15-minute ceiling is **deliberately longer than the 10-minute cloud
expiry** so the cloud's timer wins in the happy path and the Pi clamp
only fires on pathological stalls.

## Where it lives

`hardware/live-shelf/server/handlers/scale_events.py`:

- Constants + helper: `_LIVETRACK_ACTIVE_STATES`,
  `_LIVETRACK_MAX_SUPPRESSION_SECONDS`, `_is_wizard_active()`
- Gate: in `handle_scale_event`, immediately after the existing
  `waiting_scale` and tare-arm interception branches, **before** the
  single-item emit / noise branch / full session pipeline. Runs after
  direction classification so we can still annotate the debug
  weight-trace entry.

The gate applies to **all shelves** (`live_shelf`, `catch_all`,
`single_item`). Any of them can be "the scale being calibrated" during
a wizard session.

## Response shape

The handler returns `200 OK`:

```json
{
  "ok": true,
  "suppressed": "livetrack_wizard_active",
  "livetrack_session_id": "<uuid or null>",
  "livetrack_state": "<active state>",
  "shelf_id": "<resolved shelf>",
  "direction": "add|remove|noise",
  "delta_g": <float>
}
```

The ESP FIFO treats 2xx as "ack + drop" so the event is not retried.

## Coverage

- **Unit:** `server/tests/test_wizard_suppress_events.py` — 14 tests
  spanning every active/terminal state, noise, single-item shelf,
  cross-shelf, stale-snapshot timeout, and end-of-wizard transition.
- **Harness:** `scripts/harness/scenarios/livetrack_wizard_suppresses_events.py`
  — Pi↔cloud round-trip: real session row + real poller + real
  `pi_worker.tick()` → asserts `chefbyte.shelf_event_log` is empty
  during the wizard and populated after close.
- **Web:** `apps/web/src/__tests__/unit/pure/livetrack-wizard-start.test.ts`
  — pins `createLiveTrackSession()` calls `livetrack-session/create`
  (the INSERT that produces the wizard-active signal the Pi reads).

## Non-goals

- No refactor of the existing state machine beyond the gate.
- No general-purpose "suppression modes" (only `wizard_active`).
- No changes to classifier logic.
- Debug-trace recording is preserved — only downstream processing is
  suppressed.
