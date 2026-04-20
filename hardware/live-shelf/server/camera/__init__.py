"""Live-shelf camera module (Bundle C).

Self-contained USB camera daemon with:
    * capture thread + ring buffer (30s @ 10fps default, configurable)
    * brightness-based door-open/close watcher (emits transitions as events;
      orchestrator subscribes and handles sessions)
    * `frame_at(ts)` / `current_frame()` / `current_frame_jpeg()` extraction
    * MJPEG streaming generator for the `/live.mjpg` Flask route
    * `apply_locked_settings()` that calls `v4l2-ctl` with the known-good
      exposure / focus / white-balance values for the live-shelf rig

This package does not import from any other live-shelf bundle.
"""

from __future__ import annotations

from .daemon import (
    BrightnessTransition,
    CameraDaemon,
    DaemonConfig,
    compute_brightness,
    default_camera_factory,
    find_closest,
    now_iso_utc_ms,
    parse_iso_utc,
)
from .extract import (
    DEFAULT_JPEG_QUALITY,
    DEFAULT_MAX_SLOP_SECONDS,
    FrameNotAvailableError,
    current_frame,
    current_frame_jpeg,
    current_frame_jpeg_with,
    current_frame_with,
    frame_at,
    frame_at_with,
    get_daemon,
    register_daemon,
)
from .locked_settings import DEFAULT_LOCKED_SETTINGS, apply_locked_settings
from .mjpeg import stream as mjpeg_stream

__all__ = [
    "BrightnessTransition",
    "CameraDaemon",
    "DEFAULT_JPEG_QUALITY",
    "DEFAULT_LOCKED_SETTINGS",
    "DEFAULT_MAX_SLOP_SECONDS",
    "DaemonConfig",
    "FrameNotAvailableError",
    "apply_locked_settings",
    "compute_brightness",
    "current_frame",
    "current_frame_jpeg",
    "current_frame_jpeg_with",
    "current_frame_with",
    "default_camera_factory",
    "find_closest",
    "frame_at",
    "frame_at_with",
    "get_daemon",
    "mjpeg_stream",
    "now_iso_utc_ms",
    "parse_iso_utc",
    "register_daemon",
]
