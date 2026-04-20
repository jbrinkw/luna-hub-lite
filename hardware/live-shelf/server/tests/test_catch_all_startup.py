"""``create_app`` wiring for the catch-all shelf (CATCH_ALL_SCALE_PLAN.md §5).

Covers:

* flag OFF  → no second CameraDaemon, no WeightHandler, single-camera registry
* flag ON + camera factory fails → WARNING logged, catch_all_camera = None,
  WeightHandler still installed, /live.mjpg?shelf=catch_all returns 503
* flag ON + camera constructed → both daemons registered, weight_handler wired,
  /live.mjpg?shelf=catch_all yields a streaming response
* ``POST /api/scale-heartbeat`` for device_id='scale-02' rising above the
  threshold opens a catch_all session via the middleware tap
"""

from __future__ import annotations

import logging
import sys
import threading
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.app import create_app  # noqa: E402
from server.camera.daemon import CameraDaemon, DaemonConfig  # noqa: E402
from server.config import AppConfig  # noqa: E402
from server.storage import init_db  # noqa: E402


# --------------------------------------------------------------- helpers


class _FakeCamera:
    """Stand-in for the live-shelf CameraDaemon — identical shape to the
    one in ``test_app_startup.py``. Works for both primary and catch-all
    slots (we just don't use brightness / session_capture on the latter).
    """

    def __init__(self) -> None:
        self.shutdown_event = threading.Event()
        self._subs: list = []
        self._frame_subs: list = []
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

    def on_frame(self, cb):
        self._frame_subs.append(cb)

    def remove_frame_subscriber(self, cb):
        try:
            self._frame_subs.remove(cb)
            return True
        except ValueError:
            return False

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


def _make_cfg(tmp_path: Path, **overrides: Any) -> AppConfig:
    cfg = AppConfig()
    cfg.data_root = tmp_path
    cfg.refs_root = tmp_path / "refs"
    cfg.events_root = tmp_path / "events"
    cfg.db_path = tmp_path / "shelf.sqlite3"
    cfg.anthropic_api_key = "test-key"
    # The catch-all middleware threshold — small so tests can cross it.
    cfg.catch_all_onscale_threshold_g = 5.0
    cfg.catch_all_device_id = "scale-02"
    for k, v in overrides.items():
        setattr(cfg, k, v)
    return cfg


# --------------------------------------------------------------- flag OFF


def test_app_startup_with_catch_all_disabled_skips_second_camera(tmp_path: Path):
    cfg = _make_cfg(tmp_path, catch_all_enabled=False)
    bundle = create_app(
        config=cfg,
        camera=_FakeCamera(),  # type: ignore[arg-type]
        conn=init_db(str(cfg.db_path)),
        classifier_client=None,
        apply_v4l2=False,
        start_camera=False,
    )
    try:
        assert bundle.catch_all_camera is None
        assert bundle.weight_handler is None

        reg = bundle.app.extensions["shelf_cameras"]
        assert set(reg.keys()) == {"live_shelf", "catch_all"}
        assert reg["live_shelf"] is bundle.camera
        assert reg["catch_all"] is None

        # MJPEG endpoint: default → 200 stream; shelf=catch_all → 503.
        client = bundle.app.test_client()
        default_resp = client.get("/live.mjpg")
        # We don't iterate the stream (would block); just confirm 200 +
        # the right mimetype.
        assert default_resp.status_code == 200
        assert "multipart" in default_resp.headers.get("Content-Type", "")
        default_resp.close()

        catch_resp = client.get("/live.mjpg?shelf=catch_all")
        assert catch_resp.status_code == 503
        body = catch_resp.get_json()
        assert body is not None and "no camera" in body.get("error", "").lower()
    finally:
        bundle.shutdown()


# --------------------------------------------------------------- flag ON, hardware missing


def test_app_startup_with_catch_all_enabled_but_device_missing_logs_warning(
    tmp_path: Path, caplog, monkeypatch,
):
    """Force CameraDaemon construction to raise for the catch-all daemon.
    The app must still boot, log a WARNING, and set ``catch_all_camera=None``.
    """
    cfg = _make_cfg(
        tmp_path,
        catch_all_enabled=True,
        catch_all_camera_device="/dev/video2",
    )

    # Patch CameraDaemon *as imported by server.app* so the live-shelf
    # default (constructed from cfg.camera_index) path is untouched — we
    # pass in a fake for that via the ``camera=`` kwarg, which short-
    # circuits the `camera is None` branch. Only the second
    # construction (inside the catch_all_enabled block) triggers the
    # patched factory below, which raises on any call.
    import server.app as app_mod
    original = app_mod.CameraDaemon

    def _raising_daemon(*args, **kwargs):
        raise RuntimeError("simulated /dev/video2 missing")

    monkeypatch.setattr(app_mod, "CameraDaemon", _raising_daemon)

    caplog.set_level(logging.WARNING)
    bundle = create_app(
        config=cfg,
        camera=_FakeCamera(),  # type: ignore[arg-type]
        conn=init_db(str(cfg.db_path)),
        classifier_client=None,
        apply_v4l2=False,
        start_camera=False,
    )
    try:
        assert bundle.catch_all_camera is None
        # WeightHandler is still instantiated — it doesn't need a camera.
        assert bundle.weight_handler is not None

        # The registry still has both keys; catch_all resolves to None.
        reg = bundle.app.extensions["shelf_cameras"]
        assert reg["catch_all"] is None

        # /live.mjpg?shelf=catch_all → 503 because hardware absent.
        client = bundle.app.test_client()
        resp = client.get("/live.mjpg?shelf=catch_all")
        assert resp.status_code == 503

        # A WARNING must have been emitted about the catch-all camera.
        assert any(
            "catch-all" in rec.getMessage().lower()
            and rec.levelno >= logging.WARNING
            for rec in caplog.records
        ), (
            "expected a WARNING log about the catch-all camera; "
            f"got levels={[r.levelname for r in caplog.records]}"
        )
    finally:
        # Restore before shutdown so bundle.shutdown() runs clean.
        monkeypatch.setattr(app_mod, "CameraDaemon", original)
        bundle.shutdown()


# --------------------------------------------------------------- flag ON, hardware present


def test_app_startup_with_catch_all_enabled_and_camera_present(tmp_path: Path):
    """Pass in a fake daemon for BOTH cameras (primary via ``camera=``,
    secondary by monkey-patching the CameraDaemon constructor to return a
    fake). Verify the registry has both entries and the weight_handler
    is wired.
    """
    cfg = _make_cfg(tmp_path, catch_all_enabled=True)

    fake_catch_all = _FakeCamera()
    import server.app as app_mod

    def _fake_daemon(*args, **kwargs):
        return fake_catch_all

    saved = app_mod.CameraDaemon
    app_mod.CameraDaemon = _fake_daemon  # type: ignore[assignment]
    try:
        bundle = create_app(
            config=cfg,
            camera=_FakeCamera(),  # type: ignore[arg-type]
            conn=init_db(str(cfg.db_path)),
            classifier_client=None,
            apply_v4l2=False,
            start_camera=False,
        )
    finally:
        app_mod.CameraDaemon = saved  # type: ignore[assignment]

    try:
        assert bundle.catch_all_camera is fake_catch_all
        assert bundle.weight_handler is not None

        reg = bundle.app.extensions["shelf_cameras"]
        assert reg["live_shelf"] is bundle.camera
        assert reg["catch_all"] is fake_catch_all

        # Both shelf routes should stream successfully.
        client = bundle.app.test_client()
        for shelf in ("live_shelf", "catch_all"):
            resp = client.get(f"/live.mjpg?shelf={shelf}")
            try:
                assert resp.status_code == 200, (shelf, resp.status_code)
                assert "multipart" in resp.headers.get("Content-Type", "")
            finally:
                resp.close()
    finally:
        bundle.shutdown()


# --------------------------------------------------------------- middleware tap


def test_catch_all_heartbeat_opens_session_via_middleware(tmp_path: Path):
    """POST /api/scale-heartbeat with device_id='scale-02' and weight above
    threshold must tip the WeightHandler into opening a catch_all session.
    """
    cfg = _make_cfg(tmp_path, catch_all_enabled=True)

    import server.app as app_mod

    # Patch CameraDaemon so the catch-all construction returns a fake
    # (we don't need a real camera for this test — just the heartbeat
    # middleware wiring).
    saved = app_mod.CameraDaemon
    app_mod.CameraDaemon = lambda *a, **kw: _FakeCamera()  # type: ignore[assignment]
    try:
        bundle = create_app(
            config=cfg,
            camera=_FakeCamera(),  # type: ignore[arg-type]
            conn=init_db(str(cfg.db_path)),
            classifier_client=None,
            apply_v4l2=False,
            start_camera=False,
        )
    finally:
        app_mod.CameraDaemon = saved  # type: ignore[assignment]

    try:
        client = bundle.app.test_client()
        # Above-threshold heartbeat on scale-02.
        resp = client.post(
            "/api/scale-heartbeat",
            json={
                "ts": "2026-04-18T12:00:00.000Z",
                "device_id": "scale-02",
                "weight_g": 10.0,
                "stable": True,
                "uptime_s": 100,
            },
        )
        assert resp.status_code == 200, resp.get_data(as_text=True)

        # The WeightHandler should have flipped app_state.current_catch_all_session_id.
        row = bundle.conn.execute(
            "SELECT current_catch_all_session_id FROM app_state WHERE id = 1"
        ).fetchone()
        assert row[0] is not None

        # live-shelf pointer untouched.
        row2 = bundle.conn.execute(
            "SELECT current_session_id, door_open FROM app_state WHERE id = 1"
        ).fetchone()
        assert row2[0] is None
        assert row2[1] == 0
    finally:
        bundle.shutdown()


def test_heartbeat_from_other_device_does_not_open_catch_all(tmp_path: Path):
    """Heartbeats from scale-01 (live shelf) must NOT trigger the
    catch-all session open path."""
    cfg = _make_cfg(tmp_path, catch_all_enabled=True)

    import server.app as app_mod
    saved = app_mod.CameraDaemon
    app_mod.CameraDaemon = lambda *a, **kw: _FakeCamera()  # type: ignore[assignment]
    try:
        bundle = create_app(
            config=cfg,
            camera=_FakeCamera(),  # type: ignore[arg-type]
            conn=init_db(str(cfg.db_path)),
            classifier_client=None,
            apply_v4l2=False,
            start_camera=False,
        )
    finally:
        app_mod.CameraDaemon = saved  # type: ignore[assignment]

    try:
        client = bundle.app.test_client()
        resp = client.post(
            "/api/scale-heartbeat",
            json={
                "ts": "2026-04-18T12:00:00.000Z",
                "device_id": "scale-01",
                "weight_g": 10.0,
                "stable": True,
                "uptime_s": 100,
            },
        )
        assert resp.status_code == 200, resp.get_data(as_text=True)

        row = bundle.conn.execute(
            "SELECT current_catch_all_session_id FROM app_state WHERE id = 1"
        ).fetchone()
        assert row[0] is None, (
            "scale-01 heartbeat must NOT open a catch-all session; got "
            f"current_catch_all_session_id={row[0]!r}"
        )
    finally:
        bundle.shutdown()
