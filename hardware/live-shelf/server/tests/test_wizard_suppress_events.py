"""Tests for the LiveTrack wizard suppression gate in
:meth:`ScaleHandler.handle_scale_event`.

The gate short-circuits the full event pipeline whenever the browser
wizard is mid-session (any non-terminal LiveTrack state). This differs
from the more specific ``waiting_scale`` branch (exercised by
``test_livetrack_intercept``) which POSTs the reading back to cloud:
the suppression gate does NO downstream work at all — no scale_events
row, no classifier call, no cloud_outbox emit.

Covers:

  1. Wizard active + live_shelf event → suppressed, no DB row, response
     carries ``suppressed`` sentinel.
  2. Wizard active + single_item event → suppressed, no single-item
     emit to cloud.
  3. Wizard active + catch_all event in a non-waiting_scale state →
     suppressed (the waiting_scale-specific branch does not fire).
  4. Wizard inactive (no poller) → normal pipeline runs.
  5. Wizard inactive (terminal state ``closed`` / ``expired``) → normal
     pipeline runs.
  6. Wizard snapshot stale beyond the defensive timeout → normal
     pipeline runs.
  7. After a wizard session expires (simulated by flipping the snapshot
     to ``closed``), the NEXT event runs the normal pipeline.
  8. Noise events are also suppressed while wizard is active.
  9. Poller snapshot raising is treated as inactive (never crashes
     the handler).
"""

from __future__ import annotations

import datetime as _dt
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
    """Stand-in LiveTrackPoller whose snapshot is configurable per-test."""

    def __init__(self, snap):
        self._snap = snap

    def set_snapshot(self, snap):
        self._snap = snap

    def snapshot(self):
        if self._snap is None:
            return None
        return dict(self._snap)


class _RaisingPoller:
    def snapshot(self):
        raise RuntimeError("poller broken")


class _RecordingCloudClient:
    """Duck-typed CloudClient — records every emit; tests assert absence."""

    def __init__(self):
        self.livetrack_updates: list[tuple[str, dict]] = []
        self.single_item_emits: list[dict] = []

    def post_livetrack_session_update(self, session_id, **fields):
        self.livetrack_updates.append((session_id, dict(fields)))
        return {"session_id": session_id, **fields}

    def post_product_tare(self, *, product_id, tare_g):
        return {"ok": True}


class _RecordingEmitter:
    """Captures cloud_outbox emissions that shelves would otherwise enqueue."""

    def __init__(self):
        self.emits: list[dict] = []

    # Matches the emit_* surface enough for single_item: the handler
    # calls self.emit_single_item_event directly, which internally uses
    # self._cloud_emitter.emit(...). Capture both possible entry points.
    def emit(self, *args, **kwargs):
        self.emits.append({"args": args, "kwargs": dict(kwargs)})


def _make_handler(
    conn,
    tmp_path,
    *,
    cloud_client=None,
    poller=None,
    catch_all_enabled=True,
    cloud_emitter=None,
):
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
        cloud_emitter=cloud_emitter,
    )
    if poller is not None:
        handler.set_livetrack_poller(poller)
    return handler


def _scale_row_count(conn) -> int:
    return conn.execute("SELECT COUNT(*) FROM scale_events").fetchone()[0]


def _outbox_row_count(conn) -> int:
    # cloud_outbox is only created by the CloudEventEmitter; when a
    # RecordingEmitter is used, nothing writes the table. Table may not
    # exist on every init path — guard with a schema check.
    row = conn.execute(
        "SELECT name FROM sqlite_master "
        " WHERE type='table' AND name='cloud_outbox'"
    ).fetchone()
    if not row:
        return 0
    return conn.execute("SELECT COUNT(*) FROM cloud_outbox").fetchone()[0]


def _now_iso(offset_s: float = 0.0) -> str:
    t = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=offset_s)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Happy-path: wizard active → event fully suppressed
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("wizard_state", [
    "waiting_barcode",
    "scale_reading_received",
    "awaiting_ai_tare",
    "ai_tare_ready",
])
def test_wizard_active_live_shelf_event_fully_suppressed(tmp_path, wizard_state):
    """Any non-terminal wizard state suppresses live_shelf events."""
    conn = init_db(":memory:")
    poller = _StubPoller({
        "session_id": "sess-1",
        "state": wizard_state,
        "created_at": _now_iso(),
    })
    cloud = _RecordingCloudClient()
    handler = _make_handler(
        conn, tmp_path, cloud_client=cloud, poller=poller,
    )

    resp, status = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": "scale-01",  # live_shelf
        "event_seq": 1,
        "delta_g": 314.0,
        "before_weight_g": 0.0,
        "after_weight_g": 314.0,
    })

    assert status == 200
    assert resp.get("suppressed") == "livetrack_wizard_active"
    assert resp.get("livetrack_session_id") == "sess-1"
    assert resp.get("livetrack_state") == wizard_state

    # No scale_events row → no classifier, no session pipeline.
    assert _scale_row_count(conn) == 0
    # No cloud_outbox emit — the full emit surface is skipped.
    assert _outbox_row_count(conn) == 0
    # Did NOT POST back to livetrack session (not our role for non-catch-all
    # shelves; suppression is silent).
    assert cloud.livetrack_updates == []


def test_wizard_active_single_item_event_suppressed_no_cloud_emit(tmp_path):
    """live_scale events normally call emit_single_item_event → cloud.
    While wizard is active, that must NOT fire."""
    conn = init_db(":memory:")
    poller = _StubPoller({
        "session_id": "sess-1",
        "state": "waiting_barcode",
        "created_at": _now_iso(),
    })
    emitter = _RecordingEmitter()
    cloud = _RecordingCloudClient()
    handler = _make_handler(
        conn, tmp_path,
        cloud_client=cloud, poller=poller, cloud_emitter=emitter,
    )

    resp, status = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": "scale-03",  # live_scale → 'single_item' storage id
        "event_seq": 1,
        "delta_g": -120.0,
        "before_weight_g": 120.0,
        "after_weight_g": 0.0,
    })

    assert status == 200
    assert resp.get("suppressed") == "livetrack_wizard_active"
    # No scale_events row.
    assert _scale_row_count(conn) == 0
    # No cloud emit at all — neither outbox row nor direct emitter call.
    assert emitter.emits == []


def test_wizard_active_catch_all_non_waiting_scale_suppressed(tmp_path):
    """catch_all events land in this gate when wizard is in a non-
    waiting_scale state. The specific waiting_scale branch (tested in
    test_livetrack_intercept) does NOT fire here."""
    conn = init_db(":memory:")
    poller = _StubPoller({
        "session_id": "sess-1",
        "state": "scale_reading_received",
        "created_at": _now_iso(),
    })
    cloud = _RecordingCloudClient()
    handler = _make_handler(
        conn, tmp_path, cloud_client=cloud, poller=poller,
    )

    resp, status = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": "scale-02",  # catch_all
        "event_seq": 1,
        "delta_g": 50.0,
        "before_weight_g": 314.0,
        "after_weight_g": 364.0,
    })

    assert status == 200
    assert resp.get("suppressed") == "livetrack_wizard_active"
    assert _scale_row_count(conn) == 0
    # The waiting_scale-specific intercept did NOT POST (wrong state).
    assert cloud.livetrack_updates == []


def test_wizard_active_noise_event_suppressed(tmp_path):
    """Noise events are also suppressed — they would otherwise write a
    scale_events row + bump app_state, both pointless during a wizard."""
    conn = init_db(":memory:")
    poller = _StubPoller({
        "session_id": "sess-1",
        "state": "waiting_barcode",
        "created_at": _now_iso(),
    })
    handler = _make_handler(conn, tmp_path, poller=poller)

    resp, status = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": "scale-01",
        "event_seq": 1,
        "delta_g": 1.5,  # below threshold
        "before_weight_g": 0.0,
        "after_weight_g": 1.5,
    })

    assert status == 200
    assert resp.get("suppressed") == "livetrack_wizard_active"
    assert _scale_row_count(conn) == 0


# ---------------------------------------------------------------------------
# Negative: wizard inactive → pipeline runs normally
# ---------------------------------------------------------------------------


def test_no_poller_attached_does_not_suppress(tmp_path):
    """Pre-wiring / cloud-disabled deployments — no poller → never
    suppressed, classic behavior preserved."""
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)  # no poller

    resp, status = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": "scale-01",
        "event_seq": 1,
        "delta_g": 314.0,
        "before_weight_g": 0.0,
        "after_weight_g": 314.0,
    })

    assert status == 200
    assert "suppressed" not in resp
    # Normal pipeline ran: scale_events row created.
    assert _scale_row_count(conn) == 1


def test_poller_snapshot_none_does_not_suppress(tmp_path):
    """No active session → pipeline runs."""
    conn = init_db(":memory:")
    poller = _StubPoller(None)
    handler = _make_handler(conn, tmp_path, poller=poller)

    resp, status = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": "scale-01",
        "event_seq": 1,
        "delta_g": 314.0,
        "before_weight_g": 0.0,
        "after_weight_g": 314.0,
    })

    assert status == 200
    assert "suppressed" not in resp
    assert _scale_row_count(conn) == 1


@pytest.mark.parametrize("terminal_state", ["closed", "expired"])
def test_terminal_state_does_not_suppress(tmp_path, terminal_state):
    """Terminal states are NOT in the active set — pipeline runs.
    In practice the cloud filters these out of /active, but guard
    against a stale snapshot anyway."""
    conn = init_db(":memory:")
    poller = _StubPoller({
        "session_id": "sess-1",
        "state": terminal_state,
        "created_at": _now_iso(),
    })
    handler = _make_handler(conn, tmp_path, poller=poller)

    resp, status = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": "scale-01",
        "event_seq": 1,
        "delta_g": 314.0,
        "before_weight_g": 0.0,
        "after_weight_g": 314.0,
    })

    assert status == 200
    assert "suppressed" not in resp
    assert _scale_row_count(conn) == 1


def test_stale_snapshot_beyond_safety_timeout_does_not_suppress(tmp_path):
    """Defensive Pi-side ceiling: if created_at is older than 15 min,
    refuse to suppress — protects against a dead poll thread freezing
    the event pipeline indefinitely."""
    conn = init_db(":memory:")
    # 20 minutes ago — well past the 15min ceiling.
    stale_ts = (
        _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(minutes=20)
    ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    poller = _StubPoller({
        "session_id": "sess-1",
        "state": "waiting_barcode",
        "created_at": stale_ts,
    })
    handler = _make_handler(conn, tmp_path, poller=poller)

    resp, status = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": "scale-01",
        "event_seq": 1,
        "delta_g": 314.0,
        "before_weight_g": 0.0,
        "after_weight_g": 314.0,
    })

    assert status == 200
    assert "suppressed" not in resp
    # Normal pipeline ran despite active-looking snapshot.
    assert _scale_row_count(conn) == 1


def test_poller_snapshot_raises_treated_as_inactive(tmp_path):
    """A broken poller must never crash the handler — return inactive."""
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path, poller=_RaisingPoller())

    resp, status = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": "scale-01",
        "event_seq": 1,
        "delta_g": 314.0,
        "before_weight_g": 0.0,
        "after_weight_g": 314.0,
    })

    assert status == 200
    assert "suppressed" not in resp
    assert _scale_row_count(conn) == 1


# ---------------------------------------------------------------------------
# Transition: once wizard ends, next event runs the pipeline
# ---------------------------------------------------------------------------


def test_event_after_wizard_ends_runs_normal_pipeline(tmp_path):
    """Wizard active for event #1 → suppressed.
    Wizard flips to closed → event #2 runs the pipeline normally."""
    conn = init_db(":memory:")
    poller = _StubPoller({
        "session_id": "sess-1",
        "state": "waiting_barcode",
        "created_at": _now_iso(),
    })
    handler = _make_handler(conn, tmp_path, poller=poller)

    resp1, status1 = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": "scale-01",
        "event_seq": 1,
        "delta_g": 100.0,
        "before_weight_g": 0.0,
        "after_weight_g": 100.0,
    })
    assert status1 == 200
    assert resp1.get("suppressed") == "livetrack_wizard_active"
    assert _scale_row_count(conn) == 0

    # Wizard ends — poller now returns None (cloud filters terminal
    # states out of /active, so the poll_once callback clears the
    # snapshot).
    poller.set_snapshot(None)

    resp2, status2 = handler.handle_scale_event({
        "ts": _now_iso(offset_s=1.0),
        "device_id": "scale-01",
        "event_seq": 2,
        "delta_g": 200.0,
        "before_weight_g": 100.0,
        "after_weight_g": 300.0,
    })
    assert status2 == 200
    assert "suppressed" not in resp2
    # Full pipeline wrote the second event's scale_events row.
    assert _scale_row_count(conn) == 1
