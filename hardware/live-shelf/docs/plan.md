# Live Shelf Demo — Detailed Build Plan

**Status:** Authoritative spec for the Pi-local demo. All agents read this file and work from it.
**Date:** 2026-04-15
**Scope:** Standalone demo base. Pi 4 + one ESP8266 scale + one USB camera. Local SQLite is the source of truth for the Pi side. Cloud integration exists — see `PROD_MIGRATION_PLAN.md` for the Supabase-backed ChefByte sync layer. The Pi still works fully offline (`CLOUD_ENABLED=0` fallback).

---

## 1. System overview

A single physical "live shelf" consisting of:

- A platform supported by 4 load cells wired to one ESP8266 scale node (shared-SCK + 4 DOUTs as already spec'd)
- A USB camera mounted looking down / into the shelf, attached to a Pi 4
- An LED on the shelf signaling scale stability to the user
- The Pi runs a single Python process that owns all state, classification, reconciliation, and UI

Normal use:

1. User does a one-time "intake" for each product that's eligible to live on the shelf (barcode → profile + reference photos + certification)
2. User places certified items on the shelf when the LED is green
3. When door opens, the session starts. User can take items off (multi-item OK) and place items back (one at a time, LED-enforced)
4. When door closes, the session reconciler pairs events, updates stock, and commits the session

The Pi does everything: scale event ingestion, frame extraction, candidate-pool assembly, Anthropic multimodal classifier call, session reconciliation, review queue, and web UI.

---

## 2. Hardware layout

### ESP8266 scale node

- Wemos D1 Mini
- 4× HX711, shared SCK on D7, DOUTs on D6/D1/D2/D5 (existing spec)
- **New:** 1× WS2812B RGB LED on D4 (GPIO2). Single addressable pixel. Requires `Adafruit_NeoPixel`.
- Power: 5V USB

### LED protocol

| Color           | Meaning                        | Trigger                                       |
| --------------- | ------------------------------ | --------------------------------------------- |
| Off             | Scale idle, no recent activity | >15s since last movement                      |
| Red (solid)     | Settling — weight is changing  | Any sample outside the stability window       |
| Yellow (solid)  | Settling but close to stable   | Within 2× threshold and trending flat         |
| Green (solid)   | Stable — OK to act             | N consecutive samples within stability window |
| Blue (flash)    | Event posted to Pi             | Momentary on each POST                        |
| Magenta (solid) | Error / network down           | Pi unreachable; events queued locally         |

### Pi + camera

- Pi 4 at 192.168.0.181
- USB camera on /dev/video0, locked settings (exposure 1600, focus 50, WB 4000 — already calibrated)
- Existing `fridge-cam` daemon is the base for the Pi app

---

## 3. Data model (SQLite on Pi)

Database file: `hardware/live-shelf/server/data/shelf.sqlite3`

```sql
-- Products (SKU-level catalog)
CREATE TABLE products (
  product_id          TEXT PRIMARY KEY,  -- UUID v7 string
  barcode             TEXT UNIQUE,       -- may be NULL for custom items
  name                TEXT NOT NULL,
  brand               TEXT,
  variant             TEXT,              -- e.g. "strawberry" for yogurt
  net_weight_g        REAL,              -- from label, required for live tracking math
  gross_weight_g      REAL,              -- captured at first placement (sealed)
  tare_weight_g       REAL,              -- derived (gross - net) or measured
  serving_weight_g    REAL,
  servings_per_container REAL,
  unit_type           TEXT CHECK(unit_type IN ('liquid','solid','count','mixed')),
  density_g_per_ml    REAL,              -- optional, for liquid ↔ volume conversions
  container_type      TEXT,              -- 'jar','bottle','can','carton','box','bag','tray','other'
  certified           INTEGER NOT NULL DEFAULT 0,  -- 1 = ready for live shelf
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_products_barcode ON products(barcode);
CREATE INDEX idx_products_certified ON products(certified);

-- Reference images per product (2-3 per product, captured at intake)
CREATE TABLE product_reference_images (
  image_id            TEXT PRIMARY KEY,
  product_id          TEXT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  file_path           TEXT NOT NULL,     -- relative path under data/refs/<product_id>/
  angle               TEXT,              -- 'front','side','top','label','other'
  captured_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ref_images_product ON product_reference_images(product_id);

-- Lots — physical instances. For the demo, only live-shelf lots exist.
CREATE TABLE lots (
  lot_id              TEXT PRIMARY KEY,
  product_id          TEXT NOT NULL REFERENCES products(product_id),
  status              TEXT NOT NULL CHECK(status IN ('on_shelf','out','depleted','relocated','lost')),
  current_weight_g    REAL,              -- last scale reading for this lot
  initial_weight_g    REAL,              -- gross at first placement
  total_consumed_g    REAL NOT NULL DEFAULT 0,
  placed_at           TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_out_at         TEXT,              -- when it left the shelf (if status='out')
  notes               TEXT
);
CREATE INDEX idx_lots_status ON lots(status);
CREATE INDEX idx_lots_product ON lots(product_id);

-- Sessions (door-open → door-close windows)
CREATE TABLE sessions (
  session_id          TEXT PRIMARY KEY,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  initial_shelf_weight_g REAL,
  final_shelf_weight_g   REAL,
  reconciled          INTEGER NOT NULL DEFAULT 0,
  reconciled_at       TEXT
);
CREATE INDEX idx_sessions_ended ON sessions(ended_at);

-- Raw scale events from the ESP
CREATE TABLE scale_events (
  event_id            TEXT PRIMARY KEY,
  session_id          TEXT REFERENCES sessions(session_id),
  ts                  TEXT NOT NULL,
  delta_g             REAL NOT NULL,
  before_weight_g     REAL NOT NULL,
  after_weight_g      REAL NOT NULL,
  direction           TEXT NOT NULL CHECK(direction IN ('add','remove','noise')),
  before_frame_path   TEXT,
  after_frame_path    TEXT,
  classification      TEXT,              -- JSON blob of classifier output
  classifier_status   TEXT CHECK(classifier_status IN ('pending','classified','review','failed')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_scale_events_session ON scale_events(session_id);
CREATE INDEX idx_scale_events_ts ON scale_events(ts);

-- Session-level resolutions (populated by reconciler)
CREATE TABLE session_resolutions (
  resolution_id       TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(session_id),
  lot_id              TEXT REFERENCES lots(lot_id),        -- may be NULL for unknown/new
  pattern             TEXT NOT NULL CHECK(pattern IN (
    'use_return_no_consumption','use_return_consumed','topped_up',
    'consumed_or_removed','new_arrival','swap_out','swap_in',
    'relocation','unknown','no_op'
  )),
  consumed_g          REAL,              -- positive = consumption, negative = addition
  confidence          REAL,
  add_event_id        TEXT REFERENCES scale_events(event_id),
  remove_event_id     TEXT REFERENCES scale_events(event_id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_resolutions_session ON session_resolutions(session_id);

-- Review queue items (human-in-the-loop)
CREATE TABLE review_queue (
  review_id           TEXT PRIMARY KEY,
  kind                TEXT NOT NULL CHECK(kind IN (
    'unknown_item_add','low_confidence','weight_mismatch','unpaired_remove',
    'multi_match','failed_intake','sensor_anomaly'
  )),
  status              TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','dismissed')),
  session_id          TEXT REFERENCES sessions(session_id),
  event_id            TEXT REFERENCES scale_events(event_id),
  resolution_id       TEXT REFERENCES session_resolutions(resolution_id),
  proposed            TEXT,              -- JSON: what the classifier/reconciler thought
  images              TEXT,              -- JSON array of relative file paths
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at         TEXT,
  user_response       TEXT               -- JSON: user correction
);
CREATE INDEX idx_review_status ON review_queue(status);

-- App state (singleton row id=1)
CREATE TABLE app_state (
  id                    INTEGER PRIMARY KEY CHECK(id=1),
  current_session_id    TEXT REFERENCES sessions(session_id),
  last_scale_weight_g   REAL,
  last_scale_event_ts   TEXT,
  door_open             INTEGER NOT NULL DEFAULT 0,
  shelf_name            TEXT NOT NULL DEFAULT 'demo shelf',
  camera_locked_json    TEXT,
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO app_state (id) VALUES (1);
```

---

## 4. Interface contracts

### 4.1 ESP → Pi: `POST /api/scale-event`

Sent by the ESP on every stable→stable transition with `|delta| > delta_threshold_g` (configurable, default 5g).

```json
{
  "ts": "2026-04-15T12:34:56.789Z",
  "device_id": "scale-01",
  "delta_g": -340.5,
  "before_weight_g": 2150.2,
  "after_weight_g": 1809.7,
  "stable_samples": 8,
  "event_seq": 42
}
```

- `ts` is NTP-synced UTC with ms precision
- `event_seq` is a monotonically increasing counter since boot (for dedup on retry)
- Pi responds `200 {"ok": true, "event_id": "..."}`
- On Pi unreachable: ESP queues locally (bounded ~50 events) and retries

### 4.2 ESP → Pi: `POST /api/scale-heartbeat`

Sent every 5 seconds regardless of events. Body:

```json
{
  "device_id": "scale-01",
  "ts": "...",
  "weight_g": 1809.7,
  "stable": true,
  "uptime_s": 12345
}
```

Lets the Pi know the ESP is alive and keeps `app_state.last_scale_weight_g` fresh.

### 4.3 Pi → ESP: LED override (optional, for UI)

`POST http://<esp-ip>/led` with `{"color": "blue", "duration_ms": 200}`. Not critical for demo; firmware has autonomous LED logic. Only used for UI-initiated feedback (e.g., user clicks "identify" in UI → Pi flashes LED so user can spot the live shelf).

### 4.4 Pi-internal module boundaries

Every module exposes typed Python functions. No shared globals beyond a single `AppContext` object passed in at startup.

```python
# storage.py
def init_db(path: str) -> sqlite3.Connection
def create_product(p: ProductIn) -> Product
def get_shelf_registry() -> list[LotWithProduct]
def get_products_certified_not_on_shelf() -> list[Product]
def get_recently_out_lots(window_seconds: int) -> list[LotWithProduct]
def record_scale_event(evt: ScaleEventIn) -> ScaleEvent
def open_session(ts: str, initial_weight_g: float) -> Session
def close_session(session_id: str, ts: str, final_weight_g: float) -> Session
def write_resolution(r: SessionResolutionIn) -> SessionResolution
def enqueue_review(r: ReviewQueueIn) -> ReviewQueueItem
# ... etc

# classifier.py
def classify_event(event: ScaleEvent, context: AppContext) -> ClassificationResult
# ClassificationResult contains: item_id | None, action, confidence, reasoning, candidate_pool_used

# candidate_pool.py
def pool_for_add(shelf_name: str, delta_g: float, ctx: AppContext) -> list[Candidate]
def pool_for_remove(shelf_name: str, delta_g: float, ctx: AppContext) -> list[Candidate]

# reconciler.py
def reconcile_session(session_id: str, ctx: AppContext) -> list[SessionResolution]

# camera.py  (extends existing fridge-cam)
def frame_at(ts: str, offset_seconds: float = 0) -> str   # returns path on disk
def current_frame() -> numpy.ndarray

# intake.py
def lookup_barcode(barcode: str) -> OffProductData
def save_product_from_intake(form: IntakeForm, ref_image_paths: list[str]) -> Product
```

### 4.5 Classifier input/output schemas

**Input (assembled by Pi, sent to Anthropic as a multimodal message):**

- System prompt: declares the classifier's job, instructs it to return strict JSON, lists valid action values
- User message contains, in order:
  1. Before frame image
  2. After frame image
  3. Scale delta as text: `"Weight change: -340g (shelf dropped)"`
  4. Direction-scoped candidate list as JSON. Each candidate:
     ```json
     {
       "candidate_id": "uuid",
       "name": "Heinz Ketchup",
       "brand": "Heinz",
       "expected_weight_g": 340,
       "container_type": "bottle",
       "why_candidate": "currently_on_shelf", // or "recently_out", "in_catalog_not_on_shelf", "top_up_target", "from_other_shelf"
       "reference_images": ["<inline base64 or URL>"]
     }
     ```
  5. Instruction: "Identify which candidate was involved. Return JSON."

**Output (strict JSON):**

```json
{
  "item_id": "<candidate_id>" | "unknown",
  "action": "added" | "removed" | "added_to_existing" | "unknown",
  "confidence": 0.92,
  "reasoning": "The before frame shows the ketchup bottle in front-left position. In after, that position is empty and no other bottle appears rearranged. Weight change of -340g matches the expected ketchup weight.",
  "secondary_candidates": [
    {"candidate_id": "...", "confidence": 0.06}
  ]
}
```

### 4.6 Web UI routes (Flask)

```
GET  /                       dashboard (shelf state, recent events, live preview)
GET  /intake                 intake wizard landing
POST /api/intake/lookup      {barcode} → OFF data
POST /api/intake/capture-ref {} → captures current frame as reference, returns path
POST /api/intake/save        full intake form → creates product + lot
GET  /registry               shelf registry view (currently on-shelf lots)
GET  /events                 paginated scale event list with thumbnails
GET  /event/<id>             event detail with before/after images + classifier output
GET  /sessions               session list
GET  /session/<id>           session detail with timeline of events + resolutions
GET  /review                 review queue list
GET  /review/<id>            review detail with side-by-side images + candidates
POST /review/<id>/resolve    user resolution
GET  /live.mjpg              live camera stream (existing)
POST /api/scale-event        ESP event intake (existing contract)
POST /api/scale-heartbeat    ESP heartbeat
GET  /api/state              current app state
POST /api/config             update config
```

---

## 5. Interaction flows

Every flow is written as a numbered sequence of steps from trigger to commit.

### 5.1 Intake (one-time per product)

1. User opens `/intake` and enters a barcode (typed or from a USB HID scanner)
2. Frontend POSTs `/api/intake/lookup` with barcode
3. Backend hits OpenFoodFacts, returns the data it finds (name, brand, serving size, net weight, unit type guesses)
4. Frontend shows a form pre-populated from OFF; user fills/confirms:
   - name, brand, variant
   - `net_weight_g`, `servings_per_container`, `serving_weight_g`, `unit_type`, `container_type`
5. User places the sealed container on the shelf. UI shows live weight.
6. User taps "Capture reference images" 2-3 times; each tap calls `/api/intake/capture-ref`, which grabs the current frame from the camera and saves it to `data/refs/<temp_id>/<index>.jpg`. UI shows thumbnails.
7. User taps "Finalize intake." Frontend POSTs `/api/intake/save` with the form + image paths + current weight (= `gross_weight_g`).
8. Backend:
   - creates `products` row with `certified=1`
   - creates `product_reference_images` rows
   - creates a `lots` row: `status='on_shelf'`, `initial_weight_g=gross_weight_g`, `current_weight_g=gross_weight_g`
   - if `net_weight_g` is known: computes `tare_weight_g = gross - net` and updates product
9. Shelf registry refreshes; product is now live-trackable.

### 5.2 Session open (door opens)

1. Brightness watcher in existing daemon detects rise above threshold → calls `open_session(ts, current_shelf_weight)`
2. `app_state.door_open=1`, `app_state.current_session_id=<new>`
3. `sessions` row inserted with `initial_shelf_weight_g` from the last scale heartbeat
4. Session recording starts (video file opens, ring buffer continues)

### 5.3 ADD event (single item placed)

User places item, waits for green LED (~1.5s after movement stops), scale stabilizes:

1. ESP detects N consecutive stable samples → POSTs `/api/scale-event` with `delta_g > +threshold`
2. Pi logs raw event: direction = 'add', session_id = current, ts, before/after weights
3. Pi extracts frames from ring buffer:
   - `after_frame_path` = frame closest to `ts`
   - `before_frame_path` = frame at `ts - 2.0s` (before the user's hand entered)
4. Pi assembles ADD candidate pool (see §6.1)
5. Pi calls classifier (§6.3)
6. Result:
   - High confidence (≥0.75) + known candidate → update the matched lot:
     - `status='on_shelf'`, `current_weight_g=after_weight_g`, `last_seen_at=ts`
     - if lot was previously 'out' and weight matches → likely return, but finalize at session reconcile
   - High confidence + "unknown" → enqueue `review_queue` with kind='unknown_item_add'; capture photos for intake
   - Low confidence → enqueue `review_queue` with kind='low_confidence'
7. `scale_events.classification` updated with result JSON
8. Frontend live updates via polling `/api/state` (or via SSE — skip SSE for MVP)

### 5.4 REMOVE event (single or multi-item taken)

Similar to ADD, but candidates are constrained to currently on-shelf lots, and the answer may be multiple items:

1. ESP POSTs `/api/scale-event` with `delta_g < -threshold`
2. Pi logs raw event, extracts before/after frames
3. Pi assembles REMOVE candidate pool = current shelf registry
4. Pi calls classifier. Classifier may return multiple items whose expected weights sum to `|delta|` ±tolerance.
5. For each matched lot:
   - `status='out'`, `last_out_at=ts`
   - (Don't commit consumption yet — that's session reconciliation's job. Just mark as out.)
6. Frontend live updates

### 5.5 Session close (door closes)

1. Brightness watcher detects drop → calls `close_session(ts, current_shelf_weight)`
2. `sessions.ended_at` set, `final_shelf_weight_g` captured
3. Reconciler runs (`reconcile_session(session_id)`):
   a. Fetch all `scale_events` for this session, ordered by ts
   b. Pair REMOVE with ADD events by classifier-identified lot identity
   c. Emit `session_resolutions`:
   - Matched pair: `pattern = use_return_{consumed|no_consumption|topped_up}`, `consumed_g = |remove_delta| - |add_delta|`, `lot_id`, `add_event_id`, `remove_event_id`
   - Unpaired REMOVE: `pattern = consumed_or_removed`, lot stays `status='out'`
   - Unpaired ADD (known candidate): `pattern = new_arrival`, lot created/incremented
   - Unpaired ADD (unknown): already in review queue from step 5.3
   - Swap pattern (REMOVE of A, ADD of B, similar timing, different identities): `pattern = swap_out` + `swap_in`
   - Cross-shelf is out of scope for demo (single shelf)
     d. Weight sanity: `Σ(resolution effects) ≈ (final - initial)` within ±10g tolerance. Discrepancy → enqueue `review_queue` kind='weight_mismatch' with the session ID
     e. For each matched pair, update `lots.current_weight_g = after_weight_g_of_add_event`, increment `total_consumed_g`
4. `sessions.reconciled=1`, `reconciled_at=ts`
5. Dashboard refreshes

### 5.6 Review queue resolution

1. User opens `/review/<id>`
2. UI shows: thumbnails of before/after images, the classifier's proposed answer, list of candidates with reference photos, form to confirm/correct
3. User options by `kind`:
   - `low_confidence`: pick the correct candidate OR "none of these"
   - `unknown_item_add`: complete intake flow inline (fills product fields; reference photos are the before/after + current frame)
   - `weight_mismatch`: mark session as "accept anyway" or "do-over" (no state change)
   - `unpaired_remove`: confirm it left the fridge (mark lot depleted/relocated/consumed)
4. POST `/review/<id>/resolve` with the user's answer
5. Backend applies the correction, writes to `review_queue.user_response`, updates affected lots/resolutions, sets `status='resolved'`

### 5.7 Re-calibration (on demand)

1. User clicks "Recalibrate Camera" on dashboard → runs the existing exposure + focus sweeps → updates locked settings in config
2. User clicks "Rebaseline Scale" → sends tare command to ESP (POST to scale's `/tare`)

---

## 6. Candidate pool assembly rules

The candidate pool is the list the classifier chooses from. Rules below are the single source of truth for what goes in which pool.

### 6.1 ADD pool

Union of the following, deduped by `product_id`:

- **Recently out**: lots with `status='out'` where `last_out_at > now - 24h`, any shelf → tagged `why_candidate='recently_out'`
- **Top-up target**: lots currently `on_shelf` where `|expected_added_weight - add_delta| < 25% of expected` → tagged `why_candidate='top_up_target'`  
  (Only applies when adding to an existing container — expected range is narrow)
- **Certified not-on-shelf**: products with `certified=1` that have NO lot with `status='on_shelf'` → tagged `why_candidate='catalog_not_on_shelf'`
- **Sentinel**: always include `{"candidate_id": "UNKNOWN", "name": "Unknown/new item", "why_candidate": "sentinel"}` so the classifier has a clean escape hatch

Ranking (applied to candidates before sending, keep top 10):

1. `recently_out` items with matching weight first
2. `top_up_target` items
3. `catalog_not_on_shelf` items with matching weight
4. Fallback: remaining items by weight proximity
5. `UNKNOWN` always last

### 6.2 REMOVE pool

- All lots with `status='on_shelf'` on this shelf
- Classifier is told to return 1+ items whose expected weights sum to `|delta|` ±10% OR `"unknown"`
- Ranked by individual weight proximity to `|delta|`

### 6.3 Weight-proximity score

```
score = exp(-(abs(expected_weight - |delta|) / expected_weight)^2 * 4)
```

Just a smooth 0-1 score for ranking. The classifier gets ranks, not raw scores.

---

## 7. Classifier design

### 7.1 Prompt template

```
System:
You are identifying items that moved onto or off of a single shelf based on
before/after images and a weight change. You will be given a ranked list of
candidate items. Pick the single best matching candidate (or "unknown"), plus
an action and a confidence value.

Valid actions:
  - "removed": the item left the shelf
  - "added": the item was newly placed on the shelf
  - "added_to_existing": contents were added to an item already on the shelf (topped up)
  - "unknown": cannot determine confidently

Respond with STRICT JSON matching this schema:
{
  "item_id": string,          // candidate_id or "UNKNOWN"
  "action": string,           // one of the valid actions above
  "confidence": number,       // 0.0 to 1.0
  "reasoning": string,        // one or two sentences
  "multi_match": [             // only for REMOVE events with multi-item pickups
    {"candidate_id": string, "confidence": number}
  ]
}

Do not include any text outside the JSON object.

User:
[image: before frame]
[image: after frame]

Weight change: {delta_g} g ({"shelf gained" if delta_g > 0 else "shelf dropped"})
Event direction: {direction}

Candidates (ranked by likelihood):
{candidate_json}

Identify the item involved. If multiple items of the REMOVE candidate list
together sum to the observed weight change within 10% tolerance and you can
see evidence of each in the frames, return them in "multi_match".
```

### 7.2 Model choice

- Default: `claude-sonnet-4-6` with prompt caching on the candidate list + reference images
- Cheap path: `claude-haiku-4-5` for obvious single-candidate cases (weight uniquely matches one candidate within 5%)
- Escalation: if `confidence < 0.75` on Haiku, re-run with Sonnet

For MVP: start with Sonnet only. Caching keeps per-call cost around $0.003-0.01.

### 7.3 Prompt caching strategy

Cache these together (they stay stable across events in a session):

- System prompt
- Reference images for the current shelf registry
- Candidate list metadata

Cache ephemerally. 5-minute TTL is enough — a session is rarely longer.

Only the per-event deltas + the before/after frames are "fresh" tokens.

---

## 8. Reconciler algorithm

Pseudocode for `reconcile_session(session_id)`:

```python
events = fetch_scale_events(session_id, order_by='ts')
resolutions = []
remaining = list(events)

# Pass 1: pair REMOVEs with ADDs by lot_id
for ev_remove in [e for e in remaining if e.direction == 'remove']:
    remove_class = ev_remove.classification
    if remove_class.item_id in (None, 'unknown'):
        continue
    # Find the next ADD event in this session whose classifier identified the same lot
    for ev_add in [e for e in remaining if e.direction == 'add' and e.ts > ev_remove.ts]:
        add_class = ev_add.classification
        if add_class.item_id == remove_class.item_id:
            consumed = abs(ev_remove.delta_g) - abs(ev_add.delta_g)
            pattern = classify_pair(consumed, ev_remove, ev_add)
            resolutions.append(SessionResolution(
                pattern=pattern,
                lot_id=remove_class.item_id,
                consumed_g=consumed,
                add_event_id=ev_add.event_id,
                remove_event_id=ev_remove.event_id,
                confidence=min(remove_class.confidence, add_class.confidence)
            ))
            remaining.remove(ev_remove)
            remaining.remove(ev_add)
            break

# Pass 2: leftover REMOVEs — the item left for good
for ev in [e for e in remaining if e.direction == 'remove']:
    class_ = ev.classification
    if class_.item_id in (None, 'unknown'):
        resolutions.append(pattern='unknown', ...)  # already in review queue
    else:
        # For multi_match, iterate each
        for match in class_.get('multi_match', [{'candidate_id': class_.item_id, 'confidence': class_.confidence}]):
            resolutions.append(SessionResolution(
                pattern='consumed_or_removed',
                lot_id=match.candidate_id,
                consumed_g=None,  # we don't know; item might come back next session
                remove_event_id=ev.event_id,
                confidence=match.confidence
            ))

# Pass 3: leftover ADDs — new arrival or returning from a previous session
for ev in [e for e in remaining if e.direction == 'add']:
    class_ = ev.classification
    if class_.item_id in (None, 'unknown'):
        # Already in review queue from step 5.3
        continue
    elif class_.item_id == 'UNKNOWN':
        continue
    else:
        # Is this an 'out' lot returning from a prior session?
        lot = get_lot(class_.item_id)
        if lot.status == 'out':
            resolutions.append(SessionResolution(
                pattern='use_return_consumed',  # consumption happened outside the fridge
                lot_id=lot.lot_id,
                consumed_g=max(0, lot.current_weight_g - ev.after_weight_g),
                add_event_id=ev.event_id,
                confidence=class_.confidence
            ))
        else:
            resolutions.append(SessionResolution(
                pattern='new_arrival',
                lot_id=lot.lot_id,
                add_event_id=ev.event_id,
                confidence=class_.confidence
            ))

# Pass 4: weight sanity check
expected_delta = session.final_shelf_weight_g - session.initial_shelf_weight_g
actual_delta = sum(-abs(e.delta_g) if e.direction=='remove' else abs(e.delta_g) for e in events)
if abs(expected_delta - actual_delta) > 10:
    enqueue_review(kind='weight_mismatch', session_id=session.id, ...)

# Commit resolutions + update lots
for r in resolutions:
    write_resolution(r)
    apply_to_lot(r)

session.reconciled = True
```

`classify_pair(consumed, remove_ev, add_ev)`:

- `|consumed| < 5g` → `use_return_no_consumption`
- `consumed > 5g` → `use_return_consumed`
- `consumed < -5g` (item heavier on return) → `topped_up`

---

## 9. ESP firmware spec

### 9.1 Responsibilities

1. 4-cell parallel-read HX711 (existing)
2. EEPROM-persisted calibration (existing)
3. **NEW:** Stability state machine
4. **NEW:** Event detection + POST to Pi
5. **NEW:** LED control (WS2812B via Adafruit_NeoPixel)
6. **NEW:** NTP sync
7. **NEW:** Heartbeat every 5s
8. Existing web UI retained

### 9.2 Stability state machine

Two states: `SETTLING`, `STABLE`.

Parameters (configurable via web UI, persisted to EEPROM):

- `sample_rate_hz` = 10 (HX711 rate)
- `stability_window_g` = 2.0
- `stable_samples_required` = 8 (= 0.8s of continuous stability)
- `near_stable_window_g` = 4.0 (for yellow LED)
- `delta_threshold_g` = 5.0 (min event magnitude)

Logic per new reading `w`:

1. Maintain rolling window of last `stable_samples_required` readings
2. If `max - min < stability_window_g`:
   - State = STABLE
   - If state just transitioned from SETTLING to STABLE:
     - Compute `mean_stable_weight`
     - If `|mean_stable_weight - last_stable_weight| > delta_threshold_g`:
       - Emit event: POST to Pi with before/after and delta
       - Update `last_stable_weight`
3. Else:
   - State = SETTLING
   - If `max - min < near_stable_window_g`: LED = yellow
   - Else: LED = red

### 9.3 Event emission

On stable transition (first reading where we entered STABLE and delta threshold met):

1. Construct event JSON (§4.1)
2. POST to `http://<pi_ip>:8000/api/scale-event` with timeout=2s
3. Flash LED blue for 200ms
4. On failure: push to a local FIFO ring buffer (size=50); retry in order next time POST succeeds; LED magenta while queue non-empty

### 9.4 Heartbeat

Every 5s, POST `/api/scale-heartbeat` with current weight, stable flag, uptime. Failure silently retries; doesn't block main loop.

### 9.5 NTP

Use `NTPClient` library. Resync every 6 hours. All timestamps sent to Pi are ISO 8601 UTC with ms.

### 9.6 Config via web UI

The ESP's existing web UI gains fields for: `pi_url`, `delta_threshold_g`, `stability_window_g`, `stable_samples_required`. Saved to EEPROM.

---

## 10. File layout

```
hardware/live-shelf/
├── docs/
│   └── plan.md                          # this file
├── firmware/
│   ├── scale-live.ino                   # extends scale-test.ino
│   └── README.md
├── server/
│   ├── app.py                           # Flask entry point, orchestrator
│   ├── config.py                        # env + config.json loader
│   ├── storage/
│   │   ├── __init__.py
│   │   ├── schema.sql                   # §3 verbatim
│   │   ├── migrations.py                # run once on boot
│   │   └── repo.py                      # typed CRUD functions
│   ├── camera/
│   │   ├── __init__.py
│   │   ├── daemon.py                    # capture thread + ring buffer + brightness (reuse from fridge-cam)
│   │   ├── extract.py                   # frame_at(ts), current_frame()
│   │   └── locked_settings.py           # applies v4l2 locks on startup
│   ├── intake/
│   │   ├── __init__.py
│   │   ├── off_lookup.py                # OpenFoodFacts
│   │   ├── profile_builder.py           # merges OFF + user input → Product
│   │   └── routes.py                    # Flask blueprint
│   ├── classifier/
│   │   ├── __init__.py
│   │   ├── candidate_pool.py            # §6
│   │   ├── prompt.py                    # §7.1 template
│   │   ├── anthropic_client.py          # SDK wrapper w/ caching
│   │   └── classify.py                  # main classify_event()
│   ├── reconciler/
│   │   ├── __init__.py
│   │   └── reconcile.py                 # §8 algorithm
│   ├── web/
│   │   ├── __init__.py
│   │   ├── routes.py                    # all HTML routes + mjpeg stream
│   │   ├── api_routes.py                # /api/*
│   │   └── templates/
│   │       ├── _base.html
│   │       ├── dashboard.html
│   │       ├── intake.html
│   │       ├── registry.html
│   │       ├── events.html
│   │       ├── event_detail.html
│   │       ├── sessions.html
│   │       ├── session_detail.html
│   │       ├── review_list.html
│   │       └── review_detail.html
│   ├── data/                            # gitignored
│   │   ├── shelf.sqlite3
│   │   ├── refs/<product_id>/*.jpg
│   │   └── events/<event_id>/{before,after}.jpg
│   ├── scripts/
│   │   ├── seed_product.py              # takes a JSON profile, creates product + reference images
│   │   └── demo_reset.py                # wipes DB + refs, keeps camera config
│   ├── requirements.txt
│   └── README.md
└── scripts/
    └── deploy.py                        # paramiko push to Pi (like we've been doing)
```

---

## 11. Parallel agent work breakdown

Interfaces are defined. Each agent picks a bundle and works independently. No bundle depends on a sibling bundle's internals beyond the contracts in this document.

### Bundle A — Storage layer

**Deliverables:** `server/storage/schema.sql`, `server/storage/migrations.py`, `server/storage/repo.py`
**Dependencies:** None. Just §3 of this doc.
**Definition of done:** CRUD tests pass for every table via `pytest server/storage/tests/` (tests included).

### Bundle B — ESP firmware

**Deliverables:** `firmware/scale-live.ino`, `firmware/README.md`
**Dependencies:** §4.1, §4.2, §9 of this doc; no Pi-side code needed.
**Definition of done:** Compiles with Arduino IDE, posts events to a mock endpoint in a smoke test (agent can use `python -m http.server` as mock).

### Bundle C — Camera extensions

**Deliverables:** `server/camera/` module with `frame_at(ts)`, `current_frame()`, `apply_locked_settings()`, extended MJPEG stream
**Dependencies:** §4.6 (MJPEG route), existing fridge-cam daemon code
**Definition of done:** Unit tests with synthetic camera prove frame-at-timestamp returns a frame within 200ms of the requested ts.

### Bundle D — Candidate pool + classifier

**Deliverables:** `server/classifier/` module including prompt builder, Anthropic SDK wrapper with caching, end-to-end `classify_event()`
**Dependencies:** Bundle A's repo interface, §6, §7
**Definition of done:** Unit test with mocked Anthropic responses proves the prompt assembly is correct and response parsing handles valid + malformed outputs. Integration test (skippable if no API key) hits Anthropic with 3 synthetic before/after pairs and logs the output.

### Bundle E — Reconciler

**Deliverables:** `server/reconciler/reconcile.py`, tests
**Dependencies:** Bundle A's repo + the `ClassificationResult` shape from Bundle D
**Definition of done:** Tests cover each of the 10 patterns in `session_resolutions.pattern` using synthetic event sequences.

### Bundle F — Intake

**Deliverables:** `server/intake/` including OFF lookup, profile builder, Flask blueprint, and templates
**Dependencies:** Bundle A's repo, Bundle C's `current_frame()` for reference captures
**Definition of done:** End-to-end: given a mock OFF response + form input + 2 captured frames, creates a product + lot and verifies with direct DB read.

### Bundle G — Web UI (non-intake)

**Deliverables:** All templates except `intake.html` (owned by F), routes in `server/web/`
**Dependencies:** Bundle A for data reads
**Definition of done:** Every route renders for a seeded database with at least one of each entity. Manual walkthrough script included.

### Bundle H — Orchestrator + glue

**Deliverables:** `server/app.py`, `server/config.py`, deploy script, top-level README
**Dependencies:** All other bundles (consumes their public interfaces)
**Definition of done:** `python app.py` starts the full stack and the README's smoke test passes against a clean DB.

### Bundle I — Seed script (post-barcode)

**Deliverables:** `server/scripts/seed_product.py` + a subagent's product profile JSON files in `server/scripts/demo_seeds/`
**Dependencies:** Bundle A, Bundle F (for intake logic reuse), real barcodes from the user
**Definition of done:** Running the script seeds the DB with the demo products and attaches reference images.

---

## 12. Open decisions (confirm before corresponding bundle starts)

| #   | Question                                        | Default (if user doesn't answer)              |
| --- | ----------------------------------------------- | --------------------------------------------- |
| 1   | Cloud inference OK (Anthropic API)?             | Yes — use it                                  |
| 2   | LED type — single WS2812B or two discrete LEDs? | WS2812B on D4                                 |
| 3   | Barcode input — typed or USB HID?               | Typed, with optional USB HID later            |
| 4   | Shelf size / mount                              | Assume flat tray, camera overhead, ~300×200mm |
| 5   | Pi Python version                               | 3.13 (already on Pi)                          |
| 6   | Anthropic API key location                      | `hardware/live-shelf/server/.env`, gitignored |

---

## 13. Demo acceptance criteria

The demo is considered working when, against a fridge with 3-5 certified products on the live shelf:

1. Opening the door triggers a session; LED/dashboard reflects scale state
2. Removing an item triggers a classified REMOVE event within 2s; correct item identified with confidence > 0.8
3. Removing two items at once triggers a REMOVE classified as `multi_match` with both items
4. Placing the item back triggers an ADD event; correct item identified
5. Closing the door triggers session reconciliation; pairs are matched; consumption math is correct within ±5g
6. Placing a new (pre-certified) product on the shelf triggers an ADD classified as `new_arrival`
7. Placing a never-seen product triggers an ADD classified as `unknown`, creates a review queue item, and the intake flow can be completed from the review detail page
8. Weight sanity discrepancies (e.g., if a scale event is dropped) create a review queue item
9. A power-cycle of the Pi resumes state cleanly (SQLite is durable; in-flight sessions either finish or mark themselves as `abandoned`)

---

End of plan. Agents work from this file as the source of truth.
