"""Unit tests for :mod:`server.cloud.review_sync_poller`.

The ``ReviewSyncPoller`` pulls cloud review_queue resolutions and mirrors
them into the Pi's local ``review_queue`` table. Cloud resolution wins.

Coverage:
  * First tick (no watermark): fetches with ``updated_since=None``,
    applies resolved row, advances watermark.
  * Delta tick: sends the cached watermark on subsequent ticks.
  * Idempotency: applying the same cloud resolution twice applies it
    once; second tick returns 0.
  * Already-resolved local row: skip (Pi is leading edge).
  * Missing local row (Pi DB wipe scenario): skip without raising.
  * Invalid cloud status (not resolved/dismissed): skip with warning.
  * Cloud 5xx (CloudError): tick returns 0, watermark untouched.
  * Generic exception: tick returns 0.
  * Multiple reviews in one payload: each is applied independently.
  * user_response JSON dict is serialised to string in local row.
  * dismissed status applies as well as resolved.
  * Non-dict row in reviews list is skipped gracefully.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import uuid
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.client import CloudError  # noqa: E402
from server.cloud.review_sync_poller import ReviewSyncPoller  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.migrations import apply_migrations  # noqa: E402
from server.storage.models import ReviewQueueIn  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures + helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    apply_migrations(c)
    return c


def _seed_review(conn: sqlite3.Connection, kind: str = "low_confidence") -> str:
    """Insert a pending review_queue row and return its review_id."""
    item = storage_repo.enqueue_review(
        conn,
        ReviewQueueIn(kind=kind, proposed=json.dumps({"item_id": "x"})),
    )
    return item.review_id


def _cloud_review(
    pi_review_id: str,
    *,
    status: str = "resolved",
    resolved_at: str = "2026-04-29T12:00:00.000Z",
    user_response: object = None,
) -> dict:
    return {
        "pi_review_id": pi_review_id,
        "status": status,
        "resolved_at": resolved_at,
        "user_response": user_response,
    }


def _poller(conn, state_path, *, fetch_fn):
    return ReviewSyncPoller(
        client=object(),
        conn=conn,
        state_path=state_path,
        fetch_fn=fetch_fn,
    )


# ---------------------------------------------------------------------------
# First tick / watermark
# ---------------------------------------------------------------------------


def test_first_tick_sends_updated_since_none(conn, tmp_path):
    calls: list[dict] = []

    def fake_fetch(client, *, updated_since=None):
        calls.append({"updated_since": updated_since})
        return {"reviews": []}

    p = _poller(conn, tmp_path / "s.json", fetch_fn=fake_fetch)
    p.tick_once()

    assert calls[0]["updated_since"] is None


def test_first_tick_applies_resolution_and_advances_watermark(conn, tmp_path):
    pi_id = _seed_review(conn)
    r = _cloud_review(pi_id, resolved_at="2026-04-29T12:00:00.000Z")

    def fake_fetch(client, *, updated_since=None):
        return {"reviews": [r]}

    p = _poller(conn, tmp_path / "s.json", fetch_fn=fake_fetch)
    applied = p.tick_once()

    assert applied == 1
    local = storage_repo.get_review(conn, pi_id)
    assert local is not None
    assert local.status == "resolved"
    assert p.high_watermark == "2026-04-29T12:00:00.000Z"


def test_delta_tick_sends_cached_watermark(conn, tmp_path):
    pi_id = _seed_review(conn)
    r = _cloud_review(pi_id, resolved_at="2026-04-29T12:00:00.000Z")
    calls: list[dict] = []

    def fake_fetch(client, *, updated_since=None):
        calls.append({"updated_since": updated_since})
        return {"reviews": [r]}

    p = _poller(conn, tmp_path / "s.json", fetch_fn=fake_fetch)
    p.tick_once()
    p.tick_once()

    assert calls[1]["updated_since"] == "2026-04-29T12:00:00.000Z"


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------


def test_idempotent_on_replay(conn, tmp_path):
    pi_id = _seed_review(conn)
    r = _cloud_review(pi_id)

    def fake_fetch(client, *, updated_since=None):
        return {"reviews": [r]}

    p = _poller(conn, tmp_path / "s.json", fetch_fn=fake_fetch)
    first = p.tick_once()
    second = p.tick_once()
    third = p.tick_once()

    assert first == 1
    assert second == 0
    assert third == 0


# ---------------------------------------------------------------------------
# Statuses
# ---------------------------------------------------------------------------


def test_dismissed_status_applies(conn, tmp_path):
    pi_id = _seed_review(conn)
    r = _cloud_review(pi_id, status="dismissed")

    def fake_fetch(client, *, updated_since=None):
        return {"reviews": [r]}

    p = _poller(conn, tmp_path / "s.json", fetch_fn=fake_fetch)
    applied = p.tick_once()

    assert applied == 1
    local = storage_repo.get_review(conn, pi_id)
    assert local is not None
    assert local.status == "dismissed"


def test_invalid_status_skipped_with_warning(conn, tmp_path, caplog):
    pi_id = _seed_review(conn)
    r = _cloud_review(pi_id, status="bogus")

    def fake_fetch(client, *, updated_since=None):
        return {"reviews": [r]}

    p = _poller(conn, tmp_path / "s.json", fetch_fn=fake_fetch)
    applied = p.tick_once()

    assert applied == 0
    local = storage_repo.get_review(conn, pi_id)
    assert local is not None
    assert local.status == "pending"  # unchanged


# ---------------------------------------------------------------------------
# Already-resolved / missing local row
# ---------------------------------------------------------------------------


def test_already_resolved_local_row_is_skipped(conn, tmp_path):
    pi_id = _seed_review(conn)
    # Resolve locally first
    storage_repo.resolve_review(conn, pi_id, status="resolved")

    r = _cloud_review(pi_id)

    def fake_fetch(client, *, updated_since=None):
        return {"reviews": [r]}

    p = _poller(conn, tmp_path / "s.json", fetch_fn=fake_fetch)
    applied = p.tick_once()

    assert applied == 0  # already resolved; Pi is leading edge


def test_missing_local_row_skipped_without_raising(conn, tmp_path):
    r = _cloud_review(str(uuid.uuid4()))  # pi_review_id we never created

    def fake_fetch(client, *, updated_since=None):
        return {"reviews": [r]}

    p = _poller(conn, tmp_path / "s.json", fetch_fn=fake_fetch)
    applied = p.tick_once()
    assert applied == 0


# ---------------------------------------------------------------------------
# user_response serialisation
# ---------------------------------------------------------------------------


def test_user_response_dict_serialised_to_json_string(conn, tmp_path):
    pi_id = _seed_review(conn)
    r = _cloud_review(pi_id, user_response={"candidate_id": "prod-y", "note": "ok"})

    def fake_fetch(client, *, updated_since=None):
        return {"reviews": [r]}

    p = _poller(conn, tmp_path / "s.json", fetch_fn=fake_fetch)
    p.tick_once()

    local = storage_repo.get_review(conn, pi_id)
    assert local is not None
    assert local.user_response is not None
    parsed = json.loads(local.user_response)
    assert parsed["candidate_id"] == "prod-y"


# ---------------------------------------------------------------------------
# Multiple reviews in one payload
# ---------------------------------------------------------------------------


def test_multiple_reviews_applied_independently(conn, tmp_path):
    pid1 = _seed_review(conn, kind="low_confidence")
    pid2 = _seed_review(conn, kind="low_confidence")

    reviews = [
        _cloud_review(pid1, resolved_at="2026-04-29T10:00:00Z"),
        _cloud_review(pid2, status="dismissed", resolved_at="2026-04-29T11:00:00Z"),
    ]

    def fake_fetch(client, *, updated_since=None):
        return {"reviews": reviews}

    p = _poller(conn, tmp_path / "s.json", fetch_fn=fake_fetch)
    applied = p.tick_once()

    assert applied == 2
    assert storage_repo.get_review(conn, pid1).status == "resolved"
    assert storage_repo.get_review(conn, pid2).status == "dismissed"
    assert p.high_watermark == "2026-04-29T11:00:00Z"


# ---------------------------------------------------------------------------
# Non-dict row in reviews list
# ---------------------------------------------------------------------------


def test_non_dict_row_skipped_gracefully(conn, tmp_path):
    pi_id = _seed_review(conn)
    r_good = _cloud_review(pi_id)

    def fake_fetch(client, *, updated_since=None):
        return {"reviews": ["not-a-dict", None, r_good]}

    p = _poller(conn, tmp_path / "s.json", fetch_fn=fake_fetch)
    applied = p.tick_once()

    assert applied == 1  # only the valid dict applied


# ---------------------------------------------------------------------------
# Cloud error handling
# ---------------------------------------------------------------------------


def test_cloud_error_returns_0_watermark_untouched(conn, tmp_path):
    state_path = tmp_path / "s.json"
    fetch = MagicMock(side_effect=CloudError(503, "Service Unavailable"))
    p = _poller(conn, state_path, fetch_fn=fetch)

    applied = p.tick_once()

    assert applied == 0
    assert p.high_watermark is None
    assert not state_path.exists()


def test_generic_exception_caught_returns_0(conn, tmp_path):
    fetch = MagicMock(side_effect=RuntimeError("network reset"))
    p = _poller(conn, tmp_path / "s.json", fetch_fn=fetch)

    applied = p.tick_once()
    assert applied == 0


def test_cloud_error_does_not_mutate_local_rows(conn, tmp_path):
    """A fetch failure must NOT flip a local row's status."""
    pi_id = _seed_review(conn)

    fetch = MagicMock(side_effect=CloudError(502, "bad gateway"))
    p = _poller(conn, tmp_path / "s.json", fetch_fn=fetch)
    p.tick_once()

    local = storage_repo.get_review(conn, pi_id)
    assert local is not None
    assert local.status == "pending"


# ---------------------------------------------------------------------------
# Empty reviews payload
# ---------------------------------------------------------------------------


def test_empty_payload_returns_0(conn, tmp_path):
    def fake_fetch(client, *, updated_since=None):
        return {"reviews": []}

    p = _poller(conn, tmp_path / "s.json", fetch_fn=fake_fetch)
    applied = p.tick_once()
    assert applied == 0
