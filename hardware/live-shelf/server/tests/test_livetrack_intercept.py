"""Tests for the LiveTrack Import interception branch in
:meth:`ScaleHandler.handle_scale_event`.

Mirrors :mod:`test_tare_capture` but drives the poller snapshot instead
of the SQLite tare_arm row. Asserts:

  1. armed + waiting_scale → event intercepted, cloud POST fired, no
     scale_events row, response shape carries ``intercepted`` sentinel.
  2. armed but state=='scale_reading_received' → NOT intercepted; event
     falls through to the normal pipeline.
  3. armed but non-catch-all shelf → NOT intercepted.
  4. armed + 'noise' direction → NOT intercepted.
  5. cloud POST failure → event still short-circuits (we logged the
     failure but can't double-apply the event locally).
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.config import AppConfig  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.shelves import build_registry_from_config  # noqa: E402
from server.storage import init_db  # noqa: E402


class _NullCandidateSource:
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


class _StubPoller:
    def __init__(self, snap):
        self._snap = snap

    def snapshot(self):
        return dict(self._snap) if isinstance(self._snap, dict) else self._snap


class _RecordingCloudClient:
    """Records post_livetrack_session_update calls; optionally raises."""

    def __init__(self, *, raise_on_update=False):
        self.updates: list[tuple[str, dict]] = []
        self.raise_on_update = raise_on_update

    def post_livetrack_session_update(self, session_id, **fields):
        self.updates.append((session_id, dict(fields)))
        if self.raise_on_update:
            raise RuntimeError("cloud down")
        return {"session_id": session_id, **fields}

    # Provide the tare-capture API so the handler's fire-and-forget
    # push-back doesn't attribute-error in other branches. Tests don't
    # exercise it here.
    def post_product_tare(self, *, product_id, tare_g):
        return {"ok": True}


def _make_handler(conn, tmp_path, *, cloud_client=None, poller=None, catch_all_enabled=True):
    cfg = AppConfig()
    cfg.catch_all_enabled = catch_all_enabled
    registry = build_registry_from_config(cfg)
    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    handler = ScaleHandler(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
        catch_all_enabled=catch_all_enabled,
        shelf_registry_override=registry,
        cloud_client=cloud_client,
    )
    if poller is not None:
        handler.set_livetrack_poller(poller)
    return handler


def _scale_row_count(conn) -> int:
    return conn.execute("SELECT COUNT(*) FROM scale_events").fetchone()[0]


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_waiting_scale_intercepts_catch_all_event(tmp_path):
    conn = init_db(":memory:")
    poller = _StubPoller({"session_id": "sess-1", "state": "waiting_scale"})
    cloud = _RecordingCloudClient()
    handler = _make_handler(conn, tmp_path, cloud_client=cloud, poller=poller)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-21T12:00:00.000Z",
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 314.0,
        "before_weight_g": 0.0,
        "after_weight_g": 314.0,
    })

    assert status == 200, (resp, status)
    assert resp.get("intercepted") == "livetrack_import"
    assert resp.get("session_id") == "sess-1"
    assert resp.get("scale_reading_g") == pytest.approx(314.0)
    assert resp.get("posted") is True

    # Cloud POST carries the expected field set.
    assert len(cloud.updates) == 1
    posted_session_id, posted_fields = cloud.updates[0]
    assert posted_session_id == "sess-1"
    assert posted_fields["scale_reading_g"] == pytest.approx(314.0)
    assert posted_fields["state"] == "scale_reading_received"
    assert "scale_reading_ts" in posted_fields

    # Must NOT record a scale_events row — the event was intercepted.
    assert _scale_row_count(conn) == 0


# ---------------------------------------------------------------------------
# Negative: wrong state, non-catch-all shelf, noise direction
# ---------------------------------------------------------------------------


def test_non_waiting_scale_state_does_not_intercept(tmp_path):
    """After a reading lands, session flips to 'scale_reading_received' —
    the next event must NOT be intercepted (it's a real stock movement)."""
    conn = init_db(":memory:")
    poller = _StubPoller({"session_id": "sess-1", "state": "scale_reading_received"})
    cloud = _RecordingCloudClient()
    handler = _make_handler(conn, tmp_path, cloud_client=cloud, poller=poller)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-21T12:00:01.000Z",
        "device_id": "scale-02",
        "event_seq": 2,
        "delta_g": 200.0,
        "before_weight_g": 314.0,
        "after_weight_g": 514.0,
    })

    assert status == 200
    assert "intercepted" not in resp
    # No cloud POST either.
    assert cloud.updates == []


def test_snapshot_none_does_not_intercept(tmp_path):
    conn = init_db(":memory:")
    poller = _StubPoller(None)
    cloud = _RecordingCloudClient()
    handler = _make_handler(conn, tmp_path, cloud_client=cloud, poller=poller)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-21T12:00:00.000Z",
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 300.0,
        "before_weight_g": 0.0,
        "after_weight_g": 300.0,
    })

    assert status == 200
    assert "intercepted" not in resp
    assert cloud.updates == []


def test_noise_direction_does_not_intercept(tmp_path):
    """delta_g below threshold → 'noise' classification → skip interception."""
    conn = init_db(":memory:")
    poller = _StubPoller({"session_id": "sess-1", "state": "waiting_scale"})
    cloud = _RecordingCloudClient()
    handler = _make_handler(conn, tmp_path, cloud_client=cloud, poller=poller)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-21T12:00:00.000Z",
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 1.0,  # below 5g threshold
        "before_weight_g": 0.0,
        "after_weight_g": 1.0,
    })

    assert status == 200
    assert "intercepted" not in resp
    assert cloud.updates == []


# ---------------------------------------------------------------------------
# Cloud-POST failure still short-circuits
# ---------------------------------------------------------------------------


def test_cloud_post_failure_still_short_circuits(tmp_path):
    """Cloud POST raises — the handler logs but must NOT fall through to
    the normal delta pipeline (doing so would let the same event count
    twice when the cloud recovers)."""
    conn = init_db(":memory:")
    poller = _StubPoller({"session_id": "sess-1", "state": "waiting_scale"})
    cloud = _RecordingCloudClient(raise_on_update=True)
    handler = _make_handler(conn, tmp_path, cloud_client=cloud, poller=poller)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-21T12:00:00.000Z",
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 314.0,
        "before_weight_g": 0.0,
        "after_weight_g": 314.0,
    })

    assert status == 200
    # Still the import-intercept response (posted=False).
    assert resp.get("intercepted") == "livetrack_import"
    assert resp.get("posted") is False
    # No scale_events row either.
    assert _scale_row_count(conn) == 0


# ---------------------------------------------------------------------------
# Non-catch-all shelf falls through even if poller snapshot is armed
# ---------------------------------------------------------------------------


def test_live_shelf_event_does_not_intercept(tmp_path):
    """Import arm is catch-all specific. live_shelf / live_scale events
    must flow through the normal pipeline even while a session is
    waiting_scale."""
    conn = init_db(":memory:")
    poller = _StubPoller({"session_id": "sess-1", "state": "waiting_scale"})
    cloud = _RecordingCloudClient()
    # catch_all_enabled=False so unknown device ids route to live_shelf.
    handler = _make_handler(
        conn, tmp_path, cloud_client=cloud, poller=poller,
        catch_all_enabled=False,
    )

    # 'scale-xx' is NOT a registered device; with catch_all_enabled=False
    # the handler falls back to shelf_id='live_shelf'.
    resp, status = handler.handle_scale_event({
        "ts": "2026-04-21T12:00:00.000Z",
        "device_id": "scale-xx",
        "event_seq": 1,
        "delta_g": 314.0,
        "before_weight_g": 0.0,
        "after_weight_g": 314.0,
    })

    # Must NOT have intercepted.
    assert status == 200
    assert "intercepted" not in resp
    assert cloud.updates == []
