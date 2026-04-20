# Catch-all Scale — Plan

Date: 2026-04-17
Status: plan only — no code written
Scope: `hardware/live-shelf/` (server + firmware)
Depends on: `IN_FLIGHT_TRACKER_PLAN.md` and `USAGE_LOG_PLAN.md` (both shipped)

---

## 1. What it is

A second, smaller scale that sits next to the fridge and tracks anything that
isn't on the live shelf. When the user puts something on it, the system takes
a picture 1.5 s later, waits for stability, classifies it, and logs it as
`in_flight`. When the user returns the item to the scale later, the system
recognises it (image + weight proximity to the original pickup) and logs the
consumption delta to the usage log — same path as a live-shelf in-flight
return.

It runs as a second load-cell + second USB camera plugged into the existing
Pi, sharing the same Flask process, DB, classifier, and usage log as the live
shelf.

## 2. Goals / non-goals

**Goals**
- Track items the user consumes that never go on the live shelf (snacks
  from the pantry, portions from a bulk container, etc.).
- Reuse the existing `in_flight` status, `usage_log` table, and classifier
  pipeline as much as possible — no parallel data model.
- Second camera + second ESP + second load-cell, same Pi + same process.
- Single-item events only — the catch-all is for "one thing at a time."

**Non-goals**
- No multi-item classification on the catch-all (no `multi_match` logic).
- No door / brightness gating — the catch-all is always "open" to events.
- No cross-shelf matching — a live-shelf item placed on the catch-all is
  treated as UNKNOWN (minted fresh as a catch-all lot), not as a return.
  Two shelves with distinct identities keeps the candidate pools clean.
- No fleet support. Hardcoded two-shelf enum for now; promote to a
  `shelves` table if a third shelf ever shows up.

## 3. Hardware

**ESP unit:**
- Wemos D1 Mini (same board as scale-01) with ONE HX711 load cell instead
  of four. Device id `scale-02`. Static IP `192.168.0.198` (or DHCP with
  mDNS — either works, Pi is the authoritative resolver).
- Firmware: same codebase as `firmware/scale-live.ino`, just configured
  with one HX711 DOUT pin instead of four parallel reads. Same stability
  state machine, same LED, same NTP + heartbeat + event emission.
- Same 10 Hz sample rate, same stability window tuning (configurable via
  the onboard web UI).

**USB camera:**
- Second USB webcam → plugs into any free Pi port. Maps to `/dev/video2`
  (0 = live-shelf cam, 1 is often the /dev/video0 format device, 2 is the
  next free) — verify with `v4l2-ctl --list-devices` after plug-in.
- Resolution + fps: same as the live-shelf cam (1280x720 @ 10 fps).

**Physical placement:**
- The catch-all sits next to the fridge on a flat surface. The camera
  mounts above (desk-arm, small tripod, or wall shelf) pointing down at
  the scale surface. No enclosure — lighting comes from ambient kitchen
  light.
- No door, no brightness-triggered sessions. Events are triggered purely
  by weight changes on the scale.

## 4. Data model

Minimal additions — reuse everything.

### 4.1 `shelf_id` discriminator column

Add `shelf_id TEXT NOT NULL DEFAULT 'live_shelf'` to:
- `lots`
- `sessions`
- `scale_events`

Valid values: `'live_shelf'`, `'catch_all'` (enforced via CHECK). Every
existing row backfills to `'live_shelf'` in the migration. An index on
`lots(shelf_id, status)` speeds up per-shelf registry queries.

Rationale: a full `shelves` table is overkill for two hardcoded shelves.
If/when we scale to N, migrate the enum to a real table. For now the
column is a bool with string names.

### 4.2 `app_state` per-shelf session pointers

Add `current_catch_all_session_id TEXT` alongside the existing
`current_session_id`. Rename the existing column to
`current_live_shelf_session_id` (via the rebuild-table migration pattern
already in `migrations.py`), or — simpler — leave `current_session_id`
as-is for the live shelf and just add the second column.

Default: simpler wins. Keep `current_session_id` as the live-shelf
session pointer (backward-compat); add `current_catch_all_session_id`
as a new column.

### 4.3 Shelf-identity lookup

A small module-level dict `SHELF_REGISTRY` maps `shelf_id` → config:
```py
SHELF_REGISTRY = {
    "live_shelf": {
        "device_id": "scale-01",
        "camera_device": "/dev/video0",
        "session_trigger": "brightness",   # existing door-open/close
        "photo_delay_seconds": 0.0,        # frame-picker handles settle
    },
    "catch_all": {
        "device_id": "scale-02",
        "camera_device": "/dev/video2",
        "session_trigger": "weight",       # weight > threshold
        "photo_delay_seconds": 1.5,        # delay before photo
    },
}
```
Loaded from config + optionally overridden by env vars.

### 4.4 No usage_log changes

Usage log already has `lot_id` which resolves to a lot whose `shelf_id`
tells you the source. The UI inventory page groups by shelf_id, but the
usage_log table itself is shelf-agnostic.

## 5. Behaviour / pipeline

### 5.1 State machine

Weight-triggered micro-session model:

```
Scale state: weight == 0   (idle)
             │
             │ user places item; weight rises above CATCH_ALL_ONSCALE_THRESHOLD_G (default 5g)
             ▼
             weight > 0   (session open)
             │
             │ after CATCH_ALL_PHOTO_DELAY_S (1.5s): capture "initial" photo
             │
             │ ESP stability state machine declares stable after N samples
             ▼
             stable weight = W  → fire scale event (direction = add, delta_g = +W)
             │
             │ Pi receives event. Classifier runs on the initial photo.
             │ Candidate pool (catch-all scope, ordered):
             │   1. in_flight lots where shelf_id='catch_all' (priority, weight-proximity rank)
             │   2. UNKNOWN sentinel
             │ NOTE: live-shelf lots are NOT in the catch-all pool.
             │
             │ Decision:
             │   A. Classifier picks existing in_flight lot → this is a RETURN
             │      • consumption_g = existing.pickup_weight_g − W (clamped, noise-floor)
             │      • writes usage_log (kind='in_flight_return', shelf via lot)
             │      • flips lot back to status='on_shelf' (transiently, while on scale)
             │      • new pickup_weight_g captured for the NEXT removal cycle
             │   B. Classifier picks UNKNOWN → this is a NEW placement
             │      • mint a new lot: shelf_id='catch_all', status='on_shelf',
             │        current_weight_g=W
             │      • create a catalog product entry inline via the intake
             │        ai-tare path, OR use a placeholder "unknown" product
             │        if the classifier wouldn't commit on a new SKU
             │
             │ weight drops back to 0
             ▼
             REMOVE event fires (direction=remove, delta_g=-W)
             │
             │ Apply path (reuses existing code):
             │   • lot was on_shelf on catch-all
             │   • flip to status='in_flight' + record pickup_weight_g=W
             │   • write in_flight_pickup resolution
             │
             │ Session closes.
             ▼
             weight == 0 (idle)

  [later]    user returns item. Weight rises again → new micro-session.
             Same flow; step A now fires because the lot is in_flight.
```

Key point: the catch-all reuses the existing `on_shelf ↔ in_flight`
transitions from the in-flight tracker. The only novelty is:
1. Weight-triggered session open/close (vs. brightness).
2. 1.5 s photo delay on the ADD event (vs. frame-picker settle).
3. Single-item-only pool.

### 5.2 First-placement

**All catch-all items are pre-intake'd** — the user only puts prepped
items (with barcode / name / reference photos / weight) on the catch-all;
the point of the scale is tracking stuff that doesn't fit on the live
shelf, not registering new stuff on the fly. So first placement is just
the existing `catalog_not_on_shelf` pick path, scoped to catch-all:

- Candidate pool = certified products from the catalog that have no
  current catch-all lot + any in-flight catch-all lots.
- Classifier matches the captured photo against catalog reference images.
- On a confident match → mint a new lot with `shelf_id='catch_all'`,
  `status='on_shelf'`, `current_weight_g` = stable scale reading. Same
  mint path already used by the live shelf for `catalog_not_on_shelf`
  picks.
- Low confidence / UNKNOWN → review_queue entry (same as live shelf);
  user can resolve from the inventory page.

No placeholder products, no Claude-generated names. The catalog is the
single source of truth.

### 5.3 Session lifetime

A catch-all session is short — seconds, not minutes. It opens when weight
first rises and closes when weight returns to zero. Within the session
there are two events: the ADD (initial placement) and the REMOVE (user
takes the item). If the user leaves the item on the scale indefinitely,
the session stays open — the reconciler-on-close hook only fires when
weight drops back to zero.

TTL: the existing in-flight TTL reaper (4 h default) applies. An item
placed on the catch-all and never returned → reaper flips it to `out`
after 4 h and records the full pickup weight as consumption.

## 6. Code changes

### 6.1 New: `WeightHandler` (brightness analog)

`server/handlers/weight.py`:
```py
class WeightHandler:
    def __init__(self, *, conn, db_lock, shelf_id, onscale_threshold_g=5.0, ...):
        self._open = False
    def on_weight_sample(self, device_id, weight_g, ts):
        if not self._open and weight_g >= self._threshold:
            self._open_session()
        elif self._open and weight_g < self._threshold:
            self._close_session()
```

Wired to the heartbeat path, which already reports `weight_g` every 500ms.
Session open writes `sessions.shelf_id='catch_all'` +
`app_state.current_catch_all_session_id`. Session close mirrors the
existing brightness-close logic (process events, run reconciler).

### 6.2 Extended: `CameraDaemon` — second instance

`CameraDaemon.__init__` already takes a `camera_device` parameter. We
instantiate it twice in `app.py`, each with its own device + its own
ring buffer + its own `on_frame` subscribers. Each serves its own
MJPEG stream at `/live.mjpg?shelf=live_shelf` or
`/live.mjpg?shelf=catch_all` (new query param routed to the right daemon).

The brightness watch / session_capture integration only applies to the
live-shelf daemon. The catch-all daemon has no session_capture hookup —
its sessions are weight-triggered via `WeightHandler`.

Photo-delay behavior: for catch-all ADD events, the apply-path frame
pick reads from the catch-all daemon's ring buffer at
`event_ts + CATCH_ALL_PHOTO_DELAY_S`. The ring buffer keeps frames for
~30 s already; 1.5 s is well within the window.

### 6.3 Extended: `ScaleHandler` routing by `device_id`

`handle_scale_event` already receives `device_id` in the payload. Route:
- `device_id == 'scale-01'` → live-shelf session lookup (brightness-backed)
- `device_id == 'scale-02'` → catch-all session lookup (weight-backed)

At the apply stage:
- Candidate source is shelf-aware (§6.5).
- Frame picker uses the right camera daemon (§6.2).
- `session_id` back-stamps use the shelf's `current_*_session_id`.

One handler; two routes internally. Keeps the HTTP surface simple (one
`/api/scale-event` endpoint that reads `device_id`).

### 6.4 Extended: session-capture module

`session_capture` is currently brightness-bound. Split into:
- `session_capture_brightness` (existing logic, live-shelf only)
- `session_capture_weight` (new, catch-all — simpler: no lit-frame
  archive, just pass-through from the catch-all camera daemon for
  frame-picker lookups)

The brightness-based live-frame archive + session-close video encoding
are live-shelf features. Catch-all skips them — sessions are too short
to need a video.

### 6.5 Extended: classifier `CandidateSource`

Add `shelf_id` parameter to `get_on_shelf_lots`, `get_in_flight_lots`,
`get_recently_out_lots`, `get_certified_not_on_shelf`. Default to
`None` = all shelves (backward-compat). The scale handler passes
`shelf_id` derived from `device_id` when invoking the classifier.

`RepoCandidateSource` filters via `WHERE shelf_id = ?` on each SQL query.

### 6.6 Extended: inventory + dashboard UI

**Inventory page** — add a second top-level section:

```
/inventory

  [ shelf: live_shelf ]
    On Shelf (N) …
    In Flight (M) …
    Catalog …

  [ shelf: catch_all ]
    On Shelf (n) …            (items currently sitting on the catch-all)
    In Flight (m) …           (items taken off the catch-all)
    — (no separate catalog; shared with live_shelf)

  Usage Log (combined) …
```

**Dashboard** — two live preview tiles side-by-side:
```
  live shelf preview      catch-all preview
  [ /live.mjpg?shelf=      [ /live.mjpg?shelf=
      live_shelf ]             catch_all ]
  door: open/closed        weight: 142 g
  weight: 420 g            session: open/closed
  session: …               last event: …
```

Each tile polls its own `/api/state?shelf=...`. Single `/api/state`
endpoint, optional `shelf` query param (default = live shelf for
backwards-compat).

**Tuning card** — per-shelf event-delta-threshold input. One row per
shelf.

## 7. ESP firmware

Single-load-cell variant: `firmware/scale-catch-all.ino`. 95 % copy of
`scale-live.ino` with:
- 1 × HX711 instead of 4 (one DOUT pin).
- Same stability logic, same stability thresholds (tune per scale as
  needed via the onboard web UI).
- `device_id = "scale-02"` default.
- Same `/api/scale-event` and `/api/scale-heartbeat` Pi endpoints.

Heartbeat cadence: 500 ms, same as scale-01.

## 8. Config knobs

Three new values in `config.py` `DEFAULTS`, all runtime-tunable via
`/api/config`:

| Name                               | Default | Purpose                                      |
| ---------------------------------- | ------- | -------------------------------------------- |
| `CATCH_ALL_CAMERA_DEVICE`          | `/dev/video2` | USB device for the catch-all camera.   |
| `CATCH_ALL_PHOTO_DELAY_S`          | 1.5     | Delay between first weight detection and the photo. |
| `CATCH_ALL_ONSCALE_THRESHOLD_G`    | 5.0     | Weight above which a catch-all session opens. |
| `CATCH_ALL_DEVICE_ID`              | `scale-02` | ESP `device_id` expected on ingress.   |
| `CATCH_ALL_ENABLED`                | false   | Feature flag — off for boot until we flip it after deploy. |

The live shelf's existing `EVENT_DELTA_THRESHOLD_G` (15 g) governs the
scale-event minimum delta for BOTH shelves. A future knob can split
per-shelf if the catch-all needs a smaller threshold.

## 9. Migrations

### 9.1 Fresh DB (schema.sql)

- Add `shelf_id TEXT NOT NULL DEFAULT 'live_shelf' CHECK(shelf_id IN ('live_shelf','catch_all'))` to `lots`, `sessions`, `scale_events`.
- Add `current_catch_all_session_id TEXT` to `app_state`.
- Add `CREATE INDEX idx_lots_shelf_status ON lots(shelf_id, status);`
- Add `CREATE INDEX idx_sessions_shelf ON sessions(shelf_id);`
- Add `CREATE INDEX idx_scale_events_shelf ON scale_events(shelf_id);`

### 9.2 Existing DB (`_apply_column_additions`)

- `ALTER TABLE lots ADD COLUMN shelf_id TEXT NOT NULL DEFAULT 'live_shelf'`
- Same for `sessions`, `scale_events`.
- Add index CREATEs with `IF NOT EXISTS`.
- `ALTER TABLE app_state ADD COLUMN current_catch_all_session_id TEXT`.
- The CHECK constraint on `shelf_id` requires a table rebuild (same
  pattern as the existing lots/session_resolutions rebuilds in
  `migrations.py`). Reuse the helper pattern.

### 9.3 No backfill of historical data needed

All existing rows are live-shelf by the DEFAULT. Catch-all rows start
appearing only after the feature flag flips on.

## 10. Rollout order

Each step independently committable + testable:

1. **Storage** — shelf_id columns + CHECK + indexes + migration tests.
2. **Shelf registry** — `SHELF_REGISTRY` constant + config loader + a
   `get_shelf_for_device(device_id)` helper.
3. **Candidate source** — shelf-aware filters in `RepoCandidateSource`
   and the reconciler adapter. Pool unit tests.
4. **Second CameraDaemon instance** — wire in `app.py`. `/live.mjpg`
   routes accept a `shelf` query param. Dashboard gets two preview
   tiles behind a feature flag.
5. **WeightHandler** — new handler + HTTP wiring so scale-02 events
   open/close catch-all sessions based on the heartbeat weight. No
   classification yet — events get `session_id` back-stamped but no
   apply-path mutations.
6. **Apply-path shelf-awareness** — ScaleHandler routes based on
   `device_id` → shelf_id; classifier pool filtered accordingly; frame
   picker reads from the right camera daemon.
7. **First-placement mint path** — UNKNOWN → mint placeholder lot
   with the initial photo as the first reference image. On return,
   same lot is recognised by image + weight.
8. **UI** — inventory page gets the catch-all section; `/api/state?shelf=`
   query param; dashboard preview tiles labelled.
9. **ESP firmware** — one-HX711 variant flashed onto scale-02.
10. **Feature flag flip** — `CATCH_ALL_ENABLED=true` in `.env`. Observe
    in production for a day before removing the flag.
11. **Polish** — per-shelf tuning inputs, CSV export, cleanup.

## 11. Testing plan

### 11.1 Unit

- `test_shelf_id_default_for_legacy_lots` — migration backfills to
  `live_shelf`.
- `test_shelf_id_check_constraint_rejects_unknown_value`.
- `test_get_shelf_for_device_maps_correctly`.
- `test_weight_handler_opens_session_above_threshold`.
- `test_weight_handler_closes_session_at_zero`.
- `test_weight_handler_hysteresis` — don't chatter on borderline values.
- `test_candidate_source_scoped_by_shelf_id` — live-shelf lots are NOT in
  the catch-all pool and vice versa.

### 11.2 Integration

`server/tests/test_catch_all_end_to_end.py`:
- **New placement:** catch-all session opens, UNKNOWN mint path fires,
  lot exists with shelf_id='catch_all', status='on_shelf', reference
  image written.
- **Removal after new placement:** weight → 0, lot flips to in_flight,
  usage_log untouched, resolution row `in_flight_pickup`.
- **Return cycle:** second placement matches existing in_flight lot
  via classifier, usage_log row written with consumption delta.
- **TTL expiry on catch-all:** lot in_flight for > 4 h → reaped → usage
  row written with full pickup weight.
- **Cross-shelf isolation:** a lot on the live shelf never appears in a
  catch-all classifier pool.

### 11.3 Migration

- `test_apply_column_additions_adds_shelf_id_defaulted_to_live_shelf`
- `test_legacy_lots_have_shelf_id_live_shelf`
- `test_shelf_id_check_rebuilds_when_missing`

### 11.4 Web

- `/inventory` renders both shelf sections.
- `/live.mjpg?shelf=catch_all` streams the catch-all camera.
- `/api/state?shelf=catch_all` returns catch-all door/weight/session.

### 11.5 Hardware smoke (Pi)

Ad-hoc, no automated test — document the manual steps:
1. Plug in second camera. Confirm `v4l2-ctl --list-devices` sees it at
   `/dev/video2`.
2. Flash scale-02 firmware. Confirm it heartbeats on the Pi.
3. Place an object (known weight) on the scale → verify session opens,
   photo captured after 1.5s, classification runs, lot minted.
4. Remove the object → verify session closes, lot goes in_flight.
5. Replace the object → verify usage_log row appears with expected
   delta.

## 12. Observability

New `ReasonCode` entries in `storage/lifecycle.py`:
- `CATCH_ALL_SESSION_OPENED`
- `CATCH_ALL_SESSION_CLOSED`
- `CATCH_ALL_PHOTO_CAPTURED`
- `CATCH_ALL_NEW_LOT_MINTED`

Both brightness and weight handlers log the same `SESSION_OPENED` /
`SESSION_CLOSED` reason codes with distinct `actor` strings
(`brightness_handler` vs `weight_handler`) so the existing event
timeline works unchanged.

## 13. Open decisions

1. ~~First-placement mint path~~ — **Resolved 2026-04-17.** Everything
   on the catch-all is pre-intake'd. §5.2 just reuses the existing
   `catalog_not_on_shelf` pick path scoped to catch-all.

2. **Cross-shelf mirror?** Should a live-shelf lot placed on the catch-all
   be matched back to the original live-shelf lot so consumption flows
   to the same `lots` row? Default: **no** — two shelves = two independent
   inventories. If the user wants to "move" a live-shelf item to the
   catch-all they can add it again. Revisit if users complain.

3. **Scale-specific event threshold?** `EVENT_DELTA_THRESHOLD_G` currently
   15 g for live shelf. Small catch-all items (a candy bar) may need a
   lower threshold (e.g. 5 g). Default: **start with 15 g for both**;
   add a per-shelf override knob only if needed.

4. **Session close on weight-zero vs. timeout?** If the scale drifts just
   above threshold for minutes after the user leaves (slight breeze
   pushing a napkin), the session would stay open forever. Default: add
   a `CATCH_ALL_SESSION_MAX_AGE_SECONDS` (e.g. 600 s) that force-closes
   a stale open session. Belt-and-braces.

5. **Shelves table vs. enum column?** Starting with the column; promote
   to a table if a third shelf arrives.

6. **Photo-delay relative to what?** Plan says "1.5 s after weight
   detected" — measured from the first heartbeat with weight >
   threshold, NOT from the stability-triggered scale event (which may be
   2-3 s later). The 1.5 s delay catches the user's hand still in frame
   at 0 s but clear by 1.5 s. If 1.5 s is too tight (user hasn't fully
   let go yet) bump to 2.0 s via the config knob.

---

*End of plan.*
