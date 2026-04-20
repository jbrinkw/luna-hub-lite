#!/usr/bin/env python3
"""
Fridge-cam daemon.

Captures a continuous stream from a USB camera, detects door-open sessions via
frame brightness, records each session as MP4 plus before/after JPEGs, and
exposes a local web UI for live preview and event review.

Single process, two threads:
    - capture_thread: pulls frames, runs brightness state machine,
      writes frames to an active VideoWriter when the door is open.
    - Flask main thread: serves the web UI + JSON API.

Designed to run identically on a Raspberry Pi Zero 2W and any Linux/macOS
dev machine with a USB webcam. No Supabase, no scale correlation, no VLM --
pure local capture + event artifacts + browser dashboard.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np
from flask import (
    Flask,
    Response,
    abort,
    jsonify,
    render_template,
    request,
    send_from_directory,
)

# ---------------------------------------------------------------------------
# Paths + logging
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
EVENTS_DIR = BASE_DIR / "events"
CONFIG_PATH = BASE_DIR / "config.json"
EVENTS_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("fridge-cam")

# ---------------------------------------------------------------------------
# Defaults + config load/save
# ---------------------------------------------------------------------------

DEFAULT_CONFIG: dict[str, Any] = {
    "camera_index": 0,
    "resolution_width": 1280,
    "resolution_height": 720,
    "capture_fps": 5,
    "brightness_threshold": 60,
    "brightness_hysteresis": 20,
    "debounce_seconds": 2,
    "brightness_detection_enabled": True,
    "before_frame_offset_seconds": 1.5,
    "web_port": 8000,
}

# Keys that are writable at runtime via POST /api/config.
MUTABLE_KEYS = {
    "brightness_threshold",
    "brightness_hysteresis",
    "debounce_seconds",
    "brightness_detection_enabled",
    "before_frame_offset_seconds",
    "capture_fps",
}

# Config keys that require a camera restart to take effect.
CAMERA_RESTART_KEYS = {
    "camera_index",
    "resolution_width",
    "resolution_height",
    "capture_fps",
}


def load_config() -> dict[str, Any]:
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            with CONFIG_PATH.open("r", encoding="utf-8") as fh:
                user = json.load(fh)
            if isinstance(user, dict):
                cfg.update({k: v for k, v in user.items() if k in DEFAULT_CONFIG})
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("failed to read config.json (%s); using defaults", exc)
    return cfg


def save_config(cfg: dict[str, Any]) -> None:
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2, sort_keys=True)
    tmp.replace(CONFIG_PATH)


# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------


class CamState:
    """Thread-safe shared state between the capture thread and Flask."""

    def __init__(self, config: dict[str, Any]):
        self.config = config
        self.config_lock = threading.Lock()

        # Latest frame (BGR uint8) + its capture timestamp. Protected by
        # frame_lock. Readers copy out a compressed JPEG or the ndarray;
        # they never hold the lock while encoding.
        self.latest_frame: Optional[np.ndarray] = None
        self.latest_ts: float = 0.0
        self.frame_lock = threading.Lock()

        # Brightness + door state.
        self.current_brightness: float = 0.0
        self.door_open: bool = False
        self.last_transition_ts: float = 0.0
        self.state_lock = threading.Lock()

        # Active session (set while door is open). Only the capture thread
        # mutates these, but readers grab snapshots under state_lock.
        self.session_event_id: Optional[str] = None
        self.session_started_at: Optional[float] = None
        self.session_brightness_sum: float = 0.0
        self.session_brightness_count: int = 0
        self.session_frame_count: int = 0
        self.session_dir: Optional[Path] = None
        self.writer: Optional[cv2.VideoWriter] = None
        self.actual_width: int = 0
        self.actual_height: int = 0
        self.actual_fps: float = 0.0

        # Manual trigger flags (main thread sets, capture thread acts).
        self.manual_start_requested: bool = False
        self.manual_end_requested: bool = False
        self.manual_lock = threading.Lock()

        # Shutdown signalling.
        self.shutdown_event = threading.Event()

        # Total events lifetime counter (recomputed from disk on boot).
        self.total_events: int = count_events_on_disk()

    # --- config access -----------------------------------------------------

    def snapshot_config(self) -> dict[str, Any]:
        with self.config_lock:
            return dict(self.config)

    def update_config(self, updates: dict[str, Any]) -> dict[str, Any]:
        with self.config_lock:
            self.config.update(updates)
            save_config(self.config)
            return dict(self.config)


def count_events_on_disk() -> int:
    if not EVENTS_DIR.exists():
        return 0
    return sum(1 for p in EVENTS_DIR.iterdir() if p.is_dir())


# ---------------------------------------------------------------------------
# Brightness + capture thread
# ---------------------------------------------------------------------------


def compute_brightness(frame: np.ndarray) -> float:
    """Downsample to 160x120 grayscale and return mean brightness 0-255."""
    small = cv2.resize(frame, (160, 120), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    return float(gray.mean())


def generate_event_id() -> str:
    # ISO8601 UTC compact: 20260414T183045Z
    now = datetime.now(timezone.utc)
    return now.strftime("%Y%m%dT%H%M%SZ")


def open_camera(cfg: dict[str, Any]) -> cv2.VideoCapture:
    idx = int(cfg["camera_index"])
    cap = cv2.VideoCapture(idx)
    if not cap.isOpened():
        # Try alternate backends before giving up (helps on some Linux boxes).
        for backend in (cv2.CAP_V4L2, cv2.CAP_ANY):
            cap.release()
            cap = cv2.VideoCapture(idx, backend)
            if cap.isOpened():
                break
    if not cap.isOpened():
        raise RuntimeError(
            f"could not open camera index {idx}. Check that a USB camera is "
            f"connected and that no other process is holding it."
        )
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, int(cfg["resolution_width"]))
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, int(cfg["resolution_height"]))
    cap.set(cv2.CAP_PROP_FPS, float(cfg["capture_fps"]))
    return cap


def capture_thread_main(state: CamState) -> None:
    """Main loop for the capture/recording thread."""
    log.info("capture thread starting")
    consecutive_failures = 0
    cap: Optional[cv2.VideoCapture] = None
    current_cam_cfg: dict[str, Any] = {}

    while not state.shutdown_event.is_set():
        # (Re)open the camera if needed or if camera-affecting config changed.
        cfg = state.snapshot_config()
        cam_cfg = {k: cfg[k] for k in CAMERA_RESTART_KEYS}
        if cap is None or cam_cfg != current_cam_cfg:
            if cap is not None:
                log.info("camera config changed, reopening")
                try:
                    cap.release()
                except Exception:
                    pass
                cap = None
            try:
                cap = open_camera(cfg)
            except RuntimeError as exc:
                log.error("%s", exc)
                # Sleep and retry; keep the daemon running so the web UI
                # stays up and the user can fix the config.
                if state.shutdown_event.wait(2.0):
                    break
                continue
            current_cam_cfg = cam_cfg
            w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or int(cfg["resolution_width"])
            h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or int(cfg["resolution_height"])
            reported_fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
            fps = reported_fps if reported_fps > 0.5 else float(cfg["capture_fps"])
            with state.state_lock:
                state.actual_width = w
                state.actual_height = h
                state.actual_fps = fps
            log.info("camera opened: %dx%d @ %.2f fps", w, h, fps)

        target_fps = max(1.0, float(cfg["capture_fps"]))
        frame_period = 1.0 / target_fps

        loop_start = time.monotonic()
        ok, frame = cap.read()
        if not ok or frame is None:
            consecutive_failures += 1
            log.warning("frame grab failed (%d)", consecutive_failures)
            if consecutive_failures >= 10:
                log.error("too many consecutive frame failures; reopening camera")
                try:
                    cap.release()
                except Exception:
                    pass
                cap = None
                consecutive_failures = 0
            # Small backoff so we don't busy-loop on a dead camera.
            if state.shutdown_event.wait(0.2):
                break
            continue
        consecutive_failures = 0

        now_wall = time.time()
        brightness = compute_brightness(frame)

        # Publish latest frame for the MJPEG stream.
        with state.frame_lock:
            state.latest_frame = frame
            state.latest_ts = now_wall

        # Door state machine + manual triggers.
        _handle_state_transitions(state, cfg, brightness, now_wall, frame)

        # If we're recording, write this frame + accumulate brightness.
        with state.state_lock:
            writer = state.writer
            if writer is not None:
                try:
                    writer.write(frame)
                    state.session_frame_count += 1
                    state.session_brightness_sum += brightness
                    state.session_brightness_count += 1
                except Exception as exc:  # pragma: no cover - runtime guard
                    log.error("writer.write failed: %s", exc)

            state.current_brightness = brightness

        # Pace the loop to target fps. Sleep in small chunks so shutdown
        # is responsive.
        elapsed = time.monotonic() - loop_start
        remaining = frame_period - elapsed
        if remaining > 0:
            if state.shutdown_event.wait(remaining):
                break

    # Shutdown: release writer + camera cleanly.
    log.info("capture thread exiting")
    try:
        with state.state_lock:
            if state.writer is not None:
                state.writer.release()
                state.writer = None
    except Exception as exc:
        log.warning("error releasing writer during shutdown: %s", exc)
    if cap is not None:
        try:
            cap.release()
        except Exception:
            pass


def _handle_state_transitions(
    state: CamState,
    cfg: dict[str, Any],
    brightness: float,
    now_wall: float,
    frame: np.ndarray,
) -> None:
    """Inspect brightness + manual trigger flags, fire open/close handlers."""

    threshold = float(cfg["brightness_threshold"])
    hysteresis = float(cfg["brightness_hysteresis"])
    debounce = float(cfg["debounce_seconds"])
    detection_on = bool(cfg["brightness_detection_enabled"])

    # Pull manual trigger flags.
    with state.manual_lock:
        manual_start = state.manual_start_requested
        manual_end = state.manual_end_requested
        state.manual_start_requested = False
        state.manual_end_requested = False

    with state.state_lock:
        door_open = state.door_open
        last_transition = state.last_transition_ts

    wants_open = False
    wants_close = False
    open_cause = ""
    close_cause = ""

    if detection_on:
        # Brightness-driven transitions (with hysteresis).
        if not door_open and brightness > (threshold + hysteresis / 2.0):
            wants_open = True
            open_cause = "brightness"
        elif door_open and brightness < (threshold - hysteresis / 2.0):
            wants_close = True
            close_cause = "brightness"

    # Manual triggers always win.
    if manual_start and not door_open:
        wants_open = True
        open_cause = "manual"
    if manual_end and door_open:
        wants_close = True
        close_cause = "manual"

    if not wants_open and not wants_close:
        return

    # Debounce: ignore transitions within debounce window of the last one,
    # unless this one is manual (we always honor manual triggers).
    age = now_wall - last_transition
    if age < debounce and open_cause != "manual" and close_cause != "manual":
        return

    if wants_open:
        _start_session(state, cfg, now_wall, brightness, open_cause)
    elif wants_close:
        _end_session(state, now_wall, close_cause)


def _start_session(
    state: CamState,
    cfg: dict[str, Any],
    now_wall: float,
    brightness: float,
    cause: str,
) -> None:
    """Open a new session directory + VideoWriter."""
    event_id = generate_event_id()
    session_dir = EVENTS_DIR / event_id
    # Guard against collisions if two events happen in the same second.
    suffix = 0
    while session_dir.exists():
        suffix += 1
        session_dir = EVENTS_DIR / f"{event_id}-{suffix}"
    session_dir.mkdir(parents=True, exist_ok=True)
    if suffix:
        event_id = session_dir.name

    with state.state_lock:
        width = state.actual_width or int(cfg["resolution_width"])
        height = state.actual_height or int(cfg["resolution_height"])
        fps = state.actual_fps or float(cfg["capture_fps"])

    video_path = session_dir / "session.mp4"
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(video_path), fourcc, fps, (width, height))
    if not writer.isOpened():
        log.error("failed to open VideoWriter for %s; aborting session", video_path)
        try:
            session_dir.rmdir()
        except OSError:
            pass
        return

    with state.state_lock:
        state.door_open = True
        state.last_transition_ts = now_wall
        state.session_event_id = event_id
        state.session_started_at = now_wall
        state.session_brightness_sum = brightness
        state.session_brightness_count = 1
        state.session_frame_count = 0
        state.session_dir = session_dir
        state.writer = writer

    log.info(
        "DOOR OPEN (%s) -> event %s @ %dx%d %.2ffps", cause, event_id, width, height, fps
    )


def _end_session(state: CamState, now_wall: float, cause: str) -> None:
    """Finalize the active session: release writer, extract artifacts, write meta."""

    with state.state_lock:
        if state.writer is None:
            state.door_open = False
            state.last_transition_ts = now_wall
            return
        writer = state.writer
        event_id = state.session_event_id
        started_at = state.session_started_at
        session_dir = state.session_dir
        frame_count = state.session_frame_count
        b_sum = state.session_brightness_sum
        b_cnt = state.session_brightness_count
        fps = state.actual_fps
        width = state.actual_width
        height = state.actual_height

        state.door_open = False
        state.last_transition_ts = now_wall
        state.writer = None
        state.session_event_id = None
        state.session_started_at = None
        state.session_dir = None
        state.session_frame_count = 0
        state.session_brightness_sum = 0.0
        state.session_brightness_count = 0

    try:
        writer.release()
    except Exception as exc:
        log.warning("writer.release error: %s", exc)

    if event_id is None or session_dir is None or started_at is None:
        return

    duration = max(0.0, now_wall - started_at)
    avg_b = (b_sum / b_cnt) if b_cnt > 0 else 0.0

    log.info(
        "DOOR CLOSE (%s) -> event %s, duration %.2fs, frames %d",
        cause, event_id, duration, frame_count,
    )

    cfg = state.snapshot_config()
    before_offset = float(cfg["before_frame_offset_seconds"])

    # Re-open the freshly-written video to extract before/after frames.
    video_path = session_dir / "session.mp4"
    before_saved = _extract_before_after(video_path, session_dir, fps, before_offset)

    meta = {
        "event_id": event_id,
        "started_at": _iso(started_at),
        "ended_at": _iso(now_wall),
        "duration_s": round(duration, 3),
        "avg_brightness_during": round(avg_b, 2),
        "fps": round(fps, 3),
        "resolution": [int(width), int(height)],
        "frame_count": int(frame_count),
        "cause": cause,
        "artifacts": {
            "session_mp4": "session.mp4" if video_path.exists() else None,
            "before_jpg": "before.jpg" if before_saved else None,
            "after_jpg": "after.jpg" if (session_dir / "after.jpg").exists() else None,
        },
    }
    with (session_dir / "meta.json").open("w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)

    state.total_events = count_events_on_disk()


def _extract_before_after(
    video_path: Path, session_dir: Path, fps: float, before_offset: float
) -> bool:
    """Re-read the session video and write before.jpg + after.jpg. Returns
    True if the before frame was saved (after is best-effort if the video
    has any frames at all)."""

    if not video_path.exists() or video_path.stat().st_size == 0:
        log.warning("session video %s missing or empty; skipping artifact extraction", video_path)
        return False

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        log.warning("could not reopen session video for artifact extraction: %s", video_path)
        return False

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    effective_fps = fps if fps > 0.5 else (cap.get(cv2.CAP_PROP_FPS) or 5.0)
    target_before_idx = int(max(0, round(effective_fps * before_offset)))
    # If the clip is too short, fall back to first frame.
    if total_frames > 0 and target_before_idx >= total_frames:
        target_before_idx = 0

    before_saved = False
    last_frame: Optional[np.ndarray] = None
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok or frame is None:
            break
        if idx == target_before_idx and not before_saved:
            cv2.imwrite(str(session_dir / "before.jpg"), frame,
                        [cv2.IMWRITE_JPEG_QUALITY, 90])
            before_saved = True
        last_frame = frame
        idx += 1
    cap.release()

    # Fallback: if we never hit the target index (short clip), save whatever
    # the last frame is as "before" too.
    if not before_saved and last_frame is not None:
        cv2.imwrite(str(session_dir / "before.jpg"), last_frame,
                    [cv2.IMWRITE_JPEG_QUALITY, 90])
        before_saved = True

    if last_frame is not None:
        cv2.imwrite(str(session_dir / "after.jpg"), last_frame,
                    [cv2.IMWRITE_JPEG_QUALITY, 90])

    return before_saved


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Event listing helpers
# ---------------------------------------------------------------------------


def list_events(limit: Optional[int] = None) -> list[dict[str, Any]]:
    """Return event metadata sorted newest-first."""
    if not EVENTS_DIR.exists():
        return []
    rows: list[dict[str, Any]] = []
    for child in EVENTS_DIR.iterdir():
        if not child.is_dir():
            continue
        meta_path = child / "meta.json"
        if meta_path.exists():
            try:
                with meta_path.open("r", encoding="utf-8") as fh:
                    meta = json.load(fh)
            except (OSError, json.JSONDecodeError):
                meta = {"event_id": child.name, "started_at": None}
        else:
            # Session still in progress or meta missing; synthesize.
            meta = {
                "event_id": child.name,
                "started_at": None,
                "duration_s": None,
                "in_progress": True,
            }
        meta["_dir"] = child.name
        meta["has_before"] = (child / "before.jpg").exists()
        meta["has_after"] = (child / "after.jpg").exists()
        meta["has_video"] = (child / "session.mp4").exists()
        rows.append(meta)

    # Sort by event_id (timestamp prefix) desc -- simple + robust.
    rows.sort(key=lambda r: r.get("event_id") or r.get("_dir") or "", reverse=True)
    if limit is not None:
        rows = rows[:limit]
    return rows


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------


def build_app(state: CamState) -> Flask:
    app = Flask(
        __name__,
        template_folder=str(BASE_DIR / "templates"),
        static_folder=str(BASE_DIR / "static"),
    )

    # --- HTML pages -------------------------------------------------------

    @app.route("/")
    def dashboard() -> Any:
        events = list_events(limit=10)
        return render_template("dashboard.html", events=events)

    @app.route("/events")
    def events_page() -> Any:
        events = list_events()
        return render_template("events.html", events=events)

    @app.route("/event/<event_id>")
    def event_detail(event_id: str) -> Any:
        safe_id = _safe_event_id(event_id)
        if safe_id is None:
            abort(404)
        event_dir = EVENTS_DIR / safe_id
        if not event_dir.is_dir():
            abort(404)
        meta_path = event_dir / "meta.json"
        meta: dict[str, Any]
        if meta_path.exists():
            try:
                with meta_path.open("r", encoding="utf-8") as fh:
                    meta = json.load(fh)
            except (OSError, json.JSONDecodeError):
                meta = {"event_id": safe_id, "error": "meta.json unreadable"}
        else:
            meta = {"event_id": safe_id, "in_progress": True}
        meta["has_before"] = (event_dir / "before.jpg").exists()
        meta["has_after"] = (event_dir / "after.jpg").exists()
        meta["has_video"] = (event_dir / "session.mp4").exists()
        return render_template("event_detail.html", event=meta, event_id=safe_id)

    @app.route("/event/<event_id>/<path:filename>")
    def event_static(event_id: str, filename: str) -> Any:
        safe_id = _safe_event_id(event_id)
        if safe_id is None:
            abort(404)
        # Flask's send_from_directory already blocks traversal, but we
        # normalize the filename too just in case.
        if "/" in filename or "\\" in filename or filename.startswith("."):
            abort(404)
        event_dir = EVENTS_DIR / safe_id
        if not event_dir.is_dir():
            abort(404)
        return send_from_directory(event_dir, filename)

    # --- MJPEG live stream -----------------------------------------------

    @app.route("/live.mjpg")
    def live_mjpeg() -> Any:
        return Response(
            _mjpeg_generator(state),
            mimetype="multipart/x-mixed-replace; boundary=frame",
        )

    # --- API --------------------------------------------------------------

    @app.route("/api/state")
    def api_state() -> Any:
        with state.state_lock:
            payload = {
                "door_open": state.door_open,
                "current_brightness": round(state.current_brightness, 2),
                "total_events": state.total_events,
                "session_event_id": state.session_event_id,
                "session_started_at": _iso(state.session_started_at)
                if state.session_started_at
                else None,
                "resolution": [state.actual_width, state.actual_height],
                "fps": round(state.actual_fps, 3),
            }
        return jsonify(payload)

    @app.route("/api/events")
    def api_events() -> Any:
        limit_raw = request.args.get("limit")
        limit = None
        if limit_raw is not None:
            try:
                limit = max(1, min(1000, int(limit_raw)))
            except ValueError:
                limit = None
        return jsonify({"events": list_events(limit=limit)})

    @app.route("/api/config", methods=["GET", "POST"])
    def api_config() -> Any:
        if request.method == "GET":
            return jsonify(state.snapshot_config())

        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            return jsonify({"error": "expected JSON object"}), 400

        updates: dict[str, Any] = {}
        errors: list[str] = []
        for key, val in body.items():
            if key not in MUTABLE_KEYS:
                errors.append(f"{key} is not a mutable config key")
                continue
            try:
                updates[key] = _coerce_config_value(key, val)
            except ValueError as exc:
                errors.append(f"{key}: {exc}")
        if errors:
            return jsonify({"error": "; ".join(errors)}), 400
        cfg = state.update_config(updates)
        return jsonify(cfg)

    @app.route("/api/trigger/start", methods=["POST"])
    def api_trigger_start() -> Any:
        with state.manual_lock:
            state.manual_start_requested = True
        return jsonify({"ok": True, "requested": "start"})

    @app.route("/api/trigger/end", methods=["POST"])
    def api_trigger_end() -> Any:
        with state.manual_lock:
            state.manual_end_requested = True
        return jsonify({"ok": True, "requested": "end"})

    return app


def _safe_event_id(event_id: str) -> Optional[str]:
    """Whitelist event_id characters to prevent directory traversal."""
    if not event_id or len(event_id) > 64:
        return None
    if not all(c.isalnum() or c in "-_" for c in event_id):
        return None
    return event_id


def _coerce_config_value(key: str, val: Any) -> Any:
    if key == "brightness_detection_enabled":
        if isinstance(val, bool):
            return val
        raise ValueError("expected boolean")
    if key in {"brightness_threshold", "brightness_hysteresis",
               "debounce_seconds", "before_frame_offset_seconds", "capture_fps"}:
        try:
            f = float(val)
        except (TypeError, ValueError) as exc:
            raise ValueError("expected number") from exc
        if f < 0:
            raise ValueError("must be >= 0")
        if key == "capture_fps" and (f < 1 or f > 60):
            raise ValueError("capture_fps must be between 1 and 60")
        if key in {"brightness_threshold", "brightness_hysteresis"} and f > 255:
            raise ValueError("must be <= 255")
        return f
    raise ValueError(f"unknown key {key!r}")


def _mjpeg_generator(state: CamState):
    """Yield boundary-separated JPEGs at ~5-10 fps for the live stream."""
    boundary = b"--frame\r\n"
    target_interval = 1.0 / 8.0  # ~8 fps on the stream itself

    while not state.shutdown_event.is_set():
        loop_start = time.monotonic()
        with state.frame_lock:
            frame = None if state.latest_frame is None else state.latest_frame.copy()
            ts = state.latest_ts
        with state.state_lock:
            brightness = state.current_brightness
            door_open = state.door_open

        jpeg_bytes: bytes
        if frame is None:
            # Render a dark "waiting" placeholder.
            placeholder = np.zeros((240, 320, 3), dtype=np.uint8)
            cv2.putText(
                placeholder, "waiting for camera",
                (20, 125), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                (80, 255, 120), 2, cv2.LINE_AA,
            )
            ok, buf = cv2.imencode(".jpg", placeholder, [cv2.IMWRITE_JPEG_QUALITY, 80])
            jpeg_bytes = buf.tobytes() if ok else b""
        else:
            _overlay_hud(frame, brightness, door_open, ts)
            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            jpeg_bytes = buf.tobytes() if ok else b""

        if jpeg_bytes:
            yield (
                boundary
                + b"Content-Type: image/jpeg\r\n"
                + f"Content-Length: {len(jpeg_bytes)}\r\n\r\n".encode("ascii")
                + jpeg_bytes
                + b"\r\n"
            )

        elapsed = time.monotonic() - loop_start
        remaining = target_interval - elapsed
        if remaining > 0:
            if state.shutdown_event.wait(remaining):
                break


def _overlay_hud(frame: np.ndarray, brightness: float, door_open: bool, ts: float) -> None:
    """Draw brightness + door-state overlay onto frame in place."""
    h, w = frame.shape[:2]
    bar_h = 34
    # Semi-transparent black bar at the top.
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (w, bar_h), (0, 0, 0), thickness=-1)
    cv2.addWeighted(overlay, 0.55, frame, 0.45, 0, frame)

    # Door state dot.
    dot_color = (120, 255, 120) if door_open else (90, 90, 90)
    cv2.circle(frame, (18, bar_h // 2), 8, dot_color, thickness=-1)
    state_text = "OPEN" if door_open else "closed"
    cv2.putText(
        frame, f"door: {state_text}",
        (34, bar_h // 2 + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
        (230, 230, 230), 1, cv2.LINE_AA,
    )

    # Brightness readout.
    cv2.putText(
        frame, f"b={brightness:5.1f}",
        (w - 140, bar_h // 2 + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
        (230, 230, 230), 1, cv2.LINE_AA,
    )


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Fridge-cam daemon")
    p.add_argument("--port", type=int, default=None,
                   help="HTTP port (overrides config.web_port)")
    p.add_argument("--camera", type=int, default=None,
                   help="Camera index (overrides config.camera_index)")
    p.add_argument("--host", type=str, default="0.0.0.0",
                   help="Bind address for the web server (default: 0.0.0.0)")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    cfg = load_config()
    if args.port is not None:
        cfg["web_port"] = args.port
    if args.camera is not None:
        cfg["camera_index"] = args.camera
    # Always persist any effective CLI overrides + defaults.
    save_config(cfg)

    state = CamState(cfg)
    app = build_app(state)

    # Start capture thread.
    t = threading.Thread(target=capture_thread_main, args=(state,),
                         name="capture", daemon=True)
    t.start()

    # Signal handlers for graceful shutdown.
    def _shutdown(signum, _frame):  # type: ignore[no-untyped-def]
        log.info("signal %s received, shutting down", signum)
        state.shutdown_event.set()
        # If we were mid-session, finalize it. The capture thread releases
        # the writer; we also attempt one last graceful end_session so meta
        # is written.
        try:
            with state.state_lock:
                if state.writer is not None:
                    state.writer.release()
                    state.writer = None
        except Exception:
            pass
        # Exit after a tiny grace period so Flask can finish in-flight reqs.
        def _exit():
            time.sleep(0.3)
            os._exit(0)
        threading.Thread(target=_exit, daemon=True).start()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    port = int(cfg["web_port"])
    host = args.host
    log.info("fridge-cam daemon listening on http://%s:%d", host, port)
    log.info("events directory: %s", EVENTS_DIR)

    try:
        # threaded=True so MJPEG stream + API calls don't block each other.
        app.run(host=host, port=port, threaded=True, debug=False,
                use_reloader=False)
    except OSError as exc:
        log.error("failed to start Flask: %s", exc)
        state.shutdown_event.set()
        return 1
    finally:
        state.shutdown_event.set()
        t.join(timeout=3.0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
