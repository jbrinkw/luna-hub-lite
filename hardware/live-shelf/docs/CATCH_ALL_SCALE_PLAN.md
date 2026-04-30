# Catch-all Scale — Plan (delta-capture model)

Date: 2026-04-28 (Pi state machine + catch-all reaper shipped)
Status: end-to-end shipped — cloud foundation + Pi unblocker + Pi state machine + catch-all-specific TTL reaper
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
2. User walks away. 6 h later the cloud's `private.reap_catch_all_in_flight()`
   reaper runs (cron every 30 min).
3. Reaper for `in_flight_kind='catch_all'`: clears `in_flight_since` +
   `in_flight_kind` + `pickup_event_id` + `pickup_weight_g`. Does NOT
   change `qty_containers`. Does NOT write `food_logs` — the user
   weighed an item but did not complete the delta-capture cycle, that's
   not consumption.

   This is fundamentally different from the live_shelf TTL path
   (which zeros qty + writes food_logs for the pre-pickup mass via
   `private.apply_shelf_event`'s pickup-resolve branch when the Pi
   reaper emits a `consumed` event with a matching `pi_event_id`).
   Catch-all and live_shelf intentionally diverge on TTL semantics.

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

## 6. Pi state machine — single-pool, runtime first-vs-second branching

**Final confirmed model (2026-04-28):** the catch-all uses ONE
candidate pool for both first and second events. The pool composition
does NOT change between first and second; the runtime branching
happens at apply time.

### 6.1 Pool — `pool_for_catch_all`

Source: `cloud_lots` (cloud-mirrored stock_lots) — NOT live_shelf-
style sources. Composition (`server/classifier/candidate_pool.py`):

| Tier | Source                                                               | Why-candidate string |
| ---- | -------------------------------------------------------------------- | -------------------- |
| 1    | `in_flight_kind='catch_all'` lots — items currently mid-measurement  | `in_flight`          |
| 2    | Certified-not-on-any-shelf lots, FEFO by `cloud_lots.created_at ASC` | `inventory_only`     |
| 3    | UNKNOWN sentinel                                                     | `sentinel`           |

"Not on any shelf" = no Pi-local `lots` row exists for the product.
Since `scale_pairings.lot_id` references `lots(lot_id)`, this
implicitly excludes LiveTrack-paired and live_shelf-tracked lots in
one predicate.

Lot-keyed: each candidate's `candidate_id` is the cloud `lot_id`,
NOT the `product_id` (unlike `pool_for_add` which collapses by
product). The apply path uses the picked candidate's `lot_id` to
look up the cloud_lots row's `in_flight_kind` for the runtime branch
decision; collapsing by product would lose that discriminator.

### 6.2 Runtime first-vs-second branching — `_dispatch_catch_all_add`

Implemented in `server/handlers/scale_events.py`. After the
classifier picks a candidate, the dispatch resolves the cloud_lots
row and branches:

1. **`item_id == UNKNOWN`** → fall through to legacy review path.
2. **Picked lot is in-flight on catch-all**
   (`cloud_lots.in_flight_kind='catch_all'`) → SECOND event. Emit
   `catch_all_second_measurement` with the lot's existing
   `pickup_event_id` as the cloud's first-event lookup key.
3. **Picked lot is NOT in-flight** AND measured weight ≈ tare ± 5%
   of `(tare+net)` AND no active session for this product → empty-
   bottle short-circuit. Emit `discarded` directly (preserves commit
   `abbd518`'s "user acknowledges empty container" semantics).
4. **Otherwise** → FIRST event. Emit `catch_all_first_measurement`
   with this Pi event_id stamped as `pi_event_id`.

### 6.3 Why one pool, not two?

The user's mental model is "every time I want to log how much I just
ate, I weigh it before and after on this scale." The first vs second
event is determined by physical state (is the lot already on the
catch-all from a prior placement?), not by what the user is trying
to do. Two pools would force the user to declare intent up front;
one pool lets the system figure it out from observation.

### 6.4 Empty-bottle short-circuit + sessioned drinking

A lot that's currently in-flight on catch-all (mid-session) coming
back at near-tare weight is the SECOND event of a delta-capture cycle
where the user drank the whole bottle — NOT a discard. The
second-measurement apply path correctly logs the macros for the full
delta. The empty-bottle short-circuit only fires when there's NO
active session for the lot (the "I drank this away from the catch-
all somehow and am acknowledging the empty container" path).

### 6.5 REMOVE-event suppression — single-event placement model (2026-04-30)

The user's mental model for the catch-all is "place item, weight
settles, photo taken, record". The lift-off (`direction='remove'`)
half of that interaction is **redundant** for catch-all because the
item was being weighed — not stored on the scale. live_shelf needs
ADD/REMOVE pairs (consumption tracking via in-flight); live_scale
needs negative-delta REMOVE events (direct-consumption signal); but
catch-all interactions are inherently one-shot measurements. We
therefore drop catch-all REMOVE events at ingress.

**Implementation** (`server/handlers/scale_events.py::handle_scale_event`):
A short-circuit branch fires when `shelf_id == 'catch_all' AND
direction == 'remove'`. The branch records a weight-trace marker
(`kind='event_suppressed', reason='catch_all_remove_suppressed'`),
logs an INFO line, and returns `{ok: true, suppressed:
'catch_all_remove'}`. Nothing else fires:

- No `scale_events` row insert.
- No dedup LRU update.
- No session pickup.
- No frame capture.
- No classifier dispatch.
- No cloud emit.
- No `lots` mutation (Pi-local OR cloud_lots).

**Branch ordering** (load-bearing): the suppression runs AFTER the
LiveTrack waiting-scale interception, the tare-arm interception, and
the LiveTrack wizard suppression — those branches DO legitimately
consume catch-all REMOVE events for their own purposes (a lift-off
can carry a tare value or a wizard scale reading). The suppression
runs BEFORE the dedup LRU, the `single_item` short-circuit, the
weight-trace event marker for ADDs, and the session/classifier
pipeline.

**State-machine implication**: the FIRST/SECOND measurement state
machine (§6.2) is unaffected by REMOVE suppression. After a
placement (FIRST), the user lifts the item (REMOVE suppressed —
in-flight markers stay set on `cloud_lots`) and re-places it (next
ADD → SECOND, since `cloud_lots.in_flight_kind='catch_all'` is
still set). A lift without re-placement leaves the in-flight markers
set; the catch-all-specific TTL reaper (§5.2 / Layer 5) clears them
after the configured TTL without changing qty or writing food_logs.

**Cloud impact**: zero. The cloud's `apply_shelf_event` never
accepted a "catch_all remove" event_kind in the first place
(`VALID_EVENT_KINDS` in `supabase/functions/shelf-ingest/index.ts`
lists only `catch_all_first_measurement`,
`catch_all_second_measurement`, and `discarded` for catch-all).
Pre-fix the Pi could route a catch-all REMOVE through the
live_shelf-style apply path which would call `mark_lot_in_flight`
on a Pi-local lot — wrong semantics for catch-all (no Pi-local lot
exists for catch-all-only inventory) and visible only as orphan
`session_resolutions` rows on Pi. The fix eliminates that orphan path.

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
- `server/handlers/tests/test_catch_all_remove_suppression.py`
  (2026-04-30) — 12 tests for the REMOVE-event suppression
  (§6.5): response shape, no scale_events / classifier / cloud-emit
  side effects, no lot mutations, weight-trace marker, ADD events
  unaffected, live_shelf REMOVE unaffected, live_scale REMOVE
  unaffected, noise events unaffected, place-lift-replace sequence
  preserves first/second state machine, tare-arm interception still
  wins over suppression.
- All existing catch-all tests (`test_catch_all_*.py`) still pass.

## 8. Layers shipped vs deferred

| Layer | Description                                                                    | Status                                                                    |
| ----- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 1     | Frame path persistence + inline classifier dispatch + sweeper recovery         | **Shipped** (2026-04-27)                                                  |
| 2     | Catch-all candidate pool (`pool_for_catch_all`)                                | **Shipped** (2026-04-28)                                                  |
| 3     | `in_flight_kind` schema column + backfill                                      | **Shipped** (2026-04-27)                                                  |
| 4     | Cloud apply branches (first/second measurement)                                | **Shipped** (2026-04-27)                                                  |
| 5     | Catch-all-specific TTL reaper (clear markers, don't zero qty)                  | **Shipped** (2026-04-28 — `private.reap_catch_all_in_flight()` + pg_cron) |
| 6     | Pi state machine: detect first vs second event, emit the correct event_kind    | **Shipped** (2026-04-28 — runtime branching in `_dispatch_catch_all_add`) |
| 7     | Empty container path (today's `abbd518`)                                       | **Verified** + extended to gate on "no active session"                    |
| 8     | UI: distinguish catch-all in-flight from live_shelf in-flight on InventoryPage | Deferred (low priority)                                                   |
| 9     | Harness scenarios                                                              | **Shipped** (2026-04-28 — first-event, full-session, TTL-clears-markers)  |
| 10    | REMOVE-event suppression (single-event placement model, §6.5)                  | **Shipped** (2026-04-30 — ingress short-circuit, 12 Pi tests)             |

## 9. Live_shelf TTL macro write — already correct

User question: does the live_shelf TTL path write `food_logs` for
the pre-pickup qty? **Yes** — verified 2026-04-28 via
`supabase/tests/chefbyte/in_flight_pickup_resolve_whole_lot.test.sql`
case 4. The Pi reaper emits a `consumed` event with
`delta_g = -pickup_weight_g` and `pi_event_id` matching the lot's
`pickup_event_id`. The cloud's `apply_shelf_event` consumed branch
detects the pickup-resolve match, zeros qty, AND writes a food_logs
row with `qty_consumed = (pickup_weight_g / net_weight_g) *
servings_per_container` servings. No code change needed.

---

_End of plan._
