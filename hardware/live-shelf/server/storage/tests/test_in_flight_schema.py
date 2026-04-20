"""Schema + repo tests for in-flight tracker (IN_FLIGHT_TRACKER_PLAN.md §3, §6).

Covers:
  * column additions via _apply_column_additions on an old DB
  * lot status CHECK rebuild to include 'in_flight'
  * session_resolutions pattern CHECK rebuild for the 4 new in-flight patterns
  * repo helpers: mark_lot_in_flight, return_lot_from_flight,
    close_in_flight_lot_as_out, list_in_flight_lots, list_expired_in_flight_lots
"""

from __future__ import annotations

import sqlite3
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.storage import init_db, repo as storage_repo  # noqa: E402
from server.storage.migrations import _apply_column_additions  # noqa: E402
from server.storage.models import LotIn, ProductIn  # noqa: E402


# ---------------------------------------------------------------------------
# Schema migration
# ---------------------------------------------------------------------------


def _make_old_schema_conn() -> sqlite3.Connection:
    """Build an in-memory DB with the PRE-in-flight schema shapes for lots
    and session_resolutions. The rest of the tables are omitted where
    possible — the migration only touches these two.
    """
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
          started_at TEXT NOT NULL
        );
        -- OLD lots: old CHECK, no in-flight columns.
        CREATE TABLE lots (
          lot_id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(product_id),
          status TEXT NOT NULL CHECK(status IN
            ('on_shelf','out','depleted','relocated','lost')),
          current_weight_g REAL,
          initial_weight_g REAL,
          total_consumed_g REAL NOT NULL DEFAULT 0,
          placed_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_out_at TEXT,
          notes TEXT
        );
        CREATE TABLE scale_events (
          event_id TEXT PRIMARY KEY,
          session_id TEXT REFERENCES sessions(session_id),
          ts TEXT NOT NULL,
          delta_g REAL NOT NULL,
          before_weight_g REAL NOT NULL,
          after_weight_g REAL NOT NULL,
          direction TEXT NOT NULL CHECK(direction IN ('add','remove','noise')),
          classifier_status TEXT CHECK(classifier_status IN
            ('pending','classifying','classified','review','failed'))
        );
        -- OLD session_resolutions: old CHECK, missing the 4 in-flight patterns.
        CREATE TABLE session_resolutions (
          resolution_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(session_id),
          lot_id TEXT REFERENCES lots(lot_id),
          pattern TEXT NOT NULL CHECK(pattern IN
            ('use_return_no_consumption','use_return_consumed','topped_up',
             'consumed_or_removed','new_arrival','swap_out','swap_in',
             'relocation','unknown','no_op')),
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
        """
    )
    return conn


def test_migration_adds_in_flight_columns_and_rebuilds_lot_status_enum():
    conn = _make_old_schema_conn()
    conn.execute("INSERT INTO products (product_id, name) VALUES (?, ?)",
                 ("P1", "ketchup"))
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, current_weight_g) "
        "VALUES (?, ?, ?, ?)",
        ("L1", "P1", "on_shelf", 250.0),
    )
    conn.commit()

    _apply_column_additions(conn)

    cols = {r[1] for r in conn.execute("PRAGMA table_info(lots)")}
    assert {
        "in_flight_since", "pickup_weight_g",
        "pickup_event_id", "pickup_session_id",
    }.issubset(cols)

    ddl = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='lots'"
    ).fetchone()[0]
    assert "'in_flight'" in ddl

    # Original row preserved with NULL in the new columns.
    row = conn.execute(
        "SELECT status, current_weight_g, in_flight_since, "
        "pickup_weight_g FROM lots WHERE lot_id='L1'"
    ).fetchone()
    assert row[0] == "on_shelf"
    assert row[1] == 250.0
    assert row[2] is None
    assert row[3] is None

    # New status literal is accepted. Must provide in_flight_since to
    # satisfy the status/in_flight_since CHECK invariant — the two
    # columns are paired so a rogue ``status='in_flight'`` flip without
    # setting in_flight_since is rejected at the DB (M1 guard).
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, in_flight_since) "
        "VALUES (?, ?, ?, ?)",
        ("L2", "P1", "in_flight", "2026-04-17T12:00:00Z"),
    )


def test_migration_adds_in_flight_patterns_to_session_resolutions_enum():
    conn = _make_old_schema_conn()
    conn.execute(
        "INSERT INTO sessions (session_id, started_at) VALUES (?, ?)",
        ("S1", "2026-04-17T00:00:00Z"),
    )
    conn.execute(
        "INSERT INTO session_resolutions "
        "(resolution_id, session_id, pattern) VALUES (?, ?, ?)",
        ("R1", "S1", "no_op"),
    )
    conn.commit()

    _apply_column_additions(conn)

    ddl = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_resolutions'"
    ).fetchone()[0]
    for p in (
        "'in_flight_pickup'", "'in_flight_return'",
        "'in_flight_replaced_new_item'", "'in_flight_ttl_expired'",
    ):
        assert p in ddl

    # Original row preserved.
    row = conn.execute(
        "SELECT pattern FROM session_resolutions WHERE resolution_id='R1'"
    ).fetchone()
    assert row[0] == "no_op"

    # Each new literal is now insertable.
    for i, pattern in enumerate((
        "in_flight_pickup", "in_flight_return",
        "in_flight_replaced_new_item", "in_flight_ttl_expired",
    )):
        conn.execute(
            "INSERT INTO session_resolutions "
            "(resolution_id, session_id, pattern) VALUES (?, ?, ?)",
            (f"Rnew{i}", "S1", pattern),
        )


def test_migration_is_idempotent():
    conn = _make_old_schema_conn()
    conn.execute("INSERT INTO products (product_id, name) VALUES ('P1', 'k')")
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status) VALUES ('L1', 'P1', 'on_shelf')"
    )
    conn.commit()
    _apply_column_additions(conn)
    _apply_column_additions(conn)  # second pass must not raise or duplicate
    _apply_column_additions(conn)  # third, for good measure

    ddl = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='lots'"
    ).fetchone()[0]
    # The DDL has two occurrences of 'in_flight' by design: once in the
    # status CHECK enum, once in the status/in_flight_since pairing CHECK.
    # Idempotency means we still have exactly those two after multiple
    # _apply_column_additions passes — never a third (a third would mean
    # the rebuild ran twice).
    assert ddl.count("'in_flight'") == 2


# ---------------------------------------------------------------------------
# Repo helpers (against the NEW schema via init_db)
# ---------------------------------------------------------------------------


_BARCODE_SEQ = [0]


def _setup_on_shelf_lot(conn, *, barcode: str | None = None, weight_g: float = 200.0):
    if barcode is None:
        _BARCODE_SEQ[0] += 1
        barcode = f"BC-{_BARCODE_SEQ[0]}"
    product = storage_repo.create_product(
        conn,
        ProductIn(name=f"Item {barcode}", barcode=barcode,
                  net_weight_g=weight_g, gross_weight_g=weight_g,
                  unit_type="solid", container_type="tub", certified=1),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(product_id=product.product_id, status="on_shelf",
              current_weight_g=weight_g, initial_weight_g=weight_g),
    )
    return lot


def test_mark_lot_in_flight_sets_all_four_columns():
    conn = init_db(":memory:")
    lot = _setup_on_shelf_lot(conn)

    result = storage_repo.mark_lot_in_flight(
        conn, lot.lot_id,
        pickup_weight_g=200.0,
        pickup_event_id="E1",
        pickup_session_id="S1",
        in_flight_since="2026-04-17T12:00:00Z",
    )
    assert result is not None
    assert result.status == "in_flight"
    assert result.in_flight_since == "2026-04-17T12:00:00Z"
    assert result.pickup_weight_g == 200.0
    assert result.pickup_event_id == "E1"
    assert result.pickup_session_id == "S1"
    assert result.last_seen_at == "2026-04-17T12:00:00Z"
    # current_weight_g is preserved — still the last shelf reading.
    assert result.current_weight_g == 200.0


def test_mark_lot_in_flight_accepts_none_pickup_event_id():
    """Audit H5: ``pickup_event_id`` must accept None (becomes SQL NULL)
    for emission paths that don't have a scale_events row yet (e.g.
    reconciler retrofits). Signature was previously annotated ``str``,
    forcing callers to coerce None → ''." """
    conn = init_db(":memory:")
    lot = _setup_on_shelf_lot(conn)

    result = storage_repo.mark_lot_in_flight(
        conn, lot.lot_id,
        pickup_weight_g=200.0,
        pickup_event_id=None,
        pickup_session_id=None,
        in_flight_since="2026-04-17T12:00:00Z",
    )
    assert result is not None
    assert result.status == "in_flight"
    assert result.pickup_event_id is None
    assert result.pickup_session_id is None
    # Round-trip through the DB to make sure NULL (not empty string)
    # hit the column.
    row = conn.execute(
        "SELECT pickup_event_id, pickup_session_id FROM lots "
        "WHERE lot_id = ?", (lot.lot_id,),
    ).fetchone()
    assert row["pickup_event_id"] is None
    assert row["pickup_session_id"] is None


def test_return_lot_from_flight_clears_columns_and_adds_consumption():
    conn = init_db(":memory:")
    lot = _setup_on_shelf_lot(conn)
    storage_repo.mark_lot_in_flight(
        conn, lot.lot_id, pickup_weight_g=200.0,
        pickup_event_id="E1", pickup_session_id="S1",
        in_flight_since="2026-04-17T12:00:00Z",
    )

    result = storage_repo.return_lot_from_flight(
        conn, lot.lot_id,
        return_weight_g=180.0, consumption_g=20.0,
        return_ts="2026-04-17T12:05:00Z",
    )
    assert result is not None
    assert result.status == "on_shelf"
    assert result.current_weight_g == 180.0
    assert result.total_consumed_g == 20.0
    assert result.last_seen_at == "2026-04-17T12:05:00Z"
    assert result.in_flight_since is None
    assert result.pickup_weight_g is None
    assert result.pickup_event_id is None
    assert result.pickup_session_id is None


def test_return_lot_from_flight_clamps_negative_consumption_to_zero():
    """If consumption_g is negative (return weight > pickup), the lot total
    stays put — negative consumption happens on topups and doesn't
    decrement the lifetime total (which is by definition a sum of usage).
    """
    conn = init_db(":memory:")
    lot = _setup_on_shelf_lot(conn)
    # seed some prior consumption so we can verify it stays untouched
    storage_repo.update_lot(conn, lot.lot_id, total_consumed_g=50.0)
    storage_repo.mark_lot_in_flight(
        conn, lot.lot_id, pickup_weight_g=200.0,
        pickup_event_id="E1", pickup_session_id="S1",
        in_flight_since="2026-04-17T12:00:00Z",
    )

    result = storage_repo.return_lot_from_flight(
        conn, lot.lot_id,
        return_weight_g=220.0, consumption_g=-20.0,
        return_ts="2026-04-17T12:05:00Z",
    )
    assert result.total_consumed_g == 50.0  # unchanged (negative clamped)
    assert result.current_weight_g == 220.0


def test_close_in_flight_lot_as_out():
    conn = init_db(":memory:")
    lot = _setup_on_shelf_lot(conn)
    storage_repo.mark_lot_in_flight(
        conn, lot.lot_id, pickup_weight_g=200.0,
        pickup_event_id="E1", pickup_session_id="S1",
        in_flight_since="2026-04-17T12:00:00Z",
    )

    result = storage_repo.close_in_flight_lot_as_out(
        conn, lot.lot_id, last_out_at="2026-04-17T13:00:00Z",
    )
    assert result is not None
    assert result.status == "out"
    assert result.last_out_at == "2026-04-17T13:00:00Z"
    assert result.in_flight_since is None
    assert result.pickup_weight_g is None


def test_list_in_flight_lots_returns_only_in_flight():
    conn = init_db(":memory:")
    lot1 = _setup_on_shelf_lot(conn)
    lot2 = _setup_on_shelf_lot(conn)
    storage_repo.mark_lot_in_flight(
        conn, lot1.lot_id, pickup_weight_g=200.0,
        pickup_event_id="E1", pickup_session_id="S1",
        in_flight_since="2026-04-17T12:00:00Z",
    )
    # lot2 stays on_shelf.

    in_flight = storage_repo.list_in_flight_lots(conn)
    assert [l.lot_id for l in in_flight] == [lot1.lot_id]


def test_list_expired_in_flight_lots_respects_ttl():
    """Craft an in-flight lot with a past in_flight_since and check the
    TTL filter. ttl=1 second against a 1-hour-old pickup should match;
    ttl=86400 should not.
    """
    conn = init_db(":memory:")
    lot = _setup_on_shelf_lot(conn)
    # 1 hour ago (3600 s). Using julianday math so it's definitely past TTL=1s.
    conn.execute(
        """
        UPDATE lots SET status='in_flight',
               in_flight_since = datetime('now', '-1 hour'),
               pickup_weight_g = 200.0,
               pickup_event_id = 'E1',
               pickup_session_id = 'S1'
         WHERE lot_id = ?
        """,
        (lot.lot_id,),
    )
    conn.commit()

    expired_short_ttl = storage_repo.list_expired_in_flight_lots(
        conn, ttl_seconds=1
    )
    assert [l.lot_id for l in expired_short_ttl] == [lot.lot_id]

    expired_long_ttl = storage_repo.list_expired_in_flight_lots(
        conn, ttl_seconds=86400
    )
    assert expired_long_ttl == []


def test_create_lot_on_shelf_leaves_in_flight_columns_null():
    conn = init_db(":memory:")
    lot = _setup_on_shelf_lot(conn)
    assert lot.in_flight_since is None
    assert lot.pickup_weight_g is None
    assert lot.pickup_event_id is None
    assert lot.pickup_session_id is None


# ---------------------------------------------------------------------------
# M1: status/in_flight_since invariant CHECK
# ---------------------------------------------------------------------------


def test_check_rejects_in_flight_status_with_null_in_flight_since():
    """Rogue direct ``update_lot(status='in_flight')`` without setting
    in_flight_since must be rejected at the DB level.

    The repo helpers (mark_lot_in_flight / return_lot_from_flight /
    close_in_flight_lot_as_out / reap_in_flight_lot_as_consumed) always
    write all four in-flight columns together, so this CHECK acts as a
    safety net for direct update_lot(...) calls that only set status.
    """
    conn = init_db(":memory:")
    lot = _setup_on_shelf_lot(conn)
    # Direct INSERT of a freshly crafted row with the invariant violated.
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """
            INSERT INTO lots (
                lot_id, product_id, status, in_flight_since
            ) VALUES (?, ?, ?, ?)
            """,
            ("rogue-1", lot.product_id, "in_flight", None),
        )
    # And the symmetric violation: non-in_flight status but
    # in_flight_since populated.
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """
            INSERT INTO lots (
                lot_id, product_id, status, in_flight_since
            ) VALUES (?, ?, ?, ?)
            """,
            ("rogue-2", lot.product_id, "on_shelf", "2026-04-17T12:00:00Z"),
        )
    # Raw UPDATE that only flips status also rejected.
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "UPDATE lots SET status = 'in_flight' WHERE lot_id = ?",
            (lot.lot_id,),
        )


def test_check_accepts_valid_in_flight_pair():
    """Positive case: status='in_flight' AND in_flight_since populated."""
    conn = init_db(":memory:")
    lot = _setup_on_shelf_lot(conn)
    # Setting status + in_flight_since together in a single UPDATE passes.
    conn.execute(
        """
        UPDATE lots
           SET status = 'in_flight',
               in_flight_since = ?
         WHERE lot_id = ?
        """,
        ("2026-04-17T12:00:00Z", lot.lot_id),
    )
    row = conn.execute(
        "SELECT status, in_flight_since FROM lots WHERE lot_id = ?",
        (lot.lot_id,),
    ).fetchone()
    assert row[0] == "in_flight"
    assert row[1] == "2026-04-17T12:00:00Z"
