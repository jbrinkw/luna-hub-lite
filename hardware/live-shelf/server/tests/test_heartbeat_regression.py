"""Guard: a stale heartbeat must not regress ``last_scale_weight_g``.

Scenario: a scale event at ts=T+5s just committed after_weight_g=500 to
app_state.last_scale_weight_g. A heartbeat whose ESP sample was taken
slightly before the event (ts=T+0) arrives afterward and would, under
last-write-wins, overwrite with the pre-settle value (100). The handler
compares heartbeat ts against app_state.last_scale_event_ts and skips
the weight update if ts is strictly older.
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
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import AppStatePatch  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_runtime_state():
    """Heartbeats populate module-level _SCALE_RUNTIME_STATE + _WEIGHT_TRACE;
    reset between tests so one test's writes don't bleed into another's
    assertions."""
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


def test_heartbeat_older_than_last_event_ts_does_not_regress_weight(tmp_path: Path):
    """Pre-seed last_scale_event_ts=T+5s, last_scale_weight_g=500. A
    heartbeat with ts=T+0 and weight_g=100 arrives — last_scale_weight_g
    must STAY 500. A later heartbeat with ts=T+10s and weight_g=200 must
    succeed (200).
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)

    # Seed the post-event state.
    event_ts = "2026-04-15T12:00:05.000Z"
    with conn:
        storage_repo.update_app_state(
            conn,
            AppStatePatch(
                last_scale_weight_g=500.0,
                last_scale_event_ts=event_ts,
            ),
        )

    # Stale heartbeat (older than the event).
    stale_hb = {
        "ts": "2026-04-15T12:00:00.000Z",  # T+0 < T+5
        "device_id": "scale-01",
        "weight_g": 100.0,
        "stable": True,
        "uptime_s": 60,
    }
    resp, status = handler.handle_heartbeat(stale_hb)
    assert status == 200
    weight_after_stale = storage_repo.get_app_state(conn).last_scale_weight_g
    assert weight_after_stale == pytest.approx(500.0), (
        f"stale heartbeat should NOT regress last_scale_weight_g; "
        f"got {weight_after_stale}"
    )

    # Fresh heartbeat (newer than the event).
    fresh_hb = {
        "ts": "2026-04-15T12:00:10.000Z",  # T+10 > T+5
        "device_id": "scale-01",
        "weight_g": 200.0,
        "stable": True,
        "uptime_s": 65,
    }
    resp, status = handler.handle_heartbeat(fresh_hb)
    assert status == 200
    weight_after_fresh = storage_repo.get_app_state(conn).last_scale_weight_g
    assert weight_after_fresh == pytest.approx(200.0)
