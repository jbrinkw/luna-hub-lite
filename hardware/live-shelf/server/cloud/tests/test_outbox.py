"""Unit tests for ``server.cloud.outbox``.

Uses the shared storage migration machinery (init_db applies the
cloud_outbox table on a fresh in-memory DB) so we test the same schema
the Pi will see in production.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import uuid
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud import outbox  # noqa: E402
from server.storage import init_db  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def conn() -> sqlite3.Connection:
    """Fresh in-memory DB with migrations applied (including cloud_outbox)."""
    c = init_db(":memory:")
    try:
        yield c
    finally:
        c.close()


# ---------------------------------------------------------------------------
# Schema existence
# ---------------------------------------------------------------------------


def test_cloud_outbox_table_exists(conn):
    """Migration landed the table and the partial pending index."""
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='cloud_outbox'"
    ).fetchall()
    assert len(rows) == 1
    idx = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' "
        "AND name='cloud_outbox_pending_idx'"
    ).fetchall()
    assert len(idx) == 1


# ---------------------------------------------------------------------------
# enqueue_event
# ---------------------------------------------------------------------------


def test_enqueue_event_stamps_client_event_id_into_persisted_row(conn):
    """The persisted row + its JSON payload must both carry the returned
    client_event_id — the cloud-side dedupe keys off this field."""
    payload = {"kind": "consumption", "stock_id": "s1", "delta_g": -42.0}
    returned_id = outbox.enqueue_event(conn, payload)
    # Returned id is a well-formed UUID.
    uuid.UUID(returned_id)

    row = conn.execute(
        "SELECT client_event_id, payload_json FROM cloud_outbox"
    ).fetchone()
    assert row["client_event_id"] == returned_id
    stored = json.loads(row["payload_json"])
    assert stored["client_event_id"] == returned_id
    assert stored["stock_id"] == "s1"


def test_enqueue_event_does_not_mutate_caller_dict(conn):
    """Callers that reuse a payload dict across retries must not find
    the previous attempt's client_event_id baked in. The contract is
    "returned id is the sole output" — the input dict is untouched."""
    payload = {"kind": "consumption", "stock_id": "s1", "delta_g": -42.0}
    before = dict(payload)  # snapshot by value
    returned_id = outbox.enqueue_event(conn, payload)
    assert returned_id  # sanity
    # Original keys intact + no client_event_id injected.
    assert payload == before
    assert "client_event_id" not in payload


def test_enqueue_event_is_pending_by_default(conn):
    """Fresh rows: sent_at NULL, attempts 0, last_error NULL."""
    outbox.enqueue_event(conn, {"k": "v"})
    row = conn.execute(
        "SELECT sent_at, attempts, last_error FROM cloud_outbox"
    ).fetchone()
    assert row["sent_at"] is None
    assert row["attempts"] == 0
    assert row["last_error"] is None


def test_enqueue_event_rejects_duplicate_client_event_id(conn):
    """The UNIQUE constraint on client_event_id must fire if a caller
    ever reuses an id — the cloud dedupe relies on it being unique."""
    eid = str(uuid.uuid4())
    with conn:
        conn.execute(
            "INSERT INTO cloud_outbox (client_event_id, payload_json) "
            "VALUES (?, ?)",
            (eid, json.dumps({"client_event_id": eid})),
        )
    with pytest.raises(sqlite3.IntegrityError):
        with conn:
            conn.execute(
                "INSERT INTO cloud_outbox (client_event_id, payload_json) "
                "VALUES (?, ?)",
                (eid, json.dumps({"client_event_id": eid, "take": 2})),
            )


# ---------------------------------------------------------------------------
# list_pending / ordering
# ---------------------------------------------------------------------------


def test_list_pending_returns_only_unsent_in_insertion_order(conn):
    """Events must drain in the order they happened. We rely on
    ``outbox_id ASC`` to preserve insertion order."""
    id1 = outbox.enqueue_event(conn, {"n": 1})
    id2 = outbox.enqueue_event(conn, {"n": 2})
    id3 = outbox.enqueue_event(conn, {"n": 3})

    # Mark the middle one sent.
    middle = conn.execute(
        "SELECT outbox_id FROM cloud_outbox WHERE client_event_id = ?",
        (id2,),
    ).fetchone()
    outbox.mark_sent(conn, middle["outbox_id"])

    pending = outbox.list_pending(conn)
    ids = [r.client_event_id for r in pending]
    assert ids == [id1, id3]
    # Decoded payload accessor works.
    assert pending[0].payload["n"] == 1


def test_list_pending_respects_limit(conn):
    for i in range(5):
        outbox.enqueue_event(conn, {"i": i})
    rows = outbox.list_pending(conn, limit=2)
    assert len(rows) == 2


# ---------------------------------------------------------------------------
# mark_sent / mark_failed / count_pending
# ---------------------------------------------------------------------------


def test_mark_sent_clears_error_and_stamps_sent_at(conn):
    """After a successful retry the last_error field shouldn't linger —
    operators reading the row shouldn't see a stale error alongside a
    sent_at timestamp."""
    outbox.enqueue_event(conn, {"k": "v"})
    row = conn.execute(
        "SELECT outbox_id FROM cloud_outbox"
    ).fetchone()
    outbox.mark_failed(conn, row["outbox_id"], "boom")
    outbox.mark_sent(conn, row["outbox_id"])
    after = conn.execute(
        "SELECT sent_at, last_error FROM cloud_outbox WHERE outbox_id = ?",
        (row["outbox_id"],),
    ).fetchone()
    assert after["sent_at"] is not None
    assert after["last_error"] is None


def test_mark_failed_increments_attempts(conn):
    outbox.enqueue_event(conn, {"k": "v"})
    row = conn.execute("SELECT outbox_id FROM cloud_outbox").fetchone()
    outbox.mark_failed(conn, row["outbox_id"], "err-1")
    outbox.mark_failed(conn, row["outbox_id"], "err-2")
    after = conn.execute(
        "SELECT attempts, last_error, sent_at FROM cloud_outbox "
        "WHERE outbox_id = ?",
        (row["outbox_id"],),
    ).fetchone()
    assert after["attempts"] == 2
    # The most recent error is what's stored.
    assert after["last_error"] == "err-2"
    # Still pending — failed attempts don't flip sent_at.
    assert after["sent_at"] is None


def test_count_pending_matches_unsent_rows(conn):
    assert outbox.count_pending(conn) == 0
    outbox.enqueue_event(conn, {"n": 1})
    outbox.enqueue_event(conn, {"n": 2})
    assert outbox.count_pending(conn) == 2
    row = conn.execute("SELECT outbox_id FROM cloud_outbox LIMIT 1").fetchone()
    outbox.mark_sent(conn, row["outbox_id"])
    assert outbox.count_pending(conn) == 1


# ---------------------------------------------------------------------------
# trim_oldest_over
# ---------------------------------------------------------------------------


def test_trim_oldest_over_only_deletes_sent_rows(conn):
    """Disk-cap protection must never silently drop pending events."""
    # Insert 5 rows and mark the 3 oldest as sent.
    ids = [outbox.enqueue_event(conn, {"i": i}) for i in range(5)]
    for eid in ids[:3]:
        row = conn.execute(
            "SELECT outbox_id FROM cloud_outbox WHERE client_event_id = ?",
            (eid,),
        ).fetchone()
        outbox.mark_sent(conn, row["outbox_id"])

    deleted = outbox.trim_oldest_over(conn, cap=2)
    # Total was 5, cap=2 → 3 over; all 3 sent rows become eligible.
    assert deleted == 3
    remaining = conn.execute(
        "SELECT client_event_id FROM cloud_outbox ORDER BY outbox_id ASC"
    ).fetchall()
    # The two pending rows survive.
    assert [r["client_event_id"] for r in remaining] == [ids[3], ids[4]]


def test_trim_noop_when_under_cap(conn):
    outbox.enqueue_event(conn, {"n": 1})
    outbox.enqueue_event(conn, {"n": 2})
    deleted = outbox.trim_oldest_over(conn, cap=10)
    assert deleted == 0
    assert outbox.count_pending(conn) == 2


def test_trim_under_cap_with_sent_rows_deletes_nothing(conn):
    """Mutation-testing gap: the LIMIT clause uses ``MAX(0, count - cap)``
    to clamp the count-minus-cap subtraction to >= 0. SQLite treats a
    *negative* LIMIT as "no limit" (verified via LIMIT -5 returning all
    rows) so dropping the MAX clamp silently turns "under-cap → do
    nothing" into "under-cap → delete every sent row".

    Trigger: 3 sent rows + 2 pending rows under a cap of 100. Count(5)
    - cap(100) = -95. With MAX: LIMIT 0 → 0 deleted. Without MAX:
    LIMIT -95 → no limit → all 3 sent rows deleted. That's silent data
    loss on the audit trail for any Pi whose outbox never approaches
    the 10k cap — i.e. every Pi in practice.
    """
    ids = [outbox.enqueue_event(conn, {"n": i}) for i in range(5)]
    for eid in ids[:3]:
        row = conn.execute(
            "SELECT outbox_id FROM cloud_outbox WHERE client_event_id = ?",
            (eid,),
        ).fetchone()
        outbox.mark_sent(conn, row["outbox_id"])

    total_before = conn.execute(
        "SELECT COUNT(*) AS c FROM cloud_outbox"
    ).fetchone()["c"]
    assert total_before == 5

    deleted = outbox.trim_oldest_over(conn, cap=100)
    assert deleted == 0, (
        "under-cap trim must delete zero rows (all 3 sent rows stay "
        "as audit trail); dropping the MAX(0, ...) clamp would produce "
        "negative LIMIT → unlimited delete of every sent row"
    )
    total_after = conn.execute(
        "SELECT COUNT(*) AS c FROM cloud_outbox"
    ).fetchone()["c"]
    assert total_after == 5
    # All 3 sent rows still present — audit trail intact.
    sent_remaining = conn.execute(
        "SELECT COUNT(*) AS c FROM cloud_outbox WHERE sent_at IS NOT NULL"
    ).fetchone()["c"]
    assert sent_remaining == 3


def test_trim_skips_pending_rows_when_all_are_pending(conn):
    """Cap breach consisting entirely of pending rows must not delete
    anything — those events haven't been delivered yet."""
    for i in range(5):
        outbox.enqueue_event(conn, {"i": i})
    deleted = outbox.trim_oldest_over(conn, cap=2)
    assert deleted == 0
    assert outbox.count_pending(conn) == 5


# ---------------------------------------------------------------------------
# Permanent-failure flag (deep-audit finding #3)
# ---------------------------------------------------------------------------


def test_schema_has_failed_permanently_column(conn):
    """Fresh DB should carry the failed_permanently column out-of-the-box
    (schema.sql) AND on long-lived DBs via the migrations ADD COLUMN
    path. Column is INTEGER NOT NULL DEFAULT 0."""
    cols = conn.execute("PRAGMA table_info(cloud_outbox)").fetchall()
    names = {c["name"] for c in cols}
    assert "failed_permanently" in names


def test_mark_permanent_failure_flips_flag_and_records_error(conn):
    """mark_permanent_failure sets failed_permanently=1, bumps attempts,
    and records the reason in last_error."""
    outbox.enqueue_event(conn, {"k": "v"})
    row = conn.execute("SELECT outbox_id FROM cloud_outbox").fetchone()
    outbox.mark_permanent_failure(conn, row["outbox_id"], "400: bad shape")
    after = conn.execute(
        "SELECT failed_permanently, attempts, last_error, sent_at "
        "FROM cloud_outbox WHERE outbox_id = ?",
        (row["outbox_id"],),
    ).fetchone()
    assert after["failed_permanently"] == 1
    assert after["attempts"] == 1
    assert after["last_error"] == "400: bad shape"
    assert after["sent_at"] is None  # NOT the same as a successful send


def test_list_pending_excludes_permanent_failures(conn):
    """Once a row is flagged failed_permanently the drainer should
    skip it — otherwise we burn cycles on the same 4xx forever."""
    outbox.enqueue_event(conn, {"ok": True})
    outbox.enqueue_event(conn, {"bad": True})
    rows = conn.execute(
        "SELECT outbox_id, payload_json FROM cloud_outbox "
        "ORDER BY outbox_id ASC"
    ).fetchall()
    # Mark the "bad" one permanent.
    for r in rows:
        if "bad" in r["payload_json"]:
            outbox.mark_permanent_failure(
                conn, r["outbox_id"], "400: never retry",
            )
            break
    pending = outbox.list_pending(conn)
    assert len(pending) == 1
    assert "ok" in pending[0].payload_json


def test_count_pending_excludes_permanent_failures(conn):
    """count_pending mirrors list_pending's filter."""
    outbox.enqueue_event(conn, {"a": 1})
    outbox.enqueue_event(conn, {"b": 2})
    assert outbox.count_pending(conn) == 2
    # Flag one permanent.
    row = conn.execute(
        "SELECT outbox_id FROM cloud_outbox LIMIT 1"
    ).fetchone()
    outbox.mark_permanent_failure(conn, row["outbox_id"], "422: constraint")
    assert outbox.count_pending(conn) == 1


def test_count_permanent_failures_reports_flagged_rows(conn):
    """count_permanent_failures surfaces rows the cloud gave up on so
    /healthz can alarm on a non-zero count."""
    assert outbox.count_permanent_failures(conn) == 0
    outbox.enqueue_event(conn, {"a": 1})
    outbox.enqueue_event(conn, {"b": 2})
    assert outbox.count_permanent_failures(conn) == 0
    rows = conn.execute(
        "SELECT outbox_id FROM cloud_outbox"
    ).fetchall()
    outbox.mark_permanent_failure(conn, rows[0]["outbox_id"], "400")
    outbox.mark_permanent_failure(conn, rows[1]["outbox_id"], "404")
    assert outbox.count_permanent_failures(conn) == 2


def test_partial_index_uses_new_filter(conn):
    """The partial index WHERE clause must include failed_permanently=0
    so SQLite can skip permanent rows during the pending scan without
    reading them."""
    idx_ddl = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='index' "
        "AND name='cloud_outbox_pending_idx'"
    ).fetchone()[0]
    assert "failed_permanently = 0" in idx_ddl
    assert "sent_at IS NULL" in idx_ddl


def test_trim_oldest_over_is_single_statement_transaction(conn):
    """Trim must issue the count + delete as one SQL statement so a
    concurrent enqueue can't interleave between "how many over?" and
    "delete that many". We verify by counting ``execute`` calls made
    against a proxy wrapper: a single DELETE is expected, not a
    count-then-delete pair.

    Cannot test true concurrency without threads + timing games, but
    the single-statement property is a sufficient proxy: SQLite's
    write-lock covers the whole statement including the correlated
    ``SELECT COUNT(*)`` subquery.
    """
    # Seed: 5 rows, first 3 marked sent.
    ids = [outbox.enqueue_event(conn, {"i": i}) for i in range(5)]
    for eid in ids[:3]:
        row = conn.execute(
            "SELECT outbox_id FROM cloud_outbox WHERE client_event_id = ?",
            (eid,),
        ).fetchone()
        outbox.mark_sent(conn, row["outbox_id"])

    # sqlite3.Connection's ``execute`` attribute is read-only, so wrap
    # the connection in a proxy that forwards every attribute lookup
    # to the real conn but captures ``execute`` SQL strings. ``with
    # conn:`` (used by trim_oldest_over) delegates to __enter__ /
    # __exit__ which must also forward.
    calls: list[str] = []

    class _CountingConn:
        def __init__(self, inner): self._inner = inner
        def execute(self, sql, *args, **kwargs):
            calls.append(sql)
            return self._inner.execute(sql, *args, **kwargs)
        def __enter__(self): return self._inner.__enter__()
        def __exit__(self, *exc): return self._inner.__exit__(*exc)
        def __getattr__(self, name): return getattr(self._inner, name)

    proxy = _CountingConn(conn)
    deleted = outbox.trim_oldest_over(proxy, cap=2)  # type: ignore[arg-type]

    assert deleted == 3
    # Only ONE SQL statement issued by trim itself (the DELETE with a
    # correlated-subquery-based count). No pre-flight separate
    # COUNT(*) select — that's the atomicity guarantee.
    trim_sql_statements = [s for s in calls if "cloud_outbox" in s]
    assert len(trim_sql_statements) == 1
    assert trim_sql_statements[0].lstrip().upper().startswith("DELETE")
