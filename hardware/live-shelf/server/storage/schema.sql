-- Live Shelf SQLite schema — verbatim from docs/plan.md §3.
-- Applied by migrations.py. Must stay byte-for-byte identical to the spec.

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
  -- Macro + description columns mirror the cloud chefbyte.products shape
  -- so upsert_product_from_cloud can round-trip a full cloud row without
  -- dropping fields. Nullable — the Pi's legacy local-intake path leaves
  -- them blank.
  calories_per_serving REAL,
  carbs_per_serving   REAL,
  protein_per_serving REAL,
  fat_per_serving     REAL,
  description         TEXT,
  certified           INTEGER NOT NULL DEFAULT 0,  -- 1 = ready for live shelf
  -- Soft-delete tombstone mirrored from cloud chefbyte.products.deleted_at.
  -- NULL = live. Hard-delete would break lots.product_id FK (no cascade),
  -- so we filter on this column in list / candidate queries instead.
  deleted_at          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_products_barcode ON products(barcode);
CREATE INDEX idx_products_certified ON products(certified);
CREATE INDEX idx_products_deleted_at ON products(deleted_at);

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
  status              TEXT NOT NULL CHECK(status IN ('on_shelf','in_flight','out','depleted','relocated','lost')),
  current_weight_g    REAL,              -- last scale reading for this lot
  initial_weight_g    REAL,              -- gross at first placement
  total_consumed_g    REAL NOT NULL DEFAULT 0,
  placed_at           TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_out_at         TEXT,              -- when it left the shelf (if status='out')
  notes               TEXT,
  -- In-flight tracker (IN_FLIGHT_TRACKER_PLAN.md §3.1). Non-NULL iff status='in_flight'.
  in_flight_since     TEXT,
  pickup_weight_g     REAL,
  pickup_event_id     TEXT,  -- logical FK to scale_events; not declared to avoid circular DDL
  pickup_session_id   TEXT,  -- logical FK to sessions
  -- Shelf discriminator (CATCH_ALL_SCALE_PLAN.md §4.1). 'live_shelf' =
  -- the door-gated fridge shelf; 'catch_all' = the weight-gated
  -- countertop scale. Defaults to 'live_shelf' for backward compat.
  shelf_id            TEXT NOT NULL DEFAULT 'live_shelf' CHECK(shelf_id IN ('live_shelf','catch_all','single_item')),
  -- Status/in-flight invariant: in_flight_since must be populated iff
  -- status='in_flight'. Catches rogue direct update_lot(status=...) flips
  -- that forget to also clear the in-flight columns, and vice-versa.
  -- Paired with pickup_* nullable columns which the repo helpers
  -- always write together — see mark_lot_in_flight / return_lot_*.
  CHECK((status = 'in_flight') = (in_flight_since IS NOT NULL))
);
CREATE INDEX idx_lots_status ON lots(status);
CREATE INDEX idx_lots_product ON lots(product_id);
CREATE INDEX idx_lots_in_flight_since ON lots(in_flight_since);
CREATE INDEX idx_lots_shelf_status ON lots(shelf_id, status);

-- Sessions (door-open → door-close for live_shelf; weight-above-threshold
-- → weight-returns-to-zero for catch_all).
CREATE TABLE sessions (
  session_id          TEXT PRIMARY KEY,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  initial_shelf_weight_g REAL,
  final_shelf_weight_g   REAL,
  reconciled          INTEGER NOT NULL DEFAULT 0,
  reconciled_at       TEXT,
  -- Shelf discriminator (CATCH_ALL_SCALE_PLAN.md §4.1).
  shelf_id            TEXT NOT NULL DEFAULT 'live_shelf' CHECK(shelf_id IN ('live_shelf','catch_all','single_item'))
);
CREATE INDEX idx_sessions_ended ON sessions(ended_at);
CREATE INDEX idx_sessions_shelf ON sessions(shelf_id);
-- Invariant 7 (cloud batch 20260424090000): at most one OPEN session
-- (ended_at IS NULL) per shelf. SQLite supports partial unique
-- indexes. Consolidation on long-lived DBs is applied in
-- migrations._apply_column_additions.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_open_per_shelf
  ON sessions (shelf_id)
  WHERE ended_at IS NULL;

-- Raw scale events from the ESP
CREATE TABLE scale_events (
  event_id            TEXT PRIMARY KEY,
  session_id          TEXT REFERENCES sessions(session_id),
  ts                  TEXT NOT NULL,
  device_id           TEXT,               -- ESP device that emitted the event (nullable for legacy rows)
  delta_g             REAL NOT NULL,
  before_weight_g     REAL NOT NULL,
  after_weight_g      REAL NOT NULL,
  direction           TEXT NOT NULL CHECK(direction IN ('add','remove','noise')),
  before_frame_path   TEXT,
  after_frame_path    TEXT,
  classification      TEXT,              -- JSON blob of classifier output
  classifier_status   TEXT CHECK(classifier_status IN ('pending','classifying','classified','review','failed')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  -- Shelf discriminator (CATCH_ALL_SCALE_PLAN.md §4.1). Back-filled
  -- from SHELF_REGISTRY at ingress time via device_id → shelf_id lookup.
  shelf_id            TEXT NOT NULL DEFAULT 'live_shelf' CHECK(shelf_id IN ('live_shelf','catch_all','single_item'))
);
CREATE INDEX idx_scale_events_session ON scale_events(session_id);
CREATE INDEX idx_scale_events_ts ON scale_events(ts);
CREATE INDEX idx_scale_events_shelf ON scale_events(shelf_id);

-- Session-level resolutions (populated by reconciler)
CREATE TABLE session_resolutions (
  resolution_id       TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(session_id),
  lot_id              TEXT REFERENCES lots(lot_id),        -- may be NULL for unknown/new
  pattern             TEXT NOT NULL CHECK(pattern IN (
    'use_return_no_consumption','use_return_consumed','topped_up',
    'consumed_or_removed','new_arrival','swap_out','swap_in',
    'relocation','unknown','no_op',
    'in_flight_pickup','in_flight_return',
    'in_flight_replaced_new_item','in_flight_ttl_expired'
  )),
  consumed_g          REAL,              -- positive = consumption, negative = addition
  confidence          REAL,
  add_event_id        TEXT REFERENCES scale_events(event_id),
  remove_event_id     TEXT REFERENCES scale_events(event_id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_resolutions_session ON session_resolutions(session_id);

-- Usage log (USAGE_LOG_PLAN.md). Append-only consumption history —
-- one row per in-flight return / TTL expiry / replacement / reconciler
-- use-return. Denormalised product fields are frozen at log time so
-- renaming a product later doesn't change history.
CREATE TABLE usage_log (
  usage_id            TEXT PRIMARY KEY,
  lot_id              TEXT REFERENCES lots(lot_id),
  product_id          TEXT NOT NULL REFERENCES products(product_id),
  product_name        TEXT NOT NULL,
  product_brand       TEXT,
  container_type      TEXT,
  consumed_g          REAL NOT NULL,
  pickup_weight_g     REAL,
  return_weight_g     REAL,
  kind                TEXT NOT NULL CHECK(kind IN (
    'in_flight_return',
    'in_flight_ttl_expired',
    'in_flight_replaced_new_item',
    'reconciler_use_return',
    'single_item_consumed'
  )),
  session_id          TEXT REFERENCES sessions(session_id),
  pickup_event_id     TEXT,
  return_event_id     TEXT,
  occurred_at         TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_usage_log_occurred_at ON usage_log(occurred_at);
CREATE INDEX idx_usage_log_product    ON usage_log(product_id);
CREATE INDEX idx_usage_log_session    ON usage_log(session_id);
CREATE INDEX idx_usage_log_lot        ON usage_log(lot_id);
-- Idempotency guard: one usage_log row per pickup event (whichever kind).
-- SQLite's UNIQUE ignores NULL comparisons, so rows without a pickup
-- event_id (shouldn't happen in practice but we accept NULL for
-- backfill fallback) can coexist.
CREATE UNIQUE INDEX idx_usage_log_pickup_dedup
  ON usage_log(pickup_event_id)
  WHERE pickup_event_id IS NOT NULL;
-- Idempotency guard #2: one usage_log row per (return_event_id, lot_id, kind).
-- The pickup-side guard above misses the actual duplicate vector observed
-- on the live Pi: the self-heal scanner + history backfill re-emit the
-- SAME return event for the same lot on every restart, producing N
-- "Pulled <product> Ng return" rows that share return_event_id but each
-- carry a fresh pickup_event_id (or NULL pickup_event_id from the reaper
-- path). The pickup-side index can't catch those because the column
-- value differs row-to-row. Keying the dedup on (return_event_id, lot_id,
-- kind) exactly matches the row a re-emission would write. UX_AUDIT R2 F2.
CREATE UNIQUE INDEX idx_usage_log_return_dedup
  ON usage_log(return_event_id, lot_id, kind)
  WHERE return_event_id IS NOT NULL;

-- Scale → product pairings (single-item tracker scales auto-register on
-- first heartbeat; operator assigns a product via the /inventory UI.
-- Live-shelf + catch-all scales are also represented for a unified
-- "scales" listing, but their pairing is system-configured — not
-- user-assigned. Keyed by ESP device_id.
CREATE TABLE scale_pairings (
  device_id           TEXT PRIMARY KEY,
  shelf_id            TEXT NOT NULL CHECK(shelf_id IN ('live_shelf','catch_all','single_item')),
  product_id          TEXT REFERENCES products(product_id) ON DELETE SET NULL,
  lot_id              TEXT REFERENCES lots(lot_id) ON DELETE SET NULL,
  first_seen_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat_ts   TEXT,
  notes               TEXT
);
CREATE INDEX idx_scale_pairings_shelf ON scale_pairings(shelf_id);
CREATE INDEX idx_scale_pairings_product ON scale_pairings(product_id);

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
  -- Per-shelf open-session pointer for the catch-all scale
  -- (CATCH_ALL_SCALE_PLAN.md §4.2). current_session_id remains the
  -- live-shelf pointer for backward compat.
  current_catch_all_session_id TEXT REFERENCES sessions(session_id),
  last_scale_weight_g   REAL,
  last_scale_event_ts   TEXT,
  door_open             INTEGER NOT NULL DEFAULT 0,
  shelf_name            TEXT NOT NULL DEFAULT 'demo shelf',
  camera_locked_json    TEXT,
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO app_state (id) VALUES (1);

-- Event lifecycle log — one row per state transition of a scale event.
-- No hard FK on event_id so wipes of scale_events don't cascade-nuke
-- the audit trail (we retain it for forensic timelines).
CREATE TABLE event_lifecycle (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL,
  ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor           TEXT NOT NULL,
  reason_code     TEXT NOT NULL,
  payload_json    TEXT
);
CREATE INDEX idx_event_lifecycle_event ON event_lifecycle(event_id);
CREATE INDEX idx_event_lifecycle_reason_ts ON event_lifecycle(reason_code, ts);

-- Session lifecycle log — parallel to event_lifecycle, keyed by session_id.
CREATE TABLE session_lifecycle (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor           TEXT NOT NULL,
  reason_code     TEXT NOT NULL,
  payload_json    TEXT
);
CREATE INDEX idx_session_lifecycle_session ON session_lifecycle(session_id);
CREATE INDEX idx_session_lifecycle_reason_ts ON session_lifecycle(reason_code, ts);

-- Cloud outbox (PROD_MIGRATION_PLAN.md §Phase 2). Events the Pi couldn't
-- deliver to the Supabase shelf-ingest edge function are parked here
-- and drained by the background CloudWorker. client_event_id is a
-- UUID4 stamped into the payload before serialization; the cloud
-- dedupes on it so a retry after an ambiguous network timeout is
-- idempotent. Partial index keeps the worker's "list_pending" cheap.
CREATE TABLE cloud_outbox (
  outbox_id             INTEGER PRIMARY KEY AUTOINCREMENT,
  client_event_id       TEXT NOT NULL UNIQUE,
  payload_json          TEXT NOT NULL,
  enqueued_at           TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at               TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  -- Permanent-failure flag: rows we've given up on delivering to the
  -- cloud (e.g. cloud returned 400/404/409/422 — a shape/dedupe
  -- rejection that will never succeed on retry). Pulled out of the
  -- pending-scan so the worker stops beating on them, but the row
  -- stays in the table as an audit trail. Operators can bulk-clear
  -- by ``UPDATE cloud_outbox SET failed_permanently = 0`` after
  -- fixing upstream.
  failed_permanently    INTEGER NOT NULL DEFAULT 0
);
-- Partial index on ``outbox_id`` (not ``sent_at``) so SQLite can satisfy
-- the worker's ``WHERE sent_at IS NULL AND failed_permanently = 0
-- ORDER BY outbox_id ASC`` scan directly from the index without a
-- sort step. The earlier ``(sent_at)`` form matched the predicate
-- but forced a filesort on every drain — fine when pending is small,
-- but a full table scan during a long offline buffer flush.
-- Migration drops the old shape before recreating.
CREATE INDEX cloud_outbox_pending_idx
  ON cloud_outbox (outbox_id)
  WHERE sent_at IS NULL AND failed_permanently = 0;

-- Periodic system health snapshot (60s cadence). Operators and post-hoc
-- debugging lean on this to correlate UI symptoms with queue sizes.
CREATE TABLE system_health (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  scale_weight_g           REAL,
  pending_events           INTEGER,
  classifying_events       INTEGER,
  failed_events            INTEGER,
  pending_reviews          INTEGER,
  on_shelf_lot_count       INTEGER,
  on_shelf_weight_sum_g    REAL,
  closed_deque_size        INTEGER,
  anthropic_calls_total    INTEGER,
  anthropic_errors_total   INTEGER
);
CREATE INDEX idx_system_health_ts ON system_health(ts);
