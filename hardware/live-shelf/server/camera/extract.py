"""Frame extraction helpers built on top of `CameraDaemon`.

The public surface matches §4.4 of the plan:

    frame_at(ts: str, offset_seconds: float = 0) -> str
    current_frame() -> np.ndarray
    current_frame_jpeg() -> bytes

`frame_at(ts)` pulls the frame closest to `ts + offset_seconds` out of the
ring buffer, writes it to `<output_dir>/<ts>.jpg`, and returns the absolute
path. If the closest frame is more than `max_slop_seconds` (default 0.5s)
away from the requested target, we raise `FrameNotAvailableError`.

The module stores a process-wide `_ACTIVE_DAEMON` pointer set by the
orchestrator at startup. Tests and callers that want explicit control should
use the dependency-injection form (`*_with(daemon, ...)`) which takes the
daemon as an argument.
"""

from __future__ import annotations

import logging
import threading
from datetime import timedelta
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

from .daemon import CameraDaemon, find_closest, parse_iso_utc

log = logging.getLogger(__name__)

DEFAULT_MAX_SLOP_SECONDS: float = 0.5
DEFAULT_JPEG_QUALITY: int = 90

# -----------------------------------------------------------------------------
# Exceptions
# -----------------------------------------------------------------------------


class FrameNotAvailableError(Exception):
    """Raised by `frame_at` when the ring buffer has no frame within
    `max_slop_seconds` of the requested timestamp.

    The orchestrator catches this and either:
        * retries after a short wait (ring buffer may not yet contain the
          requested ts — e.g., when asking for the current moment);
        * enqueues a `sensor_anomaly` review item (if the request was for a
          past ts that should already be buffered).
    """

    def __init__(self, requested_ts: str, closest_diff_s: Optional[float]):
        self.requested_ts = requested_ts
        self.closest_diff_s = closest_diff_s
        msg = (
            f"no frame within slop of {requested_ts}; "
            f"closest diff = {closest_diff_s:.3f}s"
            if closest_diff_s is not None
            else f"ring buffer empty (requested {requested_ts})"
        )
        super().__init__(msg)


# -----------------------------------------------------------------------------
# Module-level daemon registration (set by orchestrator)
# -----------------------------------------------------------------------------


_active_lock = threading.Lock()
_ACTIVE_DAEMON: Optional[CameraDaemon] = None


def register_daemon(daemon: CameraDaemon) -> None:
    """Bind a `CameraDaemon` to the module-level accessors.

    The orchestrator calls this once during startup so the Flask route
    handlers can use `frame_at(ts)` / `current_frame()` without having to
    thread the daemon through every call site.
    """
    global _ACTIVE_DAEMON
    with _active_lock:
        _ACTIVE_DAEMON = daemon


def get_daemon() -> CameraDaemon:
    """Return the registered daemon or raise if none has been set."""
    with _active_lock:
        if _ACTIVE_DAEMON is None:
            raise RuntimeError(
                "camera daemon not registered; call register_daemon() at startup"
            )
        return _ACTIVE_DAEMON


# -----------------------------------------------------------------------------
# Dependency-injected primitives (used by tests + by the module wrappers below)
# -----------------------------------------------------------------------------


def current_frame_with(daemon: CameraDaemon) -> Optional[np.ndarray]:
    """Return the latest captured ndarray (copy) or None if the ring is empty."""
    return daemon.current_frame()


def current_frame_jpeg_with(
    daemon: CameraDaemon, quality: int = DEFAULT_JPEG_QUALITY
) -> Optional[bytes]:
    """JPEG-encoded latest frame, or None if unavailable."""
    return daemon.current_frame_jpeg(quality=quality)


def frame_at_with(
    daemon: CameraDaemon,
    ts: str,
    *,
    offset_seconds: float = 0.0,
    output_dir: Path | str,
    filename_prefix: str = "frame",
    max_slop_seconds: float = DEFAULT_MAX_SLOP_SECONDS,
    quality: int = DEFAULT_JPEG_QUALITY,
) -> str:
    """Write the ring frame nearest to `ts + offset_seconds` to disk.

    Args:
        daemon: The camera daemon whose ring buffer to inspect.
        ts: ISO-8601 UTC timestamp (with or without ms precision, Z-terminated).
        offset_seconds: Adjustment applied to `ts` before lookup. Use
            negative values to fetch "before" frames (e.g. `offset_seconds=-2.0`
            grabs the frame from 2s before the scale event).
        output_dir: Directory to write the JPEG into. Created if missing.
        filename_prefix: Prefix prepended to the output filename. Useful for
            distinguishing before/after frames in a single session dir.
        max_slop_seconds: If the closest frame is further from the target
            than this, raise `FrameNotAvailableError`. Default 0.5s.
        quality: JPEG quality (1..100).

    Returns:
        Absolute path to the written JPEG as a string.

    Raises:
        FrameNotAvailableError: if the ring buffer is empty or the nearest
            frame is too far from the target timestamp.
        OSError: if the output directory could not be created / written to.
    """
    target_dt = parse_iso_utc(ts) + timedelta(seconds=offset_seconds)
    target_iso = (
        target_dt.strftime("%Y-%m-%dT%H:%M:%S.")
        + f"{target_dt.microsecond // 1000:03d}Z"
    )

    snapshot = daemon.snapshot_ring()
    closest = find_closest(snapshot, target_iso)
    if closest is None:
        raise FrameNotAvailableError(target_iso, None)
    actual_ts, frame, diff = closest
    if diff > max_slop_seconds:
        raise FrameNotAvailableError(target_iso, diff)

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Use the actual frame ts (not requested) for the filename so duplicate
    # requests for the same moment overwrite rather than proliferate.
    safe_ts = actual_ts.replace(":", "-")  # Windows-safe, still unambiguous
    fname = f"{filename_prefix}-{safe_ts}.jpg"
    out_path = out_dir / fname

    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
    if not ok:
        raise RuntimeError(f"cv2.imencode failed for frame at {actual_ts}")
    out_path.write_bytes(buf.tobytes())
    log.debug(
        "frame_at: requested=%s actual=%s slop=%.3fs -> %s",
        target_iso,
        actual_ts,
        diff,
        out_path,
    )
    return str(out_path.resolve())


# -----------------------------------------------------------------------------
# Module-level wrappers (use the registered daemon)
# -----------------------------------------------------------------------------


def current_frame() -> np.ndarray:
    """Most recent captured frame. Raises `FrameNotAvailableError` if empty."""
    daemon = get_daemon()
    frame = current_frame_with(daemon)
    if frame is None:
        raise FrameNotAvailableError("now", None)
    return frame


def current_frame_jpeg(quality: int = DEFAULT_JPEG_QUALITY) -> bytes:
    """JPEG-encoded latest frame. Raises `FrameNotAvailableError` if empty."""
    daemon = get_daemon()
    buf = current_frame_jpeg_with(daemon, quality=quality)
    if buf is None:
        raise FrameNotAvailableError("now", None)
    return buf


def frame_at(
    ts: str,
    offset_seconds: float = 0.0,
    *,
    output_dir: Path | str | None = None,
    filename_prefix: str = "frame",
    max_slop_seconds: float = DEFAULT_MAX_SLOP_SECONDS,
    quality: int = DEFAULT_JPEG_QUALITY,
) -> str:
    """Convenience wrapper over `frame_at_with` that uses the registered daemon.

    Args:
        ts: ISO-8601 UTC timestamp.
        offset_seconds: Optional offset (e.g. -2.0 for "before" frames).
        output_dir: Where to write the JPEG. Defaults to `./data/events/<ts>/`
            under the current working directory. Callers should pass the
            correct session-dir path — the default is just a safety net.
        filename_prefix: Output filename prefix.
        max_slop_seconds: Maximum acceptable distance between requested and
            actual frame timestamp.
        quality: JPEG quality.

    Returns:
        Absolute path to the written JPEG.
    """
    daemon = get_daemon()
    if output_dir is None:
        output_dir = Path.cwd() / "data" / "events"
    return frame_at_with(
        daemon,
        ts,
        offset_seconds=offset_seconds,
        output_dir=output_dir,
        filename_prefix=filename_prefix,
        max_slop_seconds=max_slop_seconds,
        quality=quality,
    )


__all__ = [
    "DEFAULT_JPEG_QUALITY",
    "DEFAULT_MAX_SLOP_SECONDS",
    "FrameNotAvailableError",
    "current_frame",
    "current_frame_jpeg",
    "current_frame_jpeg_with",
    "current_frame_with",
    "frame_at",
    "frame_at_with",
    "get_daemon",
    "register_daemon",
]
