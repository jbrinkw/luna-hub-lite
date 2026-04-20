"""Flask MJPEG generator for the `/live.mjpg` route (§4.6).

Usage from the Flask blueprint:

    from flask import Response
    from server.camera import mjpeg, extract

    @app.route("/live.mjpg")
    def live() -> Response:
        return Response(
            mjpeg.stream(extract.get_daemon()),
            mimetype="multipart/x-mixed-replace; boundary=frame",
        )

The generator is shutdown-aware: it exits as soon as the daemon's
`shutdown_event` fires, so in-flight stream requests don't block process
termination.

A small HUD (brightness + door state + timestamp) is overlaid on each frame
to make the live dashboard useful for debugging the brightness watcher.
"""

from __future__ import annotations

import logging
import time
from typing import Generator, Mapping, Optional

import cv2
import numpy as np

from .daemon import CameraDaemon

log = logging.getLogger(__name__)

DEFAULT_STREAM_FPS: float = 8.0
DEFAULT_JPEG_QUALITY: int = 80
BOUNDARY = b"--frame"

# Default shelf key when the MJPEG endpoint is hit without ``?shelf=``.
# The live shelf has been the sole camera since day one; catch-all is
# the opt-in second daemon (CATCH_ALL_SCALE_PLAN.md §5.2).
DEFAULT_SHELF_KEY: str = "live_shelf"


def resolve_daemon(
    registry: Mapping[str, Optional[CameraDaemon]],
    shelf: Optional[str],
) -> Optional[CameraDaemon]:
    """Look up the camera daemon for ``shelf`` from a registry.

    Returns:
        * the registered :class:`CameraDaemon` (hardware present + wired)
        * ``None`` if the shelf is registered but the daemon failed to
          initialize (e.g. catch-all enabled but ``/dev/video2`` absent
          at boot) — callers should surface this as HTTP 503
          ("hardware absent").

    Raises:
        KeyError: if ``shelf`` is not present in ``registry`` at all —
            callers should surface this as HTTP 404 ("unknown shelf").
            Distinguishing these two cases at the route layer is the
            whole reason this helper exists; the previous ``None``-for-
            both behaviour collapsed them into an indistinguishable 503.

    ``shelf`` is coerced to :data:`DEFAULT_SHELF_KEY` when falsy so the
    existing ``GET /live.mjpg`` (no query param) keeps returning the
    live-shelf stream without callers having to special-case it.
    """
    key = (shelf or DEFAULT_SHELF_KEY).strip() or DEFAULT_SHELF_KEY
    if key not in registry:
        raise KeyError(key)
    return registry[key]


def _encode_placeholder(text: str) -> bytes:
    """Dark 320×240 placeholder used before the first frame arrives."""
    img = np.zeros((240, 320, 3), dtype=np.uint8)
    cv2.putText(
        img,
        text,
        (16, 125),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.6,
        (120, 220, 140),
        1,
        cv2.LINE_AA,
    )
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 70])
    return buf.tobytes() if ok else b""


def _overlay_hud(
    frame: np.ndarray,
    brightness: float,
    door_open: bool,
    ts_iso: Optional[str],
) -> None:
    """Draw a translucent status bar on the top of `frame` in place."""
    h, w = frame.shape[:2]
    bar_h = 32
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (w, bar_h), (0, 0, 0), thickness=-1)
    cv2.addWeighted(overlay, 0.55, frame, 0.45, 0, frame)

    dot_color = (120, 255, 120) if door_open else (90, 90, 90)
    cv2.circle(frame, (16, bar_h // 2), 7, dot_color, thickness=-1)
    cv2.putText(
        frame,
        "OPEN" if door_open else "closed",
        (30, bar_h // 2 + 5),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.5,
        (230, 230, 230),
        1,
        cv2.LINE_AA,
    )
    cv2.putText(
        frame,
        f"b={brightness:5.1f}",
        (120, bar_h // 2 + 5),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.5,
        (230, 230, 230),
        1,
        cv2.LINE_AA,
    )
    if ts_iso:
        # Show only HH:MM:SS for space; full ts goes to the API.
        short = ts_iso[11:19] if len(ts_iso) >= 19 else ts_iso
        cv2.putText(
            frame,
            short,
            (w - 95, bar_h // 2 + 5),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (230, 230, 230),
            1,
            cv2.LINE_AA,
        )


def _frame_packet(jpeg: bytes) -> bytes:
    return (
        BOUNDARY
        + b"\r\nContent-Type: image/jpeg\r\n"
        + f"Content-Length: {len(jpeg)}\r\n\r\n".encode("ascii")
        + jpeg
        + b"\r\n"
    )


def stream(
    daemon: CameraDaemon,
    *,
    stream_fps: float = DEFAULT_STREAM_FPS,
    quality: int = DEFAULT_JPEG_QUALITY,
    overlay_hud: bool = True,
) -> Generator[bytes, None, None]:
    """Yield multipart/x-mixed-replace chunks for the `/live.mjpg` endpoint.

    The loop terminates when `daemon.shutdown_event` is set, which lets
    Flask shut down in-flight streams at process exit.

    `stream_fps` is capped to `daemon.config.capture_fps` — there's no point
    in streaming faster than we capture. Sub-1 fps is allowed.
    """
    target_fps = min(max(0.5, float(stream_fps)), float(daemon.config.capture_fps))
    period = 1.0 / target_fps

    while not daemon.shutdown_event.is_set():
        loop_start = time.monotonic()
        frame = daemon.current_frame()
        brightness = daemon.current_brightness()
        door_open = daemon.door_open()
        ts_iso = daemon.last_frame_ts

        if frame is None:
            jpeg = _encode_placeholder("waiting for camera")
        else:
            if overlay_hud:
                _overlay_hud(frame, brightness, door_open, ts_iso)
            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
            jpeg = buf.tobytes() if ok else b""

        if jpeg:
            yield _frame_packet(jpeg)

        # Pace the loop, but break early if shutdown is signalled.
        elapsed = time.monotonic() - loop_start
        remaining = period - elapsed
        if remaining > 0:
            if daemon.shutdown_event.wait(remaining):
                break


__all__ = [
    "DEFAULT_JPEG_QUALITY",
    "DEFAULT_SHELF_KEY",
    "DEFAULT_STREAM_FPS",
    "resolve_daemon",
    "stream",
]
