# Catch-all Scale — Plan (delta-capture model)

Date: 2026-04-27 (rewritten — superseded the 2026-04-17 single-item shelf model)
Status: cloud foundation + Pi unblocker shipped; Pi state machine deferred
Scope: `hardware/live-shelf/` (server) + `supabase/` (cloud)
Depends on: `IN_FLIGHT_TRACKER_PLAN.md` (live_shelf in-flight) — concept of in-flight, but with a different semantic than live_shelf

---

## 1. What it is

The catch-all (scale-02) is a **delta-capture measurement station**.
Each interaction is a self-contained "weigh this and log the consumption"
two-event session:

1. **First event** ("before" measurement): user places item on the
   scale; system identifies it visually, snapshots the measured weight
   into `stock_lots.pickup_weight_g`, reconciles
   `qty_containers = measured_g / net_weight_g`. Stamps in-flight
   markers (`in_flight_since`, `in_flight_kind='catch_all'`,
   `pickup_event_id`). **No food_logs row** — this is reconciliation,
   not consumption.
2. User picks the item up, eats some, places it back.
3. **Second event** ("after" measurement): system matches the placement
   against the in-flight catch-all items, computes
   `consumption_g = pickup_weight_g - measured_g`, updates qty to match
   the new measured weight, clears the in-flight markers, **writes
   food_logs** with the consumed delta's macros.

If no second event arrives within the TTL (default 6 h, same knob as
live_shelf): clear the in-flight markers but **keep the first-event qty
change** — the user did a one-shot measurement and walked away. No
food_logs row.

This is fundamentally different from the original 2026-04-17 plan
(catch-all as "secondary single-item shelf"), which tried to reuse
the `on_shelf ↔ in_flight ↔ out` state machine from live_shelf. That
model was internally consistent but:

- Required cross-shelf-reunite logic the user never wanted.
- Couldn't model "I'm eating from this and weighing what's left."
- Had a hard-coded "single-item only" constraint at odds with the
  user's actual workflow.

The delta-capture model maps directly onto the user's mental model:
"every time I want to log how much I just ate, I weigh it before and
after on this scale."

## 2. Hardware

(Unchanged from the original plan.)

- ESP unit: Wemos D1 Mini, 1 × HX711, device_id `scale-02`. Same
  stability state machine + heartbeat cadence as scale-01.
- USB camera: second webcam, `/dev/video2`, 1280x720 @ 10 fps. No
  enclosure, ambient lighting.
- Pi: same Flask process, same SQLite DB.

## 3. Data model

### 3.1 `stock_lots.in_flight_kind` (cloud)

`TEXT NULL CHECK (in_flight_kind IS NULL OR in_flight_kind IN
('live_shelf', 'catch_all'))`. Discriminator that distinguishes the
live_shelf in-flight state machine ("user lifted this from the live
shelf, expected back, full qty consumed on pickup-close whole-lot
resolution") from the catch_all in-flight state machine ("first
measurement of a delta-capture session, qty already reflects the
measured weight, second measurement records the delta"). Backfill
populates `'live_shelf'` for every existing in-flight row.

### 3.2 `stock_lots.pickup_weight_g` (cloud)

`NUMERIC(10,3) NULL CHECK (pickup_weight_g IS NULL OR
pickup_weight_g > 0)`. Snapshot of the weight at the moment the lot
entered an in-flight state. Live_shelf flow: weight at REMOVE time
(today this is implicit in shelf_event_log payloads — no production
code reads it for live_shelf yet, the column is forward-looking).
Catch-all flow: measured weight from the first event, used by the
second event to compute consumption delta.

### 3.3 Pi-side schema (`scale_events.before_frame_path`,

`.after_frame_path`)

Pre-existing columns. The catch-all unblocker (Layer 1, 2026-04-27)
adds the missing `UPDATE` after `_capture_catch_all_frames` returns —
without it, the inline-captured JPEGs lived only on disk and the cloud
event viewer / local /event/<id> page rendered placeholder tiles
forever.

## 4. Cloud event_kinds

Two new entries in `VALID_EVENT_KINDS`
(`supabase/functions/shelf-ingest/index.ts`):

- `catch_all_first_measurement`
- `catch_all_second_measurement`

Protocol notes (the cloud handler interprets `delta_g` differently for
these kinds):

| event_kind                     | `delta_g`                                      | `pi_event_id`                                                  |
| ------------------------------ | ---------------------------------------------- | -------------------------------------------------------------- |
| `catch_all_first_measurement`  | absolute measured weight in grams (positive)   | the Pi's scale_events.event_id for THIS first event            |
| `catch_all_second_measurement` | absolute measured weight at the second reading | the FIRST event's pi_event_id (used to find the in-flight lot) |

The cloud handler in `private.apply_shelf_event` (migration
`20260427130000_catch_all_delta_apply.sql`):

- **`catch_all_first_measurement`**:
  1. Validate `kind='catch_all'` and measured weight > 0.
  2. Resolve product `net_weight_g` (reject when missing — would make
     qty math impossible).
  3. Pick the lot: prefer qty>0 lot for the product; else most-recent
     lot of any qty (handles empty-lot revive); else mint a new lot.
  4. UPDATE `qty_containers = measured_g / net_weight_g`,
     `in_flight_since = occurred_at`, `in_flight_kind = 'catch_all'`,
     `pickup_event_id = pi_event_id`, `pickup_weight_g = measured_g`,
     `last_update_source = 'catch_all'`.
  5. NO food_logs INSERT.
  6. Stamp `shelf_event_log.reason = 'catch_all_first_measurement'`.

- **`catch_all_second_measurement`**:
  1. Validate `kind='catch_all'` and measured weight ≥ 0.
  2. Look up the in-flight catch_all lot by
     `(user_id, product_id, in_flight_kind='catch_all',
pickup_event_id = pi_event_id::uuid)`. Reject when no match.
  3. Compute `consumption_g = pickup_weight_g - measured_g`. Reject
     with `applied=false, reason='second measurement is not lighter
than first'` when `consumption_g <= 0`. Lot stays in flight so
     the Pi review queue can take over.
  4. UPDATE `qty_containers = measured_g / net_weight_g`, clear
     `in_flight_since` + `in_flight_kind` + `pickup_event_id` +
     `pickup_weight_g`.
  5. INSERT `food_logs` row with
     `qty_consumed = (consumption_g / net_weight_g) * servings_per_container`
     servings × per-serving macros. Logical date computed from the
     user's profile timezone + day_start_hour.
  6. Stamp `shelf_event_log.reason =
'catch_all_second_measurement_consumed'`.

## 5. Behaviour — happy paths + edges

### 5.1 Happy path: log a partial consumption

1. User opens fridge, grabs trail mix tub from the catch-all area.
2. Places it on the catch-all → first event fires. Pi classifier picks
   the trail mix product, Pi emits `catch_all_first_measurement`,
   delta_g = 350g (the measured weight), pi_event_id = X.
3. Cloud snapshots qty=350/500=0.7 and stamps in-flight markers. No
   macros logged yet.
4. User picks up tub, eats a handful, sets it back → second event
   fires. Pi classifier matches against the in-flight catch_all set
   (the trail mix lot), Pi emits `catch_all_second_measurement`,
   delta_g = 250g, pi_event_id = X (the first event's id).
5. Cloud computes consumption=100g, updates qty=0.5, clears markers,
   writes food_logs row for 0.2 servings of trail mix (40 cal etc).

### 5.2 Edge: one-shot measurement, no second event

1. First event fires, qty reconciled, in-flight markers stamped.
2. User walks away. 6 h later the TTL reaper runs.
3. Reaper for `in_flight_kind='catch_all'`: clears the markers but
   does NOT zero qty (vs live_shelf which zeros). Stamps
   `shelf_event_log.reason = 'catch_all_first_measurement_orphaned'`.

   _NOTE (deferred):_ this reaper logic is not yet wired. Currently the
   existing live_shelf reaper runs against `in_flight_since IS NOT
NULL` regardless of `in_flight_kind`, so a TTL-expired catch_all
   row will be zeroed exactly like a live_shelf one. Layer 5 of the
   redesign brief covers the proper fix.

### 5.3 Edge: inconsistent delta (heavier than first)

1. First event fires at 200g.
2. Second event reads 300g (heavier — physically implausible for a
   "consumption" session).
3. Cloud rejects with `applied=false, reason='second measurement is
not lighter than first'`. The in-flight markers stay set so the
   Pi-side review queue picks it up.

### 5.4 Edge: empty container (today's `abbd518`)

1. User places empty bottle on catch-all.
2. First event fires; Pi classifier picks the bottle product.
3. Apply path's `_maybe_emit_empty_container_discard` detects
   `placed ≈ tare ± 5%(tare+net)`. DELETEs the lot locally + emits
   `discarded` to cloud (existing semantics from `854c3ee`).

   _Pre-Layer-1 status:_ this code was unreachable because the
   classifier never ran for catch-all events. Layer 1 (frame
   persistence + inline dispatch) makes it live.

## 6. Pi state machine (deferred — Layer 6)

Detect placement (weight 0g → > threshold + stable):

- If no catch-all in-flight session for this user/device exists →
  this is a first event. Run classifier with the standard ADD pool
  (today). Emit `catch_all_first_measurement`.
- If a catch-all in-flight session exists → this is a candidate
  second event. Run classifier with a tight pool restricted to the
  in-flight catch_all items. Emit `catch_all_second_measurement` if
  it matches; treat as a fresh first event for a different item if
  it doesn't.

Detect removal (weight back to ~0g): nothing to do — the first/second
event already fired on placement+stable.

Status: **NOT YET IMPLEMENTED.** With Layer 1 (Pi unblocker) shipped,
the existing live-shelf-shape apply path runs against catch-all
events and emits `consumed`/`added`/`refilled` etc. The
`catch_all_first_measurement` / `catch_all_second_measurement` event
kinds are reachable end-to-end on the cloud side, but no Pi code
emits them yet. Next session's work.

## 7. Migrations + tests

### 7.1 Cloud migrations

- `20260427120000_catch_all_delta_capture_model.sql` — adds
  `in_flight_kind` + `pickup_weight_g` + CHECK constraints + partial
  index + backfill.
- `20260427130000_catch_all_delta_apply.sql` — extends
  `apply_shelf_event` with the two new branches. Preserves all prior
  branches verbatim (in_flight_pickup/return live_shelf, discarded,
  live_scale lot pinning + auto-rotation).

### 7.2 pgTAP

- `supabase/tests/chefbyte/catch_all_delta_capture.test.sql` — 30
  assertions across 8 cases (schema, first-event reconciliation,
  second-event consumption, inconsistent delta, mint-on-no-lot,
  mismatched pickup_event_id, kind validation, in_flight_kind
  stamping on live_shelf pickup).

### 7.3 Pi tests

- `server/handlers/tests/test_catch_all_dispatch.py` — 4 tests for
  the unblocker (frame persistence, inline classifier dispatch,
  live_shelf isolation, sweeper recovery). Mutation-verified.
- All existing catch-all tests (`test_catch_all_*.py`) still pass.

## 8. Layers shipped vs deferred

Per decisions.md #55:

| Layer | Description                                                                     | Status                  |
| ----- | ------------------------------------------------------------------------------- | ----------------------- |
| 1     | Frame path persistence + inline classifier dispatch + sweeper recovery          | **Shipped**             |
| 2     | First-event vs second-event candidate pool builders                             | Deferred                |
| 3     | `in_flight_kind` schema column + backfill                                       | **Shipped**             |
| 4     | Cloud apply branches (first/second measurement)                                 | **Shipped**             |
| 5     | Catch-all-specific TTL reaper (clear markers, don't zero qty)                   | Deferred                |
| 6     | Pi state machine: detect first vs second event, emit the correct event_kind     | Deferred                |
| 7     | Empty container path (today's `abbd518`) verified live as a Layer 1 side effect | **Verified**            |
| 8     | UI: distinguish catch-all in-flight from live_shelf in-flight on InventoryPage  | Deferred (low priority) |
| 9     | Harness scenarios (4 named in the brief)                                        | Deferred (need Layer 6) |

## 9. Why the partial ship?

Layer 1 alone is necessary AND sufficient for catch-all classification
to work AT ALL. Pre-Layer-1, every catch-all event was marked failed
~62 s after ingress (0 successful classifications across 21 events).
With Layer 1 the classifier runs and the existing apply path (which
emits `consumed`/`added`/`refilled` etc) takes over end-to-end —
including the empty-container detection that's been dead code since
2026-04-27.

The cloud-side foundation (Layers 3 + 4) is fully tested and
reversible. Shipping it ahead of the Pi-side (Layer 6) state machine
unblocks the next session: the migration + apply path + edge function
are forward-compatible with whatever Pi state machine lands.

The deferred Pi-side state machine (Layer 6) is the larger
engineering chunk — it requires real Pi-side state tracking (which
catch-all in-flight sessions exist for the device), per-event
classifier pool scoping (Layer 2), and harness coverage for both the
happy path and the no-second-event TTL case (Layer 9). Worth a
dedicated session.

---

_End of plan._
