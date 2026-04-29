"""Pi-side tests for review_queue cloud mirror (sync-audit finding #5).

Coverage:
  * ``CloudEventEmitter.emit_review_queue_create`` enqueues a payload
    keyed for the worker's ``/review-create`` route.
  * ``CloudEventEmitter.emit_review_queue_resolve`` enqueues a payload
    keyed for the worker's ``/review-resolve`` route.
  * ``ReviewSyncPoller`` mirrors a cloud resolution into the local
    review_queue row.
  * Re-applying the same cloud resolution (idempotent) does NOT bump
    the apply count.
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

from server.cloud.integration import CloudEventEmitter  # noqa: E402
from server.cloud.outbox import list_pending  # noqa: E402
from server.cloud.review_sync_poller import ReviewSyncPoller  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.migrations import apply_migrations  # noqa: E402
from server.storage.models import ReviewQueueIn  # noqa: E402


@pytest.fixture
def conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    apply_migrations(c)
    return c


# ─── Emitter forwards review_queue events ─────────────────────────────


def test_emit_review_queue_create_enqueues_outbox_row(conn):
    """``emit_review_queue_create`` must enqueue a payload tagged for
    the worker's review-create route."""
    emitter = CloudEventEmitter(conn, enabled=True)

    pi_review_id = str(uuid.uuid4())
    cid = emitter.emit_review_queue_create(
        pi_review_id=pi_review_id,
        kind="low_confidence",
        pi_event_id=str(uuid.uuid4()),
        proposed={"item_id": "prod-x", "confidence": 0.42},
        images=["events/e1/before.jpg"],
        created_at="2026-04-29T12:00:00.000Z",
    )

    assert cid is not None
    pending = list_pending(conn)
    assert len(pending) == 1

    payload = pending[0].payload
    # Worker route discriminator must be present + correctly stamped.
    assert payload["event_kind"] == "review_queue_create"
    assert payload["pi_review_id"] == pi_review_id
    assert payload["kind"] == "low_confidence"
    assert payload["proposed"] == {"item_id": "prod-x", "confidence": 0.42}
    assert payload["images"] == ["events/e1/before.jpg"]
    # client_event_id stamped by the outbox helper for dedup.
    assert payload["client_event_id"] == cid


def test_emit_review_queue_resolve_enqueues_outbox_row(conn):
    emitter = CloudEventEmitter(conn, enabled=True)
    pi_review_id = str(uuid.uuid4())

    cid = emitter.emit_review_queue_resolve(
        pi_review_id=pi_review_id,
        status="resolved",
        user_response={"candidate_id": "prod-y"},
        resolved_at="2026-04-29T12:05:00.000Z",
    )
    assert cid is not None

    pending = list_pending(conn)
    assert len(pending) == 1
    payload = pending[0].payload
    assert payload["event_kind"] == "review_queue_resolve"
    assert payload["pi_review_id"] == pi_review_id
    assert payload["status"] == "resolved"
    assert payload["user_response"] == {"candidate_id": "prod-y"}


def test_emit_review_queue_resolve_rejects_bad_status(conn):
    emitter = CloudEventEmitter(conn, enabled=True)
    cid = emitter.emit_review_queue_resolve(
        pi_review_id=str(uuid.uuid4()),
        status="bogus",  # type: ignore[arg-type]
    )
    assert cid is None
    assert list_pending(conn) == []


def test_emit_review_queue_create_disabled_emitter_is_noop(conn):
    emitter = CloudEventEmitter(conn, enabled=False)
    cid = emitter.emit_review_queue_create(
        pi_review_id=str(uuid.uuid4()),
        kind="low_confidence",
    )
    assert cid is None
    assert list_pending(conn) == []


# ─── Poller mirrors cloud resolutions back ────────────────────────────


def _seed_pending_review(conn: sqlite3.Connection, kind: str = "low_confidence") -> str:
    item = storage_repo.enqueue_review(
        conn,
        ReviewQueueIn(kind=kind, proposed=json.dumps({"item_id": "x"})),
    )
    return item.review_id


def test_poller_applies_cloud_resolution_to_local_row(conn, tmp_path):
    """A pending Pi row + a cloud resolution → local row flips to
    resolved with user_response copied across."""
    pi_review_id = _seed_pending_review(conn)

    cloud_payload = {
        "reviews": [
            {
                "pi_review_id": pi_review_id,
                "status": "resolved",
                "resolved_at": "2026-04-29T12:00:00.000Z",
                "user_response": {"candidate_id": "prod-y", "note": "ok"},
            },
        ],
    }
    fetched: list[dict] = []

    def fake_fetch(client, *, updated_since=None):
        fetched.append({"updated_since": updated_since})
        return cloud_payload

    poller = ReviewSyncPoller(
        client=object(),
        conn=conn,
        state_path=tmp_path / "watermark.json",
        fetch_fn=fake_fetch,
    )
    applied = poller.tick_once()

    assert applied == 1
    # First call: no watermark.
    assert fetched[0]["updated_since"] is None

    # Local row got resolved.
    local = storage_repo.get_review(conn, pi_review_id)
    assert local is not None
    assert local.status == "resolved"
    assert local.user_response is not None
    assert json.loads(local.user_response)["candidate_id"] == "prod-y"

    # Watermark advanced.
    assert poller.high_watermark == "2026-04-29T12:00:00.000Z"


def test_poller_idempotent_on_replay(conn, tmp_path):
    """Replaying the same cloud resolution does not bump the apply count
    (local row is already resolved → skip)."""
    pi_review_id = _seed_pending_review(conn)

    cloud_payload = {
        "reviews": [
            {
                "pi_review_id": pi_review_id,
                "status": "resolved",
                "resolved_at": "2026-04-29T12:00:00.000Z",
                "user_response": None,
            },
        ],
    }

    def fake_fetch(client, *, updated_since=None):
        # The cloud always returns the resolution row above (poller's
        # job is to dedupe locally).
        return cloud_payload

    poller = ReviewSyncPoller(
        client=object(),
        conn=conn,
        state_path=tmp_path / "watermark.json",
        fetch_fn=fake_fetch,
    )
    first = poller.tick_once()
    second = poller.tick_once()
    third = poller.tick_once()

    assert first == 1
    # Subsequent ticks find the row already resolved + skip.
    assert second == 0
    assert third == 0


def test_poller_skips_unknown_pi_review_id(conn, tmp_path):
    """Cloud sends a pi_review_id we don't have locally → skip without
    raising. Watermark still advances so we don't loop forever."""
    cloud_payload = {
        "reviews": [
            {
                "pi_review_id": str(uuid.uuid4()),  # never inserted locally
                "status": "resolved",
                "resolved_at": "2026-04-29T12:00:00.000Z",
                "user_response": None,
            },
        ],
    }

    def fake_fetch(client, *, updated_since=None):
        return cloud_payload

    poller = ReviewSyncPoller(
        client=object(),
        conn=conn,
        state_path=tmp_path / "watermark.json",
        fetch_fn=fake_fetch,
    )
    applied = poller.tick_once()
    assert applied == 0
    assert poller.high_watermark == "2026-04-29T12:00:00.000Z"
