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


def _apply_crop(
    frame: np.ndarray,
    crop: Optional[tuple[float, float, float, float]],
) -> np.ndarray:
    """Return a (possibly same) view of ``frame`` cropped by fractional bounds.

    ``crop`` is ``(y0, y1, x0, x1)`` in [0.0, 1.0]. For example,
    ``(0.20, 1.0, 0.40, 1.0)`` keeps rows [20% ... 100%] and cols
    [40% ... 100%] — i.e. crop 20% off the top and 40% off the left.
    Invalid / out-of-order / empty crops fall back to the full frame.
    """
    if crop is None:
        return frame
    y0, y1, x0, x1 = crop
    h, w = frame.shape[:2]
    y0p = max(0, min(h, int(round(h * y0))))
    y1p = max(0, min(h, int(round(h * y1))))
    x0p = max(0, min(w, int(round(w * x0))))
    x1p = max(0, min(w, int(round(w * x1))))
    if y0p >= y1p or x0p >= x1p:
        return frame  # degenerate — safer to send full frame
    return frame[y0p:y1p, x0p:x1p]


def stream(
    daemon: CameraDaemon,
    *,
    stream_fps: float = DEFAULT_STREAM_FPS,
    quality: int = DEFAULT_JPEG_QUALITY,
    overlay_hud: bool = True,
    crop: Optional[tuple[float, float, float, float]] = None,
) -> Generator[bytes, None, None]:
    """Yield multipart/x-mixed-replace chunks for the `/live.mjpg` endpoint.

    The loop terminates when `daemon.shutdown_event` is set, which lets
    Flask shut down in-flight streams at process exit.

    `stream_fps` is capped to `daemon.config.capture_fps` — there's no point
    in streaming faster than we capture. Sub-1 fps is allowed.

    ``crop`` is applied BEFORE the HUD overlay and JPEG encode, so the
    HUD sits on the cropped framing and downstream consumers never see
    pixels outside the region of interest. See :func:`_apply_crop` for
    the coordinate convention.
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
            cropped = _apply_crop(frame, crop)
            # Copy the crop view so the HUD overlay doesn't mutate the
            # daemon's ring-buffer-owned frame (numpy slices share
            # memory).
            if cropped is frame:
                work = frame
            else:
                work = np.ascontiguousarray(cropped)
            if overlay_hud:
                _overlay_hud(work, brightness, door_open, ts_iso)
            ok, buf = cv2.imencode(".jpg", work, [cv2.IMWRITE_JPEG_QUALITY, quality])
            jpeg = buf.tobytes() if ok else b""

        if jpeg:
            yield _frame_packet(jpeg)

        # Pace the loop, but break early if shutdown is signalled.
        elapsed = time.monotonic() - loop_start
        remaining = period - elapsed
        if remaining > 0:
            if daemon.shutdown_event.wait(remaining):
                break


#: Per-shelf crop overrides for the live MJPEG feed. Each entry is
#: ``(y0, y1, x0, x1)`` in [0, 1]. The live-shelf feed is never cropped —
#: its frames ARE the session archives. The catch-all rig has a wider
#: field of view than we care about (camera sees the counter + some wall
#: + the left edge of the scale board); crop to the scale region so the
#: classifier later sees only the item on the plate.
SHELF_CROPS: dict[str, tuple[float, float, float, float]] = {
    "catch_all": (0.20, 1.0, 0.40, 0.90),  # crop top 20% + left 40% + right 10%
}


__all__ = [
    "DEFAULT_JPEG_QUALITY",
    "DEFAULT_SHELF_KEY",
    "DEFAULT_STREAM_FPS",
    "SHELF_CROPS",
    "resolve_daemon",
    "stream",
]
