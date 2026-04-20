"""Tests for the lifecycle + observability logging system.

Covers the low-level helpers (log_event / log_session / snapshot / reader),
the invariant checker (one parametrized case per invariant), an end-to-end
integration that drives a single scale event through the handler and
asserts the expected sequence of reason_codes lands, and the debug
endpoints (/api/debug/event/<id>, /api/debug/invariants).
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from server.storage import init_db
from server.storage import lifecycle
from server.storage.lifecycle import ReasonCode
from server.tools.invariants import run_invariant_checks


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def conn():
    c = init_db(":memory:")
    try:
        yield c
    finally:
        c.close()


@pytest.fixture
def lock():
    # Match the runtime type used by app.py (RLock) so the lifecycle
    # tests exercise the same reentry-safe code path as production.
    return threading.RLock()


# ---------------------------------------------------------------------------
# Unit: log_event / log_session / log_system_health_snapshot
# ---------------------------------------------------------------------------


def test_log_event_inserts_and_is_retrievable(conn, lock):
    lifecycle.log_event(
        conn, lock, "evt-1",
        actor="fast_path",
        reason_code=ReasonCode.EVENT_INGRESS,
        payload={"delta_g": 12.3, "ts": "2026-04-16T00:00:00.000Z"},
    )
    rows = lifecycle.get_event_timeline(conn, "evt-1")
    assert len(rows) == 1
    row = rows[0]
    assert row["event_id"] == "evt-1"
    assert row["actor"] == "fast_path"
    assert row["reason_code"] == ReasonCode.EVENT_INGRESS
    assert row["payload"]["delta_g"] == pytest.approx(12.3)


def test_log_event_missing_id_is_noop(conn, lock):
    lifecycle.log_event(
        conn, lock, None,
        actor="x", reason_code="y",
    )
    rows = conn.execute("SELECT COUNT(*) FROM event_lifecycle").fetchone()
    assert rows[0] == 0


def test_log_event_swallows_db_errors(lock):
    # Closed connection — every execute() raises. log_event must not
    # propagate the exception.
    c = sqlite3.connect(":memory:")
    c.close()
    # Should not raise.
    lifecycle.log_event(
        c, lock, "evt-x",
        actor="t", reason_code="t",
    )


def test_log_session_inserts_and_orders_chronologically(conn, lock):
    for i, reason in enumerate(
        (ReasonCode.SESSION_OPENED, ReasonCode.SESSION_CLOSED,
         ReasonCode.RECONCILER_STARTED)
    ):
        lifecycle.log_session(
            conn, lock, "sess-1",
            actor="test", reason_code=reason,
            payload={"i": i},
        )
    rows = lifecycle.get_session_timeline(conn, "sess-1")
    assert [r["reason_code"] for r in rows] == [
        ReasonCode.SESSION_OPENED,
        ReasonCode.SESSION_CLOSED,
        ReasonCode.RECONCILER_STARTED,
    ]


def test_log_system_health_snapshot_roundtrip(conn, lock):
    snap = {
        "scale_weight_g": 1234.5,
        "pending_events": 3,
        "classifying_events": 1,
        "failed_events": 0,
        "pending_reviews": 2,
        "on_shelf_lot_count": 5,
        "on_shelf_weight_sum_g": 4200.0,
        "closed_deque_size": 10,
        "anthropic_calls_total": 7,
        "anthropic_errors_total": 1,
    }
    lifecycle.log_system_health_snapshot(conn, lock, snap)
    rows = conn.execute(
        "SELECT * FROM system_health ORDER BY id DESC LIMIT 1"
    ).fetchone()
    assert rows is not None
    d = {k: rows[k] for k in rows.keys()}
    assert d["scale_weight_g"] == pytest.approx(1234.5)
    assert d["pending_events"] == 3
    assert d["anthropic_calls_total"] == 7


def test_purge_older_than_trims_old_rows(conn, lock):
    # Insert two event_lifecycle rows — one with ts 60 days ago, one
    # fresh. Retention of 30 days should remove the old one only.
    conn.execute(
        """
        INSERT INTO event_lifecycle (event_id, ts, actor, reason_code)
        VALUES ('old', ?, 'test', 'test')
        """,
        ((datetime.now(timezone.utc) - timedelta(days=60)).strftime(
            "%Y-%m-%dT%H:%M:%S.000Z"),),
    )
    conn.commit()
    lifecycle.log_event(conn, lock, "fresh", actor="t", reason_code="t")
    deleted = lifecycle.purge_older_than(conn, lock, days=30)
    assert deleted["event_lifecycle"] == 1
    remaining = [
        r[0] for r in conn.execute(
            "SELECT event_id FROM event_lifecycle"
        ).fetchall()
    ]
    assert remaining == ["fresh"]


# ---------------------------------------------------------------------------
# Invariant checker — one case per kind
# ---------------------------------------------------------------------------


def _seed_product(conn, product_id="p1", net=100.0, gross=120.0):
    conn.execute(
        """INSERT INTO products (product_id, name, net_weight_g, gross_weight_g)
           VALUES (?, ?, ?, ?)""",
        (product_id, "Test", net, gross),
    )
    conn.commit()


def test_invariant_stale_session_pointer(conn):
    conn.execute(
        """
        INSERT INTO sessions (session_id, started_at, ended_at)
        VALUES ('s1', '2026-04-16T00:00:00Z', '2026-04-16T00:01:00Z')
        """
    )
    conn.execute(
        "UPDATE app_state SET current_session_id = 's1' WHERE id = 1"
    )
    conn.commit()
    violations = {v["kind"]: v for v in run_invariant_checks(conn)}
    assert "stale_session_pointer" in violations
    assert violations["stale_session_pointer"]["count"] == 1


def test_invariant_lot_on_shelf_zero_weight(conn):
    _seed_product(conn)
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, current_weight_g) "
        "VALUES ('l1', 'p1', 'on_shelf', 0)"
    )
    conn.commit()
    kinds = {v["kind"] for v in run_invariant_checks(conn)}
    assert "lot_on_shelf_zero_weight" in kinds


def test_invariant_lot_out_missing_last_out(conn):
    _seed_product(conn)
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, last_out_at) "
        "VALUES ('l1', 'p1', 'out', NULL)"
    )
    conn.commit()
    kinds = {v["kind"] for v in run_invariant_checks(conn)}
    assert "lot_out_missing_last_out" in kinds


def test_invariant_gross_lt_net(conn):
    conn.execute(
        """INSERT INTO products (product_id, name, net_weight_g, gross_weight_g)
           VALUES ('px', 'bad', 100.0, 50.0)"""
    )
    conn.commit()
    kinds = {v["kind"] for v in run_invariant_checks(conn)}
    assert "gross_lt_net" in kinds


def test_invariant_scale_nonzero_no_lots(conn):
    conn.execute(
        "UPDATE app_state SET last_scale_weight_g = 500 WHERE id = 1"
    )
    conn.commit()
    # No on_shelf lots — should flag.
    kinds = {v["kind"] for v in run_invariant_checks(conn)}
    assert "scale_nonzero_no_lots" in kinds


def test_invariant_stuck_classifying(conn):
    # Insert a scale_event with classifier_status='classifying' and a
    # created_at in the past (older than 2 min).
    old_ts = (datetime.now(timezone.utc) - timedelta(minutes=5)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    conn.execute(
        """INSERT INTO scale_events
           (event_id, ts, delta_g, before_weight_g, after_weight_g,
            direction, classifier_status, created_at)
           VALUES ('e1', ?, 10, 0, 10, 'add', 'classifying', ?)""",
        ("2026-04-16T00:00:00Z", old_ts),
    )
    conn.commit()
    kinds = {v["kind"] for v in run_invariant_checks(conn)}
    assert "stuck_classifying" in kinds


def test_invariant_pending_event_old(conn):
    old_ts = (datetime.now(timezone.utc) - timedelta(minutes=30)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    conn.execute(
        """INSERT INTO scale_events
           (event_id, ts, delta_g, before_weight_g, after_weight_g,
            direction, classifier_status, created_at)
           VALUES ('e2', ?, 10, 0, 10, 'add', 'pending', ?)""",
        ("2026-04-16T00:00:00Z", old_ts),
    )
    conn.commit()
    kinds = {v["kind"] for v in run_invariant_checks(conn)}
    assert "pending_event_old" in kinds


# ---------------------------------------------------------------------------
# Integration: drive one scale event through the handler
# ---------------------------------------------------------------------------


def _make_handler(conn, lock, events_root):
    from server.handlers.scale_events import ScaleHandler

    class _StubCamera:
        def ring_frames(self, *a, **kw):
            return []
        def current_frame(self):
            return None

    class _StubSource:
        def get_candidates(self, *a, **kw):
            return []

    return ScaleHandler(
        conn=conn,
        db_lock=lock,
        camera=_StubCamera(),
        candidate_source=_StubSource(),
        events_root=events_root,
        delta_threshold_g=20.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86400,
        dedup_cache_size=16,
        classifier_client=None,
        reconciler_fn=None,
        lifecycle_verbose=False,
    )


def test_scale_event_ingress_writes_lifecycle(conn, lock, tmp_path):
    """An event into handle_scale_event should log event_ingress with
    identifying payload."""
    handler = _make_handler(conn, lock, tmp_path)

    # Recent ts (post-NTP) that the handler will accept.
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    payload = {
        "ts": ts,
        "device_id": "scale-01",
        "event_seq": 1,
        "delta_g": 25.0,
        "before_weight_g": 100.0,
        "after_weight_g": 125.0,
    }
    resp, status = handler.handle_scale_event(payload)
    assert status == 200
    event_id = resp["event_id"]

    rows = lifecycle.get_event_timeline(conn, event_id)
    reasons = [r["reason_code"] for r in rows]
    assert ReasonCode.EVENT_INGRESS in reasons
    ingress = next(r for r in rows if r["reason_code"] == ReasonCode.EVENT_INGRESS)
    assert ingress["payload"]["direction"] == "add"
    assert ingress["payload"]["delta_g"] == pytest.approx(25.0)


def test_dedup_hit_logs_dedup_event(conn, lock, tmp_path):
    handler = _make_handler(conn, lock, tmp_path)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    payload = {
        "ts": ts,
        "device_id": "scale-01",
        "event_seq": 7,
        "delta_g": 25.0,
        "before_weight_g": 100.0,
        "after_weight_g": 125.0,
    }
    resp1, _ = handler.handle_scale_event(payload)
    # Same payload, hits dedup on second call.
    resp2, _ = handler.handle_scale_event(payload)
    assert resp2.get("duplicate") is True
    rows = lifecycle.get_event_timeline(conn, resp1["event_id"])
    reasons = [r["reason_code"] for r in rows]
    assert ReasonCode.EVENT_INGRESS in reasons
    assert ReasonCode.EVENT_INGRESS_DEDUP_HIT in reasons


# ---------------------------------------------------------------------------
# Debug endpoints
# ---------------------------------------------------------------------------


@pytest.fixture
def flask_app(conn, lock):
    from flask import Flask
    from server.web.debug_routes import make_debug_bp

    app = Flask(__name__)
    app.register_blueprint(make_debug_bp(conn, lock))
    app.config["TESTING"] = True
    return app


def test_debug_event_endpoint_returns_lifecycle(flask_app, conn, lock):
    # Seed a scale_events row + lifecycle rows.
    conn.execute(
        """INSERT INTO scale_events
           (event_id, ts, delta_g, before_weight_g, after_weight_g,
            direction, classifier_status)
           VALUES ('ev-a', '2026-04-16T00:00:00Z', 10, 0, 10, 'add', 'pending')"""
    )
    conn.commit()
    lifecycle.log_event(
        conn, lock, "ev-a",
        actor="fast_path", reason_code=ReasonCode.EVENT_INGRESS,
        payload={"delta_g": 10.0},
    )
    client = flask_app.test_client()
    resp = client.get("/api/debug/event/ev-a")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["event_id"] == "ev-a"
    assert data["event"]["direction"] == "add"
    assert len(data["lifecycle"]) == 1
    assert data["lifecycle"][0]["reason_code"] == ReasonCode.EVENT_INGRESS


def test_debug_invariants_endpoint(flask_app, conn):
    # Seed a stuck_classifying row so the checker has something to find.
    old_ts = (datetime.now(timezone.utc) - timedelta(minutes=10)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    conn.execute(
        """INSERT INTO scale_events
           (event_id, ts, delta_g, before_weight_g, after_weight_g,
            direction, classifier_status, created_at)
           VALUES ('stk', ?, 10, 0, 10, 'add', 'classifying', ?)""",
        ("2026-04-16T00:00:00Z", old_ts),
    )
    conn.commit()
    client = flask_app.test_client()
    resp = client.get("/api/debug/invariants")
    assert resp.status_code == 200
    kinds = {v["kind"] for v in resp.get_json()["violations"]}
    assert "stuck_classifying" in kinds


def test_debug_session_endpoint_handles_missing_row(flask_app, conn, lock):
    # session_id with lifecycle rows but no session row — should still
    # return 200 with timeline populated.
    lifecycle.log_session(
        conn, lock, "orphan-sess",
        actor="test", reason_code=ReasonCode.SESSION_OPENED,
    )
    client = flask_app.test_client()
    resp = client.get("/api/debug/session/orphan-sess")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["session"] is None
    assert len(data["lifecycle"]) == 1


def test_debug_health_endpoint(flask_app, conn, lock):
    lifecycle.log_system_health_snapshot(
        conn, lock,
        {"scale_weight_g": 100.0, "pending_events": 1},
    )
    client = flask_app.test_client()
    resp = client.get("/api/debug/health?since=1h")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["since_seconds"] == 3600
    assert len(data["snapshots"]) >= 1


# ---------------------------------------------------------------------------
# Session lifecycle: session_opened → session_closed roundtrip
# ---------------------------------------------------------------------------


def test_session_open_and_close_lifecycle(conn, lock):
    """Brightness handler should log SESSION_OPENED + SESSION_CLOSED."""
    from server.handlers.brightness import BrightnessHandler
    from server.camera.daemon import BrightnessTransition

    class _Repo:  # stub — BrightnessHandler only calls close/open_session
        pass

    handler = BrightnessHandler(
        conn=conn,
        db_lock=lock,
        reconciler_repo=_Repo(),
        last_weight_provider=lambda: 1000.0,
    )
    ts_open = "2026-04-16T00:00:00.000Z"
    ts_close = "2026-04-16T00:01:00.000Z"
    handler(BrightnessTransition("open", ts_open, 40.0))
    # Read back the session_id (open_session should have stamped
    # app_state.current_session_id).
    with lock:
        state = conn.execute(
            "SELECT current_session_id FROM app_state WHERE id = 1"
        ).fetchone()
    session_id = state[0]
    assert session_id
    handler(BrightnessTransition("close", ts_close, 2.0))
    rows = lifecycle.get_session_timeline(conn, session_id)
    reasons = [r["reason_code"] for r in rows]
    assert ReasonCode.SESSION_OPENED in reasons
    assert ReasonCode.SESSION_CLOSED in reasons
