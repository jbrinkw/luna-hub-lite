-- schema_v1.sql — Pi SQLite schema BEFORE _apply_column_additions migrations.
--
-- This is the canonical "old DB" starting state used by migration tests to
-- verify that _apply_column_additions upgrades a real historical schema shape
-- (not a hand-rolled approximation that can drift silently).
--
-- Finding 8-A (MOCK_AUDIT_PI_WEB_CLASSIFIER.md): replaced hand-built CREATE
-- TABLE strings in _make_old_schema_conn() with this committed fixture so
-- future schema additions are explicitly reflected here and test drift is
-- caught at review time.
--
-- The v1 shape corresponds to the schema BEFORE any of the following
-- migrations were applied:
--   * in_flight_since / pickup_* columns on lots
--   * shelf_id column on lots / sessions / scale_events
--   * 'classifying' added to scale_events.classifier_status CHECK
--   * device_id / pi_received_ts on scale_events
--   * macro columns on products
--   * usage_log table
--   * cloud_outbox table
--   * invariant partial unique index on sessions
--
-- To regenerate: spin up a fresh Pi DB from commit [pre-in-flight], export
-- the schema with `sqlite3 live_shelf.db .schema`, strip the data rows, and
-- commit here.

CREATE TABLE products (
  product_id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE lots (
  lot_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(product_id),
  status TEXT NOT NULL
);

-- OLD scale_events: 'classifying' absent from CHECK, no device_id, no
-- pi_received_ts, no shelf_id.
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
  classification      TEXT,
  classifier_status   TEXT CHECK(classifier_status IN ('pending','classified','review','failed')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE session_resolutions (
  resolution_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  lot_id TEXT REFERENCES lots(lot_id),
  pattern TEXT NOT NULL,
  add_event_id TEXT REFERENCES scale_events(event_id),
  remove_event_id TEXT REFERENCES scale_events(event_id)
);

CREATE TABLE review_queue (
  review_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  event_id TEXT REFERENCES scale_events(event_id)
);
