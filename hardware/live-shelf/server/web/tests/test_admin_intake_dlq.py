"""Admin endpoint tests for /api/admin/intake-dlq.

AUDIT_FINDINGS_PHASE1 L8/HIGH closed. The endpoint trio (list /
retry / abandon) lets ops drain the intake DLQ without writing raw
SQL. These tests cover happy paths + the safety-rail returns
(missing config, bad ids, conflict on already-resolved rows).
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from typing import Any, Optional

import pytest
from flask import Flask

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.web import make_api_bp  # noqa: E402
from server.intake import dlq  # noqa: E402
from server.storage.migrations import apply_migrations  # noqa: E402


class _FakeRepo:
    """Stub satisfying the WebRepo surface for the api blueprint factory.

    The DLQ admin routes don't touch the repo — they go through the
    ``intake_dlq_*`` injection points. We provide just enough stubs
    so ``make_api_bp`` succeeds.
    """

    def get_app_state(self) -> dict[str, Any]:
        return {
            "door_open": False,
            "current_session_id": None,
            "last_scale_weight_g": 0.0,
            "pending_reviews": 0,
            "total_events": 0,
            "shelf_name": "demo",
            "updated_at": "2026-04-15T12:00:00Z",
        }

    def list_events(self, *, limit: int, offset: int):
        return []

    def count_events(self):
        return 0


class _FakeCloudClient:
    """Captures POST calls + lets the test drive the response."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.behavior = lambda path, body: {"product_id": "prod-cloud-1"}

    def post(self, path: str, body: dict) -> dict:
        self.calls.append((path, dict(body)))
        return self.behavior(path, body)


@pytest.fixture
def conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    apply_migrations(c)
    return c


@pytest.fixture
def cloud_client():
    return _FakeCloudClient()


@pytest.fixture
def upsert_calls() -> list[dict]:
    """Captures cloud → local cache write-throughs from the retry path."""
    return []


@pytest.fixture
def app(conn, cloud_client, upsert_calls):
    flask_app = Flask(__name__)
    flask_app.config["TESTING"] = True

    def _upsert(c, product, *, db_lock=None):  # noqa: ARG001
        upsert_calls.append(dict(product))
        return product.get("product_id")

    api_bp = make_api_bp(
        _FakeRepo(),
        intake_dlq_conn=lambda: conn,
        intake_dlq_cloud_client=cloud_client,
        intake_dlq_cloud_upsert_fn=_upsert,
    )
    flask_app.register_blueprint(api_bp)
    return flask_app


@pytest.fixture
def client(app):
    return app.test_client()


# ---------------------------------------------------------------------------
# GET /api/admin/intake-dlq
# ---------------------------------------------------------------------------


def test_list_returns_pending_rows(client, conn):
    """Default scope returns ``list_all`` (newest first) including
    resolved + abandoned rows. Each row carries the queued payload
    so ops can eyeball before clicking retry.
    """
    cid = dlq.enqueue(
        conn, {"name": "Pasta", "barcode": "1234567890123"},
        error="cloud 503",
    )
    resp = client.get("/api/admin/intake-dlq")
    assert resp.status_code == 200
    body = resp.get_json()
    assert "rows" in body
    assert len(body["rows"]) == 1
    row = body["rows"][0]
    assert row["client_intake_id"] == cid
    assert row["status"] == 0  # pending
    assert row["last_error"] == "cloud 503"
    # Payload echoed verbatim for inspection.
    assert "Pasta" in row["payload_json"]


def test_list_status_pending_filters(client, conn):
    """``?status=pending`` scopes to status=0 only (excludes
    resolved + abandoned). Other unknown values default to all.
    """
    cid_pending = dlq.enqueue(conn, {"name": "P"}, error="x")
    cid_resolved = dlq.enqueue(conn, {"name": "R"}, error="x")
    iid_resolved = conn.execute(
        "SELECT intake_id FROM intake_pending WHERE client_intake_id=?",
        (cid_resolved,),
    ).fetchone()["intake_id"]
    dlq.mark_resolved(conn, iid_resolved, product_id="prod-r")

    resp = client.get("/api/admin/intake-dlq?status=pending")
    assert resp.status_code == 200
    cids = [r["client_intake_id"] for r in resp.get_json()["rows"]]
    assert cids == [cid_pending]

    # Unknown status → falls through to all rows (newest first).
    resp_all = client.get("/api/admin/intake-dlq?status=garbage")
    cids_all = [r["client_intake_id"] for r in resp_all.get_json()["rows"]]
    assert set(cids_all) == {cid_pending, cid_resolved}


def test_list_returns_501_when_dlq_not_configured():
    """When the api blueprint is built without the DLQ injection,
    the routes return 501 Not Implemented rather than 500. Mirrors
    the cloud_outbox_conn pattern so ops can deploy without DLQ
    wired up and still hit the rest of /api/admin/*.
    """
    flask_app = Flask(__name__)
    api_bp = make_api_bp(_FakeRepo())  # no intake_dlq_* args
    flask_app.register_blueprint(api_bp)
    resp = flask_app.test_client().get("/api/admin/intake-dlq")
    assert resp.status_code == 501
    assert "not configured" in resp.get_json()["error"].lower()


# ---------------------------------------------------------------------------
# POST /api/admin/intake-dlq/<id>/retry
# ---------------------------------------------------------------------------


def test_retry_success_marks_resolved_and_writes_through(
    client, conn, cloud_client, upsert_calls,
):
    """A successful retry stamps status=1, ``product_id``, and writes
    the cloud product into the local cache.
    """
    cid = dlq.enqueue(
        conn, {"name": "Olive Oil", "barcode": "1"}, error="initial",
    )
    iid = conn.execute(
        "SELECT intake_id FROM intake_pending WHERE client_intake_id=?",
        (cid,),
    ).fetchone()["intake_id"]
    cloud_client.behavior = lambda path, body: {  # noqa: ARG005
        "product_id": "prod-from-cloud",
        "name": body.get("name"),
    }

    resp = client.post(f"/api/admin/intake-dlq/{iid}/retry")
    assert resp.status_code == 200
    assert resp.get_json()["product_id"] == "prod-from-cloud"

    # Row resolved.
    row = dlq.get(conn, iid)
    assert row is not None
    assert row.status == 1
    assert row.product_id == "prod-from-cloud"

    # Cache write-through ran.
    assert len(upsert_calls) == 1
    assert upsert_calls[0]["product_id"] == "prod-from-cloud"

    # Cloud was actually called with the queued payload.
    assert len(cloud_client.calls) == 1
    posted_path, posted_body = cloud_client.calls[0]
    assert posted_path == "/intake"
    assert posted_body["name"] == "Olive Oil"


def test_retry_returns_404_for_missing_id(client):
    resp = client.post("/api/admin/intake-dlq/9999/retry")
    assert resp.status_code == 404
    assert "not found" in resp.get_json()["error"].lower()


def test_retry_returns_409_for_already_resolved_row(
    client, conn, cloud_client,
):
    """Retrying an already-resolved row would re-POST + risk a
    duplicate cloud product. Reject with 409 Conflict so the UI
    can show "already done".
    """
    cid = dlq.enqueue(conn, {"name": "X"}, error="initial")
    iid = conn.execute(
        "SELECT intake_id FROM intake_pending WHERE client_intake_id=?",
        (cid,),
    ).fetchone()["intake_id"]
    dlq.mark_resolved(conn, iid, product_id="prod-already")

    resp = client.post(f"/api/admin/intake-dlq/{iid}/retry")
    assert resp.status_code == 409
    # Cloud was NOT called.
    assert cloud_client.calls == []


def test_retry_transient_failure_keeps_row_pending(client, conn, cloud_client):
    """A retry that hits another transient cloud error must NOT
    flip the row's status — it stays pending, attempts bumps, the
    new error is recorded so a future click can try again.
    """
    from server.cloud.client import CloudError

    cid = dlq.enqueue(conn, {"name": "X"}, error="first failure")
    iid = conn.execute(
        "SELECT intake_id FROM intake_pending WHERE client_intake_id=?",
        (cid,),
    ).fetchone()["intake_id"]

    def _boom(path, body):  # noqa: ARG001
        raise CloudError(503, "still down")
    cloud_client.behavior = _boom

    resp = client.post(f"/api/admin/intake-dlq/{iid}/retry")
    assert resp.status_code == 502  # 5xx → 502 from the API
    row = dlq.get(conn, iid)
    assert row is not None
    assert row.status == 0  # still pending
    assert row.attempts == 2  # 1 enqueue + 1 retry
    assert "503" in (row.last_error or "")


def test_retry_returns_4xx_for_cloud_validation_error(
    client, conn, cloud_client,
):
    """A 4xx from the cloud on retry surfaces as 400 — operator
    decides whether to ``abandon`` or fix something cloud-side.
    Row stays pending so a fix + click can resolve it.
    """
    from server.cloud.client import CloudError

    cid = dlq.enqueue(conn, {"name": "X"}, error="initial")
    iid = conn.execute(
        "SELECT intake_id FROM intake_pending WHERE client_intake_id=?",
        (cid,),
    ).fetchone()["intake_id"]

    def _boom(path, body):  # noqa: ARG001
        raise CloudError(409, "barcode dup")
    cloud_client.behavior = _boom

    resp = client.post(f"/api/admin/intake-dlq/{iid}/retry")
    assert resp.status_code == 400
    row = dlq.get(conn, iid)
    assert row is not None and row.status == 0  # still pending


# ---------------------------------------------------------------------------
# POST /api/admin/intake-dlq/<id>/abandon
# ---------------------------------------------------------------------------


def test_abandon_marks_row_abandoned(client, conn):
    cid = dlq.enqueue(conn, {"name": "X"}, error="initial")
    iid = conn.execute(
        "SELECT intake_id FROM intake_pending WHERE client_intake_id=?",
        (cid,),
    ).fetchone()["intake_id"]

    resp = client.post(
        f"/api/admin/intake-dlq/{iid}/abandon",
        json={"reason": "fixed cloud-side"},
    )
    assert resp.status_code == 200
    row = dlq.get(conn, iid)
    assert row is not None
    assert row.status == 2
    assert row.last_error == "fixed cloud-side"


def test_abandon_returns_404_when_not_pending(client, conn):
    """Cannot abandon a row that's already resolved/abandoned —
    return 404 (mirrors the cloud_outbox dead-letter retry pattern).
    """
    cid = dlq.enqueue(conn, {"name": "X"}, error="initial")
    iid = conn.execute(
        "SELECT intake_id FROM intake_pending WHERE client_intake_id=?",
        (cid,),
    ).fetchone()["intake_id"]
    dlq.mark_resolved(conn, iid, product_id="prod-1")

    resp = client.post(f"/api/admin/intake-dlq/{iid}/abandon")
    assert resp.status_code == 404
