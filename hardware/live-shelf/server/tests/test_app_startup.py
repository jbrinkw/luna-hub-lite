"""``create_app`` startup cleanup behaviors.

Two DB-level self-heal paths fire before the Flask app is even wired:

1. Rows stuck at ``classifier_status='classifying'`` — a classifier
   worker killed mid-run (SIGTERM during deploy, crash). Reset to
   'pending' so the sweeper picks them up.

2. Zombie session — process was killed while a session was open.
   ``app_state.current_session_id`` points at a session whose
   ``ended_at`` is NULL. Close the session row + clear the pointer +
   reset door_open.
"""

from __future__ import annotations

import logging
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.app import create_app  # noqa: E402
from server.config import AppConfig  # noqa: E402
from server.storage import init_db  # noqa: E402


class _FakeCamera:
    """Minimal camera stand-in — create_app only needs on_brightness_transition
    to be callable + a few attrs for its health check.
    """

    import threading as _threading

    def __init__(self) -> None:
        self.shutdown_event = self._threading.Event()
        self._subs: list = []
        self.last_frame_ts = None
        self.frames_captured = 0
        self.grab_failures = 0

        class _Cfg:
            brightness_threshold = 15.0
            brightness_hysteresis = 2.0
            capture_fps = 10
        self.config = _Cfg()

    def on_brightness_transition(self, cb):
        self._subs.append(cb)

    def start(self):
        pass

    def join(self, timeout=None):
        pass

    def is_alive(self):
        return True

    def current_frame(self):
        import numpy as np
        return np.zeros((10, 10, 3), dtype=np.uint8)

    def current_frame_jpeg(self, quality: int = 85):
        return b"\xff\xd8\xff\xd9"

    def snapshot_ring(self):
        return []

    def current_brightness(self):
        return 0.0

    def door_open(self):
        return False


def _make_cfg(tmp_path: Path) -> AppConfig:
    cfg = AppConfig()
    cfg.data_root = tmp_path
    cfg.refs_root = tmp_path / "refs"
    cfg.events_root = tmp_path / "events"
    cfg.db_path = tmp_path / "shelf.sqlite3"
    cfg.anthropic_api_key = "test-key"
    return cfg


# ---------------------------------------------------------------------------
# 1. classifying → pending reset
# ---------------------------------------------------------------------------


def test_startup_resets_classifying_to_pending(tmp_path: Path, caplog):
    """Pre-seed a scale_events row with classifier_status='classifying'.
    create_app must reset it to 'pending' and log a warning.
    """
    cfg = _make_cfg(tmp_path)
    conn = init_db(str(cfg.db_path))
    # Seed a row with classifier_status='classifying'.
    conn.execute(
        """
        INSERT INTO scale_events
            (event_id, ts, delta_g, before_weight_g, after_weight_g,
             direction, classifier_status)
        VALUES ('E-stuck', '2026-04-15T12:00:00Z', -100.0, 500.0, 400.0,
                'remove', 'classifying')
        """
    )
    conn.commit()

    caplog.set_level(logging.WARNING)
    bundle = create_app(
        config=cfg,
        camera=_FakeCamera(),  # type: ignore[arg-type]
        conn=conn,
        classifier_client=None,
        apply_v4l2=False,
        start_camera=False,
    )
    try:
        status = conn.execute(
            "SELECT classifier_status FROM scale_events WHERE event_id = ?",
            ("E-stuck",),
        ).fetchone()[0]
        assert status == "pending", (
            f"classifying row should be reset to pending; got {status!r}"
        )
        assert any(
            "classifying" in rec.getMessage() and "pending" in rec.getMessage()
            for rec in caplog.records
        ), "expected warning log about the reset"
    finally:
        bundle.shutdown()


# ---------------------------------------------------------------------------
# 2. Zombie session cleanup
# ---------------------------------------------------------------------------


def test_startup_zombie_session_cleanup(tmp_path: Path):
    """Pre-seed app_state with current_session_id='ghost' + door_open=1
    and a matching sessions row with ended_at=NULL. create_app must
    close the session, clear the pointer, and reset door_open=0.
    """
    cfg = _make_cfg(tmp_path)
    conn = init_db(str(cfg.db_path))

    conn.execute(
        "INSERT INTO sessions (session_id, started_at, ended_at) "
        "VALUES ('ghost', '2026-04-15T12:00:00Z', NULL)"
    )
    conn.execute(
        "UPDATE app_state SET current_session_id = 'ghost', door_open = 1 "
        "WHERE id = 1"
    )
    conn.commit()

    bundle = create_app(
        config=cfg,
        camera=_FakeCamera(),  # type: ignore[arg-type]
        conn=conn,
        classifier_client=None,
        apply_v4l2=False,
        start_camera=False,
    )
    try:
        state_row = conn.execute(
            "SELECT current_session_id, door_open FROM app_state WHERE id = 1"
        ).fetchone()
        assert state_row[0] is None, (
            f"current_session_id should be NULL; got {state_row[0]!r}"
        )
        assert state_row[1] == 0

        ended = conn.execute(
            "SELECT ended_at FROM sessions WHERE session_id = 'ghost'"
        ).fetchone()[0]
        assert ended is not None, "ghost session should be closed (ended_at set)"
    finally:
        bundle.shutdown()
