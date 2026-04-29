"""Producer-side dead-letter tests for CloudEventEmitter._enqueue.

Change B (FINAL_PLAN.md §B): contract violations in _enqueue must insert a
dead-letter outbox row with last_error='PRODUCER_DROP: ...' instead of
silently dropping the event. This file exercises that invariant and also
verifies that a DB-level insert failure raises (cannot dead-letter to a
broken DB).
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.integration import CloudEventEmitter  # noqa: E402
from server.storage import init_db  # noqa: E402


# Note: patch.object cannot mock sqlite3.Connection.execute (read-only slot).
# Tests that need a broken DB use the _BrokenInsertConn wrapper class below.


@pytest.fixture
def conn() -> sqlite3.Connection:
    c = init_db(":memory:")
    try:
        yield c
    finally:
        c.close()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _bad_live_weight_sync_payload() -> dict:
    """A live_weight_sync payload where observed_weight_g is None — invalid per contract."""
    return {
        "scale_id": "scale-01",
        "kind": "live_shelf",
        "event_kind": "live_weight_sync",
        "observed_weight_g": None,  # contract requires non-NULL
        "delta_g": 12.0,
        "pi_lot_id": "lot-1",
        "occurred_at": "2026-04-29T12:31:00.000Z",
    }


# ---------------------------------------------------------------------------
# Core: contract violation → dead-letter row
# ---------------------------------------------------------------------------

def test_contract_violation_creates_dead_letter(conn):
    """A payload-contract violation must insert exactly one dead-letter row."""
    emitter = CloudEventEmitter(conn, enabled=True)
    payload = _bad_live_weight_sync_payload()

    result = emitter._enqueue(payload)

    # Caller still gets None (no client_event_id was emitted successfully)
    assert result is None, "must return None when dead-lettering"

    row = conn.execute(
        "SELECT last_error, failed_permanently, attempts, sent_at "
        "FROM cloud_outbox"
    ).fetchone()
    assert row is not None, "dead-letter row must be inserted into cloud_outbox"
    assert row["last_error"].startswith("PRODUCER_DROP:"), (
        f"last_error must start with 'PRODUCER_DROP:' — got {row['last_error']!r}"
    )
    assert "contract violation" in row["last_error"].lower(), (
        f"last_error should mention contract violation — got {row['last_error']!r}"
    )
    assert row["failed_permanently"] == 1, "dead-letter row must be flagged failed_permanently=1"
    assert row["attempts"] == 99, "dead-letter row must have attempts=99 (above retry threshold)"
    assert row["sent_at"] is None, "dead-letter row must not be marked sent"


def test_contract_violation_outbox_count_is_exactly_one(conn):
    """Exactly one dead-letter row is inserted per contract violation."""
    emitter = CloudEventEmitter(conn, enabled=True)
    emitter._enqueue(_bad_live_weight_sync_payload())

    count = conn.execute("SELECT COUNT(*) FROM cloud_outbox").fetchone()[0]
    assert count == 1, f"expected 1 dead-letter row, got {count}"


def test_contract_violation_payload_json_preserved(conn):
    """The dead-letter row's payload_json preserves the original payload fields."""
    import json
    emitter = CloudEventEmitter(conn, enabled=True)
    payload = _bad_live_weight_sync_payload()

    emitter._enqueue(payload)

    raw = conn.execute("SELECT payload_json FROM cloud_outbox").fetchone()["payload_json"]
    stored = json.loads(raw)
    assert stored["event_kind"] == "live_weight_sync"
    assert stored["scale_id"] == "scale-01"
    # client_event_id is injected by the dead-letter branch
    assert "client_event_id" in stored


def test_disabled_emitter_inserts_nothing(conn):
    """When the emitter is disabled, no rows are written even for bad payloads."""
    emitter = CloudEventEmitter(conn, enabled=False)
    result = emitter._enqueue(_bad_live_weight_sync_payload())

    assert result is None
    count = conn.execute("SELECT COUNT(*) FROM cloud_outbox").fetchone()[0]
    assert count == 0, "disabled emitter must write nothing"


class _BrokenInsertConn:
    """Thin wrapper around a sqlite3.Connection that raises on INSERT.

    sqlite3.Connection's 'execute' attribute is read-only and cannot be
    patched with unittest.mock.patch.object. Wrapping is the only portable
    way to inject failures on the INSERT path.
    """

    def __init__(self, real_conn: sqlite3.Connection) -> None:
        self._real = real_conn

    def execute(self, sql: str, *args, **kwargs):
        if sql.lstrip().upper().startswith("INSERT"):
            raise sqlite3.OperationalError("simulated DB failure")
        return self._real.execute(sql, *args, **kwargs)

    def __enter__(self):
        return self._real.__enter__()

    def __exit__(self, *exc):
        return self._real.__exit__(*exc)

    def __getattr__(self, name):
        return getattr(self._real, name)


def test_db_insert_failure_raises(conn):
    """If the DB insert itself fails, _enqueue must raise (not swallow)."""
    broken = _BrokenInsertConn(conn)
    # Assign a fresh CloudEventEmitter that holds the broken wrapper
    emitter = CloudEventEmitter.__new__(CloudEventEmitter)
    emitter._conn = broken
    emitter._enabled = True

    payload = _bad_live_weight_sync_payload()

    with pytest.raises(Exception):
        emitter._enqueue(payload)


def test_multiple_violations_each_create_dead_letter_row(conn):
    """Two distinct contract violations produce two separate dead-letter rows."""
    emitter = CloudEventEmitter(conn, enabled=True)
    emitter._enqueue(_bad_live_weight_sync_payload())
    emitter._enqueue(_bad_live_weight_sync_payload())

    count = conn.execute("SELECT COUNT(*) FROM cloud_outbox").fetchone()[0]
    assert count == 2, f"each violation must produce its own dead-letter row, got {count}"
