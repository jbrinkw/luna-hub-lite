"""Unit tests for :mod:`server.intake.dlq`.

The intake dead-letter queue (AUDIT_FINDINGS_PHASE1 L8/HIGH) parks
failed cloud-intake POSTs so an operator can retry them from the
admin UI. These tests cover the storage layer in isolation —
end-to-end coverage (cloud failure → enqueue → admin retry) lives
alongside the routes / api_routes tests.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.intake import dlq  # noqa: E402
from server.storage.migrations import apply_migrations  # noqa: E402


@pytest.fixture
def conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    apply_migrations(c)
    return c


def test_enqueue_inserts_row_with_status_pending_and_uuid(conn):
    """A fresh enqueue lands status=0, attempts=1, a fresh UUID4
    client_intake_id, and the verbatim payload as JSON.
    """
    payload = {"name": "Test Product", "barcode": "1234567890123"}
    client_id = dlq.enqueue(conn, payload, error="cloud 500: outage")
    # client_id is a UUID4 string.
    assert isinstance(client_id, str) and len(client_id) == 36
    assert client_id.count("-") == 4

    rows = dlq.list_pending(conn)
    assert len(rows) == 1
    row = rows[0]
    assert row.client_intake_id == client_id
    assert row.status == dlq.STATUS_PENDING
    assert row.attempts == 1  # First failure already counts.
    assert row.last_error == "cloud 500: outage"
    assert row.product_id is None
    assert row.resolved_at is None
    # Payload round-trips losslessly.
    assert row.payload == payload


def test_list_pending_excludes_resolved_and_abandoned(conn):
    """``list_pending`` only returns status=0 rows. Resolved + abandoned
    rows still exist in the table (audit trail) but don't show up here.
    """
    p_id = dlq.enqueue(conn, {"name": "P-pending"}, error="x")
    r_id = dlq.enqueue(conn, {"name": "P-resolved"}, error="x")
    a_id = dlq.enqueue(conn, {"name": "P-abandoned"}, error="x")

    # Look up integer ids by client UUID.
    def _lookup(cid):
        return conn.execute(
            "SELECT intake_id FROM intake_pending WHERE client_intake_id=?",
            (cid,),
        ).fetchone()["intake_id"]

    dlq.mark_resolved(conn, _lookup(r_id), product_id="prod-r")
    dlq.mark_abandoned(conn, _lookup(a_id), reason="ops gave up")

    pending = dlq.list_pending(conn)
    assert [r.client_intake_id for r in pending] == [p_id]

    # ``list_all`` covers all statuses, newest-first.
    all_rows = dlq.list_all(conn)
    assert len(all_rows) == 3
    # Newest (highest intake_id) first → A then R then P.
    assert [r.client_intake_id for r in all_rows] == [a_id, r_id, p_id]


def test_mark_resolved_stamps_product_id_and_clears_error(conn):
    """A successful retry stamps status=1, ``product_id``, and clears
    ``last_error``. The resolved row is no longer pending.
    """
    cid = dlq.enqueue(conn, {"name": "X"}, error="network")
    iid = conn.execute(
        "SELECT intake_id FROM intake_pending WHERE client_intake_id=?",
        (cid,),
    ).fetchone()["intake_id"]
    updated = dlq.mark_resolved(conn, iid, product_id="prod-uuid-1")
    assert updated is True

    row = dlq.get(conn, iid)
    assert row is not None
    assert row.status == dlq.STATUS_RESOLVED
    assert row.product_id == "prod-uuid-1"
    assert row.last_error is None
    assert row.resolved_at is not None
    assert dlq.list_pending(conn) == []


def test_mark_resolved_is_idempotent_on_already_resolved(conn):
    """Re-marking an already-resolved row is a no-op (returns False).
    Mirrors cloud_outbox.reset_dead_letter / mark_sent semantics —
    the SQL guard is ``WHERE intake_id = ? AND status = 0``, so the
    second call hits 0 rows.
    """
    cid = dlq.enqueue(conn, {"name": "X"}, error="network")
    iid = conn.execute(
        "SELECT intake_id FROM intake_pending WHERE client_intake_id=?",
        (cid,),
    ).fetchone()["intake_id"]
    assert dlq.mark_resolved(conn, iid, product_id="p1") is True
    assert dlq.mark_resolved(conn, iid, product_id="p2") is False
    # product_id from the first call wins; second call did NOT overwrite.
    assert dlq.get(conn, iid).product_id == "p1"


def test_record_retry_failure_bumps_attempts_keeps_pending(conn):
    """A failed retry attempt increments ``attempts`` + stores the
    new error, but the row stays pending so a future retry can try
    again.
    """
    cid = dlq.enqueue(conn, {"name": "X"}, error="initial")
    iid = conn.execute(
        "SELECT intake_id FROM intake_pending WHERE client_intake_id=?",
        (cid,),
    ).fetchone()["intake_id"]
    dlq.record_retry_failure(conn, iid, error="retry 1 failed")
    dlq.record_retry_failure(conn, iid, error="retry 2 failed")

    row = dlq.get(conn, iid)
    assert row is not None
    assert row.status == dlq.STATUS_PENDING
    assert row.attempts == 3  # 1 enqueue + 2 retry failures
    assert row.last_error == "retry 2 failed"


def test_count_pending_matches_list_pending_size(conn):
    """``count_pending`` is the cheap O(1)-ish complement of
    ``list_pending`` — used by /healthz to surface backlog without
    paging the rows.
    """
    assert dlq.count_pending(conn) == 0
    cid1 = dlq.enqueue(conn, {"name": "A"}, error="e")
    dlq.enqueue(conn, {"name": "B"}, error="e")
    dlq.enqueue(conn, {"name": "C"}, error="e")
    assert dlq.count_pending(conn) == 3

    iid = conn.execute(
        "SELECT intake_id FROM intake_pending WHERE client_intake_id=?",
        (cid1,),
    ).fetchone()["intake_id"]
    dlq.mark_resolved(conn, iid, product_id="p")
    assert dlq.count_pending(conn) == 2


def test_mark_abandoned_takes_row_out_of_pending(conn):
    """Operator-driven abandon flips status=2; the row no longer
    appears in ``list_pending`` and the abandon reason is stamped
    into ``last_error`` (replaces the prior cloud error message).
    """
    cid = dlq.enqueue(conn, {"name": "X"}, error="cloud 500")
    iid = conn.execute(
        "SELECT intake_id FROM intake_pending WHERE client_intake_id=?",
        (cid,),
    ).fetchone()["intake_id"]
    assert dlq.mark_abandoned(conn, iid, reason="cloud-side fix in place") is True
    row = dlq.get(conn, iid)
    assert row is not None
    assert row.status == dlq.STATUS_ABANDONED
    assert row.resolved_at is not None
    assert row.last_error == "cloud-side fix in place"
    assert dlq.list_pending(conn) == []


def test_payload_with_unicode_round_trips(conn):
    """Non-ASCII names + accented brand strings must round-trip.
    JSON encoding uses ``default=str`` so even an unexpected datetime
    doesn't crash the enqueue. Verifies the payload survives the
    encode/decode cycle.
    """
    payload = {
        "name": "Sour Crème Fraîche",
        "brand": "Châteldon",
        "variant": "750 ml",
        "barcode": "3123456789012",
    }
    cid = dlq.enqueue(conn, payload, error="x")
    rows = dlq.list_pending(conn)
    assert len(rows) == 1
    assert rows[0].payload == payload
    # Spot-check the on-disk JSON encoded the unicode correctly.
    raw = json.loads(rows[0].payload_json)
    assert raw["brand"] == "Châteldon"
    assert raw == payload


def test_get_returns_none_for_missing_id(conn):
    assert dlq.get(conn, 9999) is None


def test_record_retry_failure_no_op_on_resolved_row(conn):
    """Recording a retry failure on a row that's already resolved
    must not bump its attempts counter — protects the audit trail
    if a stale UI race re-issues the retry call after success.
    """
    cid = dlq.enqueue(conn, {"name": "X"}, error="initial")
    iid = conn.execute(
        "SELECT intake_id FROM intake_pending WHERE client_intake_id=?",
        (cid,),
    ).fetchone()["intake_id"]
    dlq.mark_resolved(conn, iid, product_id="prod-1")
    attempts_before = dlq.get(conn, iid).attempts
    dlq.record_retry_failure(conn, iid, error="stale retry")
    assert dlq.get(conn, iid).attempts == attempts_before
    # Status unchanged.
    assert dlq.get(conn, iid).status == dlq.STATUS_RESOLVED
