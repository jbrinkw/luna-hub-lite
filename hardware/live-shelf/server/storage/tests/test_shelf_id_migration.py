"""Migration tests for the catch-all shelf_id discriminator
(CATCH_ALL_SCALE_PLAN.md §4.1, §9)."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.storage import init_db  # noqa: E402
from server.storage.migrations import _apply_column_additions  # noqa: E402


# ---------------------------------------------------------------------------
# Fresh-DB schema has the shelf_id columns + CHECKs + indexes
# ---------------------------------------------------------------------------


def test_fresh_db_has_shelf_id_on_lots_sessions_scale_events():
    conn = init_db(":memory:")
    for table in ("lots", "sessions", "scale_events"):
        cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
        assert "shelf_id" in cols, f"{table}.shelf_id missing on fresh DB"


def test_fresh_db_has_current_catch_all_session_id_on_app_state():
    conn = init_db(":memory:")
    cols = [r[1] for r in conn.execute("PRAGMA table_info(app_state)")]
    assert "current_catch_all_session_id" in cols


def test_fresh_db_has_shelf_id_indexes():
    conn = init_db(":memory:")
    idx_names = {
        r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index'"
        )
    }
    assert "idx_lots_shelf_status" in idx_names
    assert "idx_sessions_shelf" in idx_names
    assert "idx_scale_events_shelf" in idx_names


def test_fresh_db_shelf_id_check_rejects_unknown_value():
    conn = init_db(":memory:")
    conn.execute(
        "INSERT INTO products (product_id, name) VALUES (?, ?)",
        ("p1", "ketchup"),
    )
    # CHECK should reject an unknown shelf_id literal.
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO lots (lot_id, product_id, status, shelf_id) "
            "VALUES (?, ?, ?, ?)",
            ("rogue-1", "p1", "on_shelf", "my_other_shelf"),
        )


def test_fresh_db_shelf_id_default_is_live_shelf():
    conn = init_db(":memory:")
    conn.execute(
        "INSERT INTO products (product_id, name) VALUES (?, ?)",
        ("p1", "ketchup"),
    )
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status) VALUES (?, ?, ?)",
        ("l1", "p1", "on_shelf"),
    )
    shelf = conn.execute(
        "SELECT shelf_id FROM lots WHERE lot_id = 'l1'"
    ).fetchone()[0]
    assert shelf == "live_shelf"


# ---------------------------------------------------------------------------
# Migration on an existing DB without shelf_id
# ---------------------------------------------------------------------------


def _make_pre_shelf_conn() -> sqlite3.Connection:
    """Build an in-memory DB that has the in-flight columns + CHECK but
    NOT the shelf_id column. Simulates a DB migrated through the
    in-flight feature but not the catch-all feature."""
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(
        """
        CREATE TABLE products (
          product_id TEXT PRIMARY KEY,
          name TEXT NOT NULL
        );
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          initial_shelf_weight_g REAL,
          final_shelf_weight_g REAL,
          reconciled INTEGER NOT NULL DEFAULT 0,
          reconciled_at TEXT
        );
        CREATE TABLE lots (
          lot_id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(product_id),
          status TEXT NOT NULL CHECK(status IN
            ('on_shelf','in_flight','out','depleted','relocated','lost')),
          current_weight_g REAL,
          initial_weight_g REAL,
          total_consumed_g REAL NOT NULL DEFAULT 0,
          placed_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_out_at TEXT,
          notes TEXT,
          in_flight_since TEXT,
          pickup_weight_g REAL,
          pickup_event_id TEXT,
          pickup_session_id TEXT,
          CHECK((status = 'in_flight') = (in_flight_since IS NOT NULL))
        );
        CREATE TABLE scale_events (
          event_id TEXT PRIMARY KEY,
          session_id TEXT REFERENCES sessions(session_id),
          ts TEXT NOT NULL,
          device_id TEXT,
          delta_g REAL NOT NULL,
          before_weight_g REAL NOT NULL,
          after_weight_g REAL NOT NULL,
          direction TEXT NOT NULL CHECK(direction IN ('add','remove','noise')),
          before_frame_path TEXT,
          after_frame_path TEXT,
          classification TEXT,
          classifier_status TEXT CHECK(classifier_status IN
            ('pending','classifying','classified','review','failed')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE session_resolutions (
          resolution_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(session_id),
          lot_id TEXT REFERENCES lots(lot_id),
          pattern TEXT NOT NULL CHECK(pattern IN
            ('use_return_no_consumption','use_return_consumed','topped_up',
             'consumed_or_removed','new_arrival','swap_out','swap_in',
             'relocation','unknown','no_op',
             'in_flight_pickup','in_flight_return',
             'in_flight_replaced_new_item','in_flight_ttl_expired')),
          consumed_g REAL,
          confidence REAL,
          add_event_id TEXT REFERENCES scale_events(event_id),
          remove_event_id TEXT REFERENCES scale_events(event_id),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE review_queue (
          review_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          event_id TEXT REFERENCES scale_events(event_id)
        );
        CREATE TABLE app_state (
          id INTEGER PRIMARY KEY CHECK(id=1),
          current_session_id TEXT,
          last_scale_weight_g REAL,
          last_scale_event_ts TEXT,
          door_open INTEGER NOT NULL DEFAULT 0,
          shelf_name TEXT NOT NULL DEFAULT 'demo shelf',
          camera_locked_json TEXT,
          updated_at TEXT
        );
        INSERT INTO app_state (id) VALUES (1);
        """
    )
    return conn


def test_migration_adds_shelf_id_and_backfills_live_shelf_on_lots():
    conn = _make_pre_shelf_conn()
    conn.execute("INSERT INTO products (product_id, name) VALUES ('p1', 'k')")
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, current_weight_g) "
        "VALUES (?, ?, ?, ?)",
        ("L1", "p1", "on_shelf", 300.0),
    )
    conn.commit()

    _apply_column_additions(conn)

    cols = [r[1] for r in conn.execute("PRAGMA table_info(lots)")]
    assert "shelf_id" in cols
    row = conn.execute(
        "SELECT shelf_id FROM lots WHERE lot_id='L1'"
    ).fetchone()
    assert row[0] == "live_shelf"


def test_migration_adds_shelf_id_check_via_rebuild():
    conn = _make_pre_shelf_conn()
    _apply_column_additions(conn)
    ddl = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='lots'"
    ).fetchone()[0]
    assert "shelf_id IN ('live_shelf','catch_all')" in ddl
    # Same CHECK on sessions and scale_events after migration.
    for table in ("sessions", "scale_events"):
        t_ddl = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
            (table,),
        ).fetchone()[0]
        assert "shelf_id IN ('live_shelf','catch_all')" in t_ddl, (
            f"{table} missing shelf_id CHECK"
        )


def test_migration_preserves_existing_rows_when_adding_shelf_id():
    conn = _make_pre_shelf_conn()
    conn.execute("INSERT INTO products (product_id, name) VALUES ('p1', 'k')")
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, current_weight_g, "
        "in_flight_since, pickup_weight_g) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        ("L1", "p1", "in_flight", 300.0, "2026-04-17T12:00:00Z", 300.0),
    )
    conn.execute(
        "INSERT INTO sessions (session_id, started_at, initial_shelf_weight_g) "
        "VALUES (?, ?, ?)",
        ("S1", "2026-04-17T11:00:00Z", 500.0),
    )
    conn.execute(
        "INSERT INTO scale_events "
        "(event_id, session_id, ts, delta_g, before_weight_g, after_weight_g, "
        " direction) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("E1", "S1", "2026-04-17T11:01:00Z", -300.0, 500.0, 200.0, "remove"),
    )
    conn.commit()

    _apply_column_additions(conn)

    # Every pre-migration row is preserved and back-filled to live_shelf.
    for table, expected_id in (("lots", "L1"), ("sessions", "S1"), ("scale_events", "E1")):
        id_col = {"lots": "lot_id", "sessions": "session_id", "scale_events": "event_id"}[table]
        row = conn.execute(
            f"SELECT {id_col}, shelf_id FROM {table}"
        ).fetchone()
        assert row[0] == expected_id
        assert row[1] == "live_shelf"

    # In-flight columns on the migrated lot are preserved.
    lot_row = conn.execute(
        "SELECT in_flight_since, pickup_weight_g FROM lots WHERE lot_id='L1'"
    ).fetchone()
    assert lot_row[0] == "2026-04-17T12:00:00Z"
    assert lot_row[1] == 300.0


def test_migration_adds_current_catch_all_session_id_on_app_state():
    conn = _make_pre_shelf_conn()
    _apply_column_additions(conn)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(app_state)")]
    assert "current_catch_all_session_id" in cols


def test_migration_is_idempotent():
    conn = _make_pre_shelf_conn()
    _apply_column_additions(conn)
    _apply_column_additions(conn)
    _apply_column_additions(conn)
    # Shelf_id CHECK present once per table (sanity: DDL not duplicated).
    for table in ("lots", "sessions", "scale_events"):
        ddl = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
            (table,),
        ).fetchone()[0]
        assert ddl.count("shelf_id IN ('live_shelf','catch_all')") == 1


def test_migration_catch_all_literal_accepted():
    """Post-migration, inserting a lot with shelf_id='catch_all' works."""
    conn = _make_pre_shelf_conn()
    conn.execute("INSERT INTO products (product_id, name) VALUES ('p1', 'k')")
    _apply_column_additions(conn)
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, shelf_id) "
        "VALUES (?, ?, ?, ?)",
        ("L1", "p1", "on_shelf", "catch_all"),
    )
    shelf = conn.execute(
        "SELECT shelf_id FROM lots WHERE lot_id='L1'"
    ).fetchone()[0]
    assert shelf == "catch_all"
