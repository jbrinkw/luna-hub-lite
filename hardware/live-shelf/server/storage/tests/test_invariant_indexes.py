"""Tests for cloud-batch invariant #7 (sessions one-open-per-shelf) and
the explanatory notes for invariant #8 (tare_arm singleton).

Invariant #7:
  * Fresh DB from schema.sql has the ``sessions_one_open_per_shelf``
    partial unique index.
  * Long-lived DBs that predate the index pick it up via the
    migrations pre-scan pass (``_apply_column_additions``).
  * Pre-scan closes stray extras (newest started_at wins), keeping a
    single open row per shelf_id.
  * Post-index insert of a second OPEN row on the same shelf raises
    ``sqlite3.IntegrityError`` (UNIQUE constraint failed).
  * A CLOSED row (ended_at IS NOT NULL) may coexist with the one
    OPEN row — the partial WHERE excludes it.

Invariant #8:
  * tare_arm enforces a STRICTLY STRONGER invariant via
    ``CHECK(id = 1)`` — only one row ever. The spec's proposed
    partial unique on (device_id, scale_id) WHERE disarmed_at IS
    NULL does not apply because neither ``scale_id`` nor
    ``disarmed_at`` columns exist in this schema. We assert the
    existing singleton guarantee instead.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.storage.migrations import (  # noqa: E402
    _apply_column_additions,
    apply_migrations,
    init_db,
)


# ---------------------------------------------------------------------------
# Invariant 7: sessions_one_open_per_shelf
# ---------------------------------------------------------------------------


def _fresh_schema_conn() -> sqlite3.Connection:
    """Apply schema.sql via ``apply_migrations`` to a blank in-memory DB."""
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    apply_migrations(conn)
    return conn


def test_fresh_schema_has_sessions_one_open_per_shelf_index():
    """A DB created from schema.sql must carry the partial unique index."""
    conn = _fresh_schema_conn()
    row = conn.execute(
        "SELECT name, tbl_name, sql FROM sqlite_master "
        "WHERE type = 'index' AND name = 'sessions_one_open_per_shelf'"
    ).fetchone()
    assert row is not None, (
        "sessions_one_open_per_shelf partial unique index missing "
        "from fresh schema"
    )
    assert row["tbl_name"] == "sessions"
    # The WHERE clause must be present, else we have a plain unique
    # (which would also reject CLOSED rows with the same shelf_id
    # — that's NOT what we want).
    assert "WHERE ended_at IS NULL" in (row["sql"] or "")


def test_second_open_session_on_same_shelf_rejected():
    """After the index exists, a second OPEN row on the same shelf
    must raise ``IntegrityError: UNIQUE constraint failed``."""
    conn = _fresh_schema_conn()
    conn.execute(
        "INSERT INTO sessions (session_id, started_at, shelf_id) "
        "VALUES ('s1', '2026-04-24T10:00:00Z', 'live_shelf')"
    )
    with pytest.raises(sqlite3.IntegrityError) as excinfo:
        conn.execute(
            "INSERT INTO sessions (session_id, started_at, shelf_id) "
            "VALUES ('s2', '2026-04-24T10:05:00Z', 'live_shelf')"
        )
    assert "UNIQUE" in str(excinfo.value).upper() or "unique" in str(excinfo.value)


def test_closed_session_coexists_with_open_session():
    """A CLOSED session (ended_at IS NOT NULL) may share shelf_id
    with a single OPEN session — the partial WHERE excludes it."""
    conn = _fresh_schema_conn()
    conn.execute(
        "INSERT INTO sessions (session_id, started_at, ended_at, shelf_id) "
        "VALUES ('closed_1', '2026-04-24T09:00:00Z', '2026-04-24T09:30:00Z', 'live_shelf')"
    )
    conn.execute(
        "INSERT INTO sessions (session_id, started_at, ended_at, shelf_id) "
        "VALUES ('closed_2', '2026-04-24T09:31:00Z', '2026-04-24T09:45:00Z', 'live_shelf')"
    )
    # Now one open
    conn.execute(
        "INSERT INTO sessions (session_id, started_at, shelf_id) "
        "VALUES ('open_1', '2026-04-24T10:00:00Z', 'live_shelf')"
    )
    rows = conn.execute(
        "SELECT COUNT(*) AS c FROM sessions WHERE shelf_id = 'live_shelf'"
    ).fetchone()
    assert rows["c"] == 3


def test_different_shelves_each_get_one_open():
    """Two different shelf_ids each carry their own OPEN session."""
    conn = _fresh_schema_conn()
    conn.execute(
        "INSERT INTO sessions (session_id, started_at, shelf_id) "
        "VALUES ('s_live', '2026-04-24T10:00:00Z', 'live_shelf')"
    )
    conn.execute(
        "INSERT INTO sessions (session_id, started_at, shelf_id) "
        "VALUES ('s_catch', '2026-04-24T10:01:00Z', 'catch_all')"
    )
    conn.execute(
        "INSERT INTO sessions (session_id, started_at, shelf_id) "
        "VALUES ('s_single', '2026-04-24T10:02:00Z', 'single_item')"
    )
    rows = conn.execute(
        "SELECT COUNT(*) AS c FROM sessions WHERE ended_at IS NULL"
    ).fetchone()
    assert rows["c"] == 3


def _old_db_without_invariant_index() -> sqlite3.Connection:
    """Simulate a long-lived on-disk DB that predates the invariant
    index. Has the current table shape but no partial unique index.
    """
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # Minimal schema sufficient for _apply_column_additions to run:
    # products, sessions, lots, scale_events, session_resolutions,
    # review_queue, app_state — mirror the CHECK-evolution tests.
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
          reconciled_at TEXT,
          shelf_id TEXT NOT NULL DEFAULT 'live_shelf'
            CHECK(shelf_id IN ('live_shelf','catch_all','single_item'))
        );
        CREATE TABLE lots (
          lot_id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(product_id),
          status TEXT NOT NULL CHECK(status IN ('on_shelf','in_flight','out','depleted','relocated','lost')),
          total_consumed_g REAL NOT NULL DEFAULT 0,
          in_flight_since TEXT,
          shelf_id TEXT NOT NULL DEFAULT 'live_shelf'
            CHECK(shelf_id IN ('live_shelf','catch_all','single_item')),
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
          classifier_status TEXT CHECK(classifier_status IN ('pending','classifying','classified','review','failed')),
          shelf_id TEXT NOT NULL DEFAULT 'live_shelf'
            CHECK(shelf_id IN ('live_shelf','catch_all','single_item'))
        );
        CREATE TABLE session_resolutions (
          resolution_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(session_id),
          lot_id TEXT REFERENCES lots(lot_id),
          pattern TEXT NOT NULL CHECK(pattern IN (
            'use_return_no_consumption','use_return_consumed','topped_up',
            'consumed_or_removed','new_arrival','swap_out','swap_in',
            'relocation','unknown','no_op',
            'in_flight_pickup','in_flight_return',
            'in_flight_replaced_new_item','in_flight_ttl_expired'
          )),
          add_event_id TEXT REFERENCES scale_events(event_id),
          remove_event_id TEXT REFERENCES scale_events(event_id)
        );
        CREATE TABLE review_queue (
          review_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          event_id TEXT REFERENCES scale_events(event_id)
        );
        CREATE TABLE app_state (
          id INTEGER PRIMARY KEY CHECK(id = 1)
        );
        INSERT INTO app_state (id) VALUES (1);
        """
    )
    return conn


def test_pre_scan_closes_extras_then_creates_index():
    """Long-lived DB with two OPEN rows on the same shelf: pre-scan
    must close the oldest, keep the newest, then create the index."""
    conn = _old_db_without_invariant_index()

    # Seed two OPEN sessions on 'live_shelf' (plus a CLOSED one that
    # must stay put) and one OPEN session on 'catch_all'.
    conn.executemany(
        "INSERT INTO sessions (session_id, started_at, ended_at, shelf_id) "
        "VALUES (?, ?, ?, ?)",
        [
            # live_shelf: three OPEN, one CLOSED
            ("live_old", "2026-04-24T08:00:00Z", None, "live_shelf"),
            ("live_mid", "2026-04-24T09:00:00Z", None, "live_shelf"),
            ("live_new", "2026-04-24T10:00:00Z", None, "live_shelf"),
            ("live_closed", "2026-04-24T07:00:00Z", "2026-04-24T07:30:00Z", "live_shelf"),
            # catch_all: one OPEN (no consolidation needed)
            ("catch_one", "2026-04-24T10:00:00Z", None, "catch_all"),
        ],
    )
    conn.commit()

    # Pre-scan validation: no invariant yet, so these all coexist.
    open_count = conn.execute(
        "SELECT COUNT(*) AS c FROM sessions "
        "WHERE shelf_id = 'live_shelf' AND ended_at IS NULL"
    ).fetchone()["c"]
    assert open_count == 3

    # Run migrations — should close the 2 older 'live_shelf' rows and
    # land the partial unique index.
    _apply_column_additions(conn)

    # After pre-scan: exactly ONE OPEN row on 'live_shelf', the newest.
    open_rows = conn.execute(
        "SELECT session_id, ended_at FROM sessions "
        "WHERE shelf_id = 'live_shelf' AND ended_at IS NULL "
        "ORDER BY started_at"
    ).fetchall()
    assert len(open_rows) == 1
    assert open_rows[0]["session_id"] == "live_new"

    # The two stray opens got closed with ended_at = started_at + 1s.
    closed_rows = conn.execute(
        "SELECT session_id, started_at, ended_at, reconciled "
        "FROM sessions "
        "WHERE session_id IN ('live_old','live_mid') "
        "ORDER BY session_id"
    ).fetchall()
    assert len(closed_rows) == 2
    for row in closed_rows:
        assert row["ended_at"] is not None
        # started_at + 1s, SQLite format: "YYYY-MM-DD HH:MM:SS"
        assert row["reconciled"] == 1

    # The pre-existing closed row is untouched.
    orig_closed = conn.execute(
        "SELECT ended_at FROM sessions WHERE session_id = 'live_closed'"
    ).fetchone()
    assert orig_closed["ended_at"] == "2026-04-24T07:30:00Z"

    # The catch_all OPEN survives.
    catch_open = conn.execute(
        "SELECT ended_at FROM sessions WHERE session_id = 'catch_one'"
    ).fetchone()
    assert catch_open["ended_at"] is None

    # Index is now present.
    idx = conn.execute(
        "SELECT sql FROM sqlite_master "
        "WHERE type = 'index' AND name = 'sessions_one_open_per_shelf'"
    ).fetchone()
    assert idx is not None
    assert "WHERE ended_at IS NULL" in (idx["sql"] or "")

    # Post-migration: second insert now rejected.
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO sessions (session_id, started_at, shelf_id) "
            "VALUES ('live_second', '2026-04-24T11:00:00Z', 'live_shelf')"
        )


def test_migrations_idempotent_on_already_invariant_db():
    """Running _apply_column_additions twice must not raise."""
    conn = _fresh_schema_conn()
    # Should be a no-op — index already exists.
    _apply_column_additions(conn)
    # And still present.
    idx = conn.execute(
        "SELECT name FROM sqlite_master "
        "WHERE type = 'index' AND name = 'sessions_one_open_per_shelf'"
    ).fetchone()
    assert idx is not None


# ---------------------------------------------------------------------------
# Invariant 8 (documentation-only): tare_arm singleton
# ---------------------------------------------------------------------------


def test_tare_arm_singleton_enforces_stronger_invariant():
    """tare_arm uses ``CHECK(id = 1)`` which is strictly stronger than
    the spec's proposed partial unique on (device_id, scale_id). Only
    one row can ever exist; re-arming is INSERT OR REPLACE into id=1.
    """
    conn = _fresh_schema_conn()

    # Seed a product so the FK is satisfied.
    conn.execute(
        "INSERT INTO products (product_id, name) VALUES ('p1', 'Milk')"
    )

    # First arm: succeeds.
    conn.execute(
        """
        INSERT INTO tare_arm (
            id, product_id, expires_at, min_weight_g, max_weight_g
        ) VALUES (1, 'p1', datetime('now', '+5 minutes'), 5.0, 5000.0)
        """
    )

    # Attempting id=2: rejected by CHECK(id = 1).
    with pytest.raises(sqlite3.IntegrityError) as excinfo:
        conn.execute(
            """
            INSERT INTO tare_arm (
                id, product_id, expires_at
            ) VALUES (2, 'p1', datetime('now', '+5 minutes'))
            """
        )
    # SQLite reports this as a CHECK constraint failure.
    assert "CHECK" in str(excinfo.value).upper() or "check" in str(excinfo.value)

    # Second arm via INSERT OR REPLACE id=1: succeeds (singleton pattern).
    conn.execute(
        """
        INSERT OR REPLACE INTO tare_arm (
            id, product_id, expires_at, min_weight_g, max_weight_g
        ) VALUES (1, 'p1', datetime('now', '+10 minutes'), 10.0, 4000.0)
        """
    )

    # Still exactly one row.
    count = conn.execute("SELECT COUNT(*) AS c FROM tare_arm").fetchone()["c"]
    assert count == 1
