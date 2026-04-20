"""ESP reboot must purge the dedup LRU.

When the ESP reboots, its ``event_seq`` counter resets to 0. Without
purging the LRU entry for ``(device_id, 0)``, the first post-reboot
event would collide with the pre-reboot entry and be silently deduped
(returned as a duplicate, event never reprocessed).

Reboot detection compares uptime_s — a decreasing value across two
heartbeats indicates a reboot.
"""

from __future__ import annotations

import sqlite3
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.handlers import scale_events as scale_events_mod  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.storage import init_db  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_runtime_state():
    scale_events_mod._SCALE_RUNTIME_STATE.clear()
    scale_events_mod._WEIGHT_TRACE.clear()
    yield
    scale_events_mod._SCALE_RUNTIME_STATE.clear()
    scale_events_mod._WEIGHT_TRACE.clear()


def _make_handler(conn: sqlite3.Connection, tmp_path: Path) -> ScaleHandler:
    class _NullCandidateSource:
        def get_on_shelf_lots(self):
            return []

        def get_recently_out_lots(self, window_seconds):
            return []

        def get_certified_not_on_shelf(self):
            return []

    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    return ScaleHandler(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
    )


def test_esp_reboot_purges_dedup_lru(tmp_path: Path):
    """Pre-seed an LRU entry for (scale-01, 0). Heartbeat with uptime=100
    then heartbeat with uptime=5 (reboot indicator). Finally post a
    scale-event with event_seq=0 — it must be processed, NOT returned as
    a duplicate.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)

    # Pre-seed the LRU by calling _dedup_set directly (mimicking an old
    # event that landed before the reboot).
    handler._dedup_set(("scale-01", 0), "old-event-id")
    assert handler._dedup_get(("scale-01", 0)) == "old-event-id"

    # Heartbeat at high uptime (no reboot yet).
    _, s1 = handler.handle_heartbeat({
        "ts": "2026-04-15T12:00:00.000Z",
        "device_id": "scale-01",
        "weight_g": 400.0,
        "stable": True,
        "uptime_s": 100,
    })
    assert s1 == 200
    # LRU should still have the old entry.
    assert handler._dedup_get(("scale-01", 0)) == "old-event-id"

    # Reboot heartbeat — uptime dropped (5 < 100).
    _, s2 = handler.handle_heartbeat({
        "ts": "2026-04-15T12:00:05.000Z",
        "device_id": "scale-01",
        "weight_g": 400.0,
        "stable": True,
        "uptime_s": 5,
    })
    assert s2 == 200
    # After reboot detection, the LRU entry for scale-01 must be gone.
    assert handler._dedup_get(("scale-01", 0)) is None, (
        "reboot should purge the dedup LRU entry"
    )

    # Now post a scale-event with event_seq=0 — it must be processed,
    # NOT returned as a duplicate (which would happen if the stale LRU
    # entry were still present).
    resp, status = handler.handle_scale_event({
        "ts": "2026-04-15T12:00:10.000Z",
        "device_id": "scale-01",
        "delta_g": -100.0,
        "before_weight_g": 400.0,
        "after_weight_g": 300.0,
        "event_seq": 0,
        "stable_samples": 8,
    })
    assert status == 200
    assert resp.get("duplicate") is not True, (
        f"post-reboot event_seq=0 must NOT be deduped; got {resp}"
    )
    # And the new event_id must be freshly-minted (not the stale one).
    assert resp["event_id"] != "old-event-id"
