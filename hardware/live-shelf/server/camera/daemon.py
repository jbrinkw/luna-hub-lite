"""Camera daemon for live-shelf.

Owns a single capture thread that pulls frames from `/dev/video0`, pushes them
into a fixed-size ring buffer keyed by ISO-8601 UTC millisecond timestamps,
and evaluates a brightness state machine to detect door open / door close
transitions. The daemon itself does NOT open or close sessions; it only
publishes `BrightnessTransition` events to any subscribed callback. The
orchestrator (Bundle H) is responsible for session lifecycle.

This module is intentionally self-contained: it does not import from storage,
classifier, intake, reconciler, web, or any other Bundle. Its only side
effects are log lines and the callbacks it invokes.

Design notes:
    * Ring buffer stores `(ts_iso, frame_ndarray)` tuples. `ts_iso` is an
      ISO-8601 UTC string with millisecond precision, always ending in "Z".
    * The buffer is a `collections.deque(maxlen=N)`. Append is O(1) and
      thread-safe *for single-producer, single-consumer* use. For frame
      lookup we copy the snapshot under a lock to guarantee no reader ever
      sees a half-mutated deque.
    * Brightness follows the hysteresis-and-debounce pattern from fridge-cam:
      rising edge through `threshold + hysteresis/2` opens; falling edge
      through `threshold - hysteresis/2` closes; both are debounced.
    * Subscribers register a callback via `CameraDaemon.on_brightness_transition(cb)`.
      Callbacks receive a `BrightnessTransition` dataclass. They run on the
      capture thread, so keep them fast (log / enqueue / set a flag — never
      block). Errors in callbacks are caught and logged; they do not crash
      the capture thread.
"""

from __future__ import annotations

import bisect
import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Optional, Protocol

import cv2
import numpy as np

log = logging.getLogger(__name__)

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

DEFAULT_CAPTURE_FPS: int = 10
DEFAULT_RING_SECONDS: int = 30
DEFAULT_RESOLUTION = (1280, 720)
DEFAULT_BRIGHTNESS_THRESHOLD: float = 60.0
DEFAULT_BRIGHTNESS_HYSTERESIS: float = 20.0
DEFAULT_DEBOUNCE_SECONDS: float = 2.0
MAX_BACKOFF_SECONDS: float = 5.0
INITIAL_BACKOFF_SECONDS: float = 0.2


@dataclass
class DaemonConfig:
    """Tunable parameters for the capture thread + brightness watcher."""

    camera_index: int = 0
    camera_path: Optional[str] = None
    resolution: tuple[int, int] = DEFAULT_RESOLUTION
    capture_fps: int = DEFAULT_CAPTURE_FPS
    ring_seconds: int = DEFAULT_RING_SECONDS
    brightness_threshold: float = DEFAULT_BRIGHTNESS_THRESHOLD
    brightness_hysteresis: float = DEFAULT_BRIGHTNESS_HYSTERESIS
    debounce_seconds: float = DEFAULT_DEBOUNCE_SECONDS
    brightness_detection_enabled: bool = True

    @property
    def ring_capacity(self) -> int:
        """Max frames the ring buffer holds."""
        return max(1, int(self.ring_seconds * self.capture_fps))


# -----------------------------------------------------------------------------
# Transition event payload
# -----------------------------------------------------------------------------


@dataclass(frozen=True)
class BrightnessTransition:
    """Emitted when the door state flips. Subscribers receive one per flip.

    `kind` is "open" (dark→bright) or "close" (bright→dark).
    `ts_iso` is the ISO-8601 UTC millisecond timestamp of the frame that
    triggered the transition. `brightness` is the mean-luma value (0..255).
    """

    kind: str  # 'open' or 'close'
    ts_iso: str
    brightness: float


# -----------------------------------------------------------------------------
# Camera open abstraction (swappable for tests)
# -----------------------------------------------------------------------------


class _CameraLike(Protocol):
    def read(self) -> tuple[bool, Optional[np.ndarray]]: ...
    def release(self) -> None: ...
    def set(self, propId: int, value: float) -> bool: ...
    def get(self, propId: int) -> float: ...
    def isOpened(self) -> bool: ...


CameraFactory = Callable[[DaemonConfig], _CameraLike]
"""Factory that returns an opened camera. Tests pass a fake to skip real
hardware. Implementations must raise on failure; the daemon catches and
applies exponential backoff."""


def default_camera_factory(cfg: DaemonConfig) -> _CameraLike:
    """Real camera factory. Uses cv2.VideoCapture with sensible fallbacks.

    Mirrors the approach from `fridge-cam/app.py`: try the default backend
    first, then fall back to V4L2 / ANY on Linux if the driver is picky.

    Accepts either ``cfg.camera_path`` (a device path or ``/dev/v4l/by-id``
    symlink — preferred, survives replug/reboot) or ``cfg.camera_index``
    (a numeric index like ``0`` → ``/dev/video0``).
    """
    source: Any = cfg.camera_path if cfg.camera_path else int(cfg.camera_index)
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        for backend in (cv2.CAP_V4L2, cv2.CAP_ANY):
            try:
                cap.release()
            except Exception:
                pass
            cap = cv2.VideoCapture(source, backend)
            if cap.isOpened():
                break
    if not cap.isOpened():
        raise RuntimeError(
            f"could not open camera source {source!r}; check connection / permissions"
        )
    # Force MJPG pixel format BEFORE setting resolution/fps. UVC cameras
    # default to YUYV (uncompressed), which on USB 2.0 saturates the bus
    # (~1.76 MB/frame at 720p) and caps at 5–10 fps per camera. MJPG is
    # ~10x smaller and decodes via libjpeg-turbo instead of software YUYV
    # conversion. Required when running two cameras on one USB 2.0 bus.
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    w, h = cfg.resolution
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, int(w))
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, int(h))
    cap.set(cv2.CAP_PROP_FPS, float(cfg.capture_fps))
    # Re-apply v4l2 locked settings AFTER cv2.VideoCapture has opened the
    # device. Some UVC drivers (observed on the SunplusIT USB 2.0 Camera
    # shipping on this rig) reset ``auto_exposure`` back to Aperture
    # Priority when the v4l2 capture fd is opened — so the apply-once
    # call that app.py makes at startup has no effect by the time frames
    # are actually flowing. Reapplying here (and on every reopen after a
    # grab-failure cycle) keeps the Manual/166 lock active for the full
    # life of the capture. Best-effort: failures are logged but don't
    # stop the capture path. Tests using a fake factory skip this
    # entirely because they never call the default factory.
    if cfg.camera_path or cfg.camera_index is not None:
        device_for_v4l2 = (
            cfg.camera_path if cfg.camera_path else f"/dev/video{cfg.camera_index}"
        )
        try:
            # Import here (not at module top) to avoid a circular import at
            # package load time — `locked_settings` is a sibling module.
            from .locked_settings import apply_locked_settings, read_v4l2_controls

            apply_locked_settings(device_for_v4l2)
            # Read back the actual live values so the log contains proof
            # of what the camera is running with — not just "apply
            # returned OK". When sessions come back over-exposed, this
            # is the first thing to check.
            live = read_v4l2_controls(device_for_v4l2)
            log.info(
                "v4l2 live state (%s): %s",
                device_for_v4l2,
                ", ".join(f"{k}={v}" for k, v in live.items()),
            )
        except Exception:  # pragma: no cover - best-effort
            log.exception(
                "post-open apply_locked_settings(%s) failed; capture continues "
                "with whatever the driver defaulted to",
                device_for_v4l2,
            )
    return cap


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------


def compute_brightness(frame: np.ndarray) -> float:
    """Mean luma on a downsampled grayscale copy (cheap + stable)."""
    if frame.size == 0:
        return 0.0
    small = cv2.resize(frame, (160, 120), interpolation=cv2.INTER_AREA)
    if small.ndim == 3:
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    else:
        gray = small
    return float(gray.mean())


def now_iso_utc_ms() -> str:
    """ISO-8601 UTC with ms precision, ending in 'Z'. Keeps lexicographic
    order == chronological order for ring-buffer timestamps."""
    now = datetime.now(timezone.utc)
    # Truncate microseconds to milliseconds.
    ms = now.microsecond // 1000
    return now.strftime(f"%Y-%m-%dT%H:%M:%S.{ms:03d}Z")


def parse_iso_utc(ts: str) -> datetime:
    """Parse an ISO-8601 UTC timestamp. Accepts trailing 'Z' or '+00:00'."""
    if ts.endswith("Z"):
        ts = ts[:-1] + "+00:00"
    return datetime.fromisoformat(ts)


# -----------------------------------------------------------------------------
# CameraDaemon
# -----------------------------------------------------------------------------


BrightnessCallback = Callable[[BrightnessTransition], None]
FrameCallback = Callable[[str, "np.ndarray"], None]
"""Invoked with (ts_iso, frame_ndarray) for every captured frame. Runs on
the capture thread — subscribers MUST be cheap. Used by session_capture
to stream-archive lit frames to disk while a session is open, avoiding
the 30-second ring-buffer cap that was silently truncating long
multi-item sessions (see _ring in CameraDaemon)."""


class CameraDaemon:
    """Owns the capture thread, ring buffer, and brightness watcher.

    Lifecycle:
        daemon = CameraDaemon(config)
        daemon.on_brightness_transition(cb)      # optional, any number
        daemon.start()                           # spawns thread
        ...                                      # app runs
        daemon.shutdown_event.set()              # signal stop
        daemon.join(timeout=3.0)                 # wait for exit

    Concurrency:
        * The capture thread is the sole writer to the ring buffer and to the
          brightness state machine.
        * Readers (`current_frame`, `frame_at`, `current_frame_jpeg`) take a
          short-lived lock and return a copy.
        * Subscriber callbacks are invoked from the capture thread; treat them
          as "onInterrupt"-level work (no network, no disk, no heavy math).
    """

    def __init__(
        self,
        config: Optional[DaemonConfig] = None,
        *,
        camera_factory: Optional[CameraFactory] = None,
        shutdown_event: Optional[threading.Event] = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.config = config or DaemonConfig()
        self._camera_factory = camera_factory or default_camera_factory
        self.shutdown_event = shutdown_event or threading.Event()
        self._clock = clock

        # Ring buffer: list of (ts_iso, frame). We also maintain a parallel
        # `_ring_ts` list for bisect-based lookup. Both share `_ring_lock`.
        self._ring: deque[tuple[str, np.ndarray]] = deque(
            maxlen=self.config.ring_capacity
        )
        self._ring_lock = threading.Lock()

        # Brightness state — mutated only by capture thread under _state_lock
        # so readers don't observe a half-update.
        self._door_open = False
        self._last_transition_ts: float = 0.0
        self._current_brightness: float = 0.0
        self._state_lock = threading.Lock()

        # Subscribers.
        self._subscribers: list[BrightnessCallback] = []
        self._subs_lock = threading.Lock()

        # Per-frame subscribers (invoked for every captured frame on the
        # capture thread). Kept separate from brightness subscribers
        # because the firing cadence and contract are different.
        self._frame_subscribers: list[FrameCallback] = []
        self._frame_subs_lock = threading.Lock()

        # Thread handle.
        self._thread: Optional[threading.Thread] = None

        # Diagnostics counters (monotonic, for tests and /api/state).
        self.frames_captured: int = 0
        self.grab_failures: int = 0
        self.last_frame_ts: Optional[str] = None

    # ------------------------------------------------------------------ API

    def on_brightness_transition(self, callback: BrightnessCallback) -> None:
        """Subscribe to brightness transitions.

        Callback is invoked with a `BrightnessTransition` on every rising /
        falling edge. Runs on the capture thread — keep it short.
        """
        with self._subs_lock:
            self._subscribers.append(callback)

    def remove_subscriber(self, callback: BrightnessCallback) -> bool:
        """Unregister a previously-added callback. Returns True if found."""
        with self._subs_lock:
            try:
                self._subscribers.remove(callback)
                return True
            except ValueError:
                return False

    def on_frame(self, callback: FrameCallback) -> None:
        """Subscribe to every captured frame.

        Callback is invoked with ``(ts_iso, frame_ndarray)`` for each frame
        pulled from the camera. Runs on the capture thread — keep it fast.
        Used by session_capture to archive lit frames to disk while a
        session is open, so session coverage is NOT bounded by the ring
        buffer size.

        Exceptions in the callback are caught and logged; they never
        kill the capture loop.
        """
        with self._frame_subs_lock:
            self._frame_subscribers.append(callback)

    def remove_frame_subscriber(self, callback: FrameCallback) -> bool:
        with self._frame_subs_lock:
            try:
                self._frame_subscribers.remove(callback)
                return True
            except ValueError:
                return False

    # ------------------------------------------------------------ frame access

    def snapshot_ring(self) -> list[tuple[str, np.ndarray]]:
        """Return a shallow copy of the ring buffer for safe iteration.

        The caller gets independent references to the frame ndarrays; since
        the capture thread writes a fresh frame each loop iteration (never
        mutates an existing one in-place), these references stay valid.
        """
        with self._ring_lock:
            return list(self._ring)

    def current_frame(self) -> Optional[np.ndarray]:
        """Most recent frame, or None if the ring is empty. Returns a copy."""
        with self._ring_lock:
            if not self._ring:
                return None
            return self._ring[-1][1].copy()

    def current_frame_jpeg(self, quality: int = 85) -> Optional[bytes]:
        """Most recent frame encoded as JPEG, or None if the ring is empty."""
        frame = self.current_frame()
        if frame is None:
            return None
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
        if not ok:
            return None
        return buf.tobytes()

    # ---------------------------------------------------------- brightness state

    def current_brightness(self) -> float:
        with self._state_lock:
            return self._current_brightness

    def door_open(self) -> bool:
        with self._state_lock:
            return self._door_open

    # ---------------------------------------------------------- thread control

    def start(self) -> None:
        """Spawn the capture thread. Idempotent: calling twice is a no-op."""
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._run, name="camera-capture", daemon=True
        )
        self._thread.start()

    def join(self, timeout: Optional[float] = None) -> None:
        if self._thread is not None:
            self._thread.join(timeout=timeout)

    def is_alive(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # --------------------------------------------------------------- capture loop

    def _run(self) -> None:
        log.info(
            "camera daemon starting (fps=%d, ring=%ds / %d frames)",
            self.config.capture_fps,
            self.config.ring_seconds,
            self.config.ring_capacity,
        )
        cap: Optional[_CameraLike] = None
        backoff = INITIAL_BACKOFF_SECONDS

        try:
            while not self.shutdown_event.is_set():
                # Open camera if needed.
                if cap is None:
                    try:
                        cap = self._camera_factory(self.config)
                        log.info("camera opened")
                        backoff = INITIAL_BACKOFF_SECONDS
                    except Exception as exc:
                        log.error(
                            "camera open failed (%s); retrying in %.2fs",
                            exc,
                            backoff,
                        )
                        if self.shutdown_event.wait(backoff):
                            break
                        backoff = min(MAX_BACKOFF_SECONDS, backoff * 2.0)
                        continue

                # Grab a frame.
                loop_start = self._clock()
                ok, frame = False, None
                try:
                    ok, frame = cap.read()
                except Exception as exc:
                    log.warning("cap.read() raised: %s", exc)
                    ok, frame = False, None

                if not ok or frame is None:
                    self.grab_failures += 1
                    log.warning(
                        "frame grab failed (total=%d); backoff %.2fs",
                        self.grab_failures,
                        backoff,
                    )
                    # On repeated failure, reopen.
                    if self.grab_failures % 10 == 0:
                        log.error("too many grab failures; reopening camera")
                        try:
                            cap.release()
                        except Exception:
                            pass
                        cap = None
                    if self.shutdown_event.wait(backoff):
                        break
                    backoff = min(MAX_BACKOFF_SECONDS, backoff * 2.0)
                    continue

                # Success — reset backoff and push into the ring. Copy
                # the frame so the V4L2 driver can't reuse the buffer
                # out from under a consumer that's mid-processing a
                # snapshot. (cv2.VideoCapture on some backends reuses
                # an internal pool; Python can't see the aliasing.)
                backoff = INITIAL_BACKOFF_SECONDS
                self.frames_captured += 1
                ts = now_iso_utc_ms()
                self.last_frame_ts = ts
                with self._ring_lock:
                    self._ring.append((ts, frame.copy()))

                # Per-frame subscribers (session live-archive path).
                # Iterate under a short-lived lock snapshot so a
                # subscriber can safely add/remove itself during dispatch
                # without mutating the list we're iterating.
                with self._frame_subs_lock:
                    frame_subs = list(self._frame_subscribers)
                for fcb in frame_subs:
                    try:
                        fcb(ts, frame)
                    except Exception:
                        log.exception(
                            "on_frame callback raised (ts=%s); continuing",
                            ts,
                        )

                # Brightness state machine.
                brightness = compute_brightness(frame)
                with self._state_lock:
                    self._current_brightness = brightness
                self._evaluate_brightness(brightness, ts)

                # Pace the loop.
                target_period = 1.0 / max(1, self.config.capture_fps)
                elapsed = self._clock() - loop_start
                remaining = target_period - elapsed
                if remaining > 0:
                    if self.shutdown_event.wait(remaining):
                        break
        finally:
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass
            log.info(
                "camera daemon stopped (frames=%d, failures=%d)",
                self.frames_captured,
                self.grab_failures,
            )

    # ------------------------------------------------------ brightness watcher

    def _evaluate_brightness(self, brightness: float, ts_iso: str) -> None:
        """Fire open/close transitions based on hysteresis + debounce."""
        cfg = self.config
        if not cfg.brightness_detection_enabled:
            return
        now = self._clock()
        with self._state_lock:
            door_open = self._door_open
            last_transition = self._last_transition_ts

        open_gate = cfg.brightness_threshold + cfg.brightness_hysteresis / 2.0
        close_gate = cfg.brightness_threshold - cfg.brightness_hysteresis / 2.0

        if not door_open and brightness > open_gate:
            if (now - last_transition) < cfg.debounce_seconds:
                return
            with self._state_lock:
                self._door_open = True
                self._last_transition_ts = now
            self._emit(BrightnessTransition("open", ts_iso, brightness))
        elif door_open and brightness < close_gate:
            if (now - last_transition) < cfg.debounce_seconds:
                return
            with self._state_lock:
                self._door_open = False
                self._last_transition_ts = now
            self._emit(BrightnessTransition("close", ts_iso, brightness))

    def _emit(self, evt: BrightnessTransition) -> None:
        """Fan out to subscribers. Catch everything — never crash the loop."""
        with self._subs_lock:
            subs = list(self._subscribers)
        for cb in subs:
            try:
                cb(evt)
            except Exception as exc:  # pragma: no cover - safety net
                log.exception("brightness subscriber raised: %s", exc)


# -----------------------------------------------------------------------------
# Ring-buffer lookup helper (pure function, reused by extract.py)
# -----------------------------------------------------------------------------


def find_closest(
    snapshot: Iterable[tuple[str, np.ndarray]],
    target_ts_iso: str,
) -> Optional[tuple[str, np.ndarray, float]]:
    """Return `(ts_iso, frame, abs_diff_seconds)` for the ring entry closest
    to `target_ts_iso`, or None if the snapshot is empty.

    Uses bisect_left on ISO-8601 strings (lexicographically ordered == time
    ordered when all timestamps are UTC with the same precision). Falls back
    to a linear scan if the snapshot is not sorted (shouldn't happen — the
    capture thread writes in order — but guards against bugs).
    """
    items = list(snapshot)
    if not items:
        return None

    ts_list = [t for t, _ in items]
    # Quick sortedness check on the boundary; full check would be O(n).
    is_sorted = len(ts_list) < 2 or ts_list[0] <= ts_list[-1]

    target_dt = parse_iso_utc(target_ts_iso)

    if is_sorted:
        idx = bisect.bisect_left(ts_list, target_ts_iso)
        candidates = []
        if idx < len(items):
            candidates.append(idx)
        if idx > 0:
            candidates.append(idx - 1)
    else:
        candidates = range(len(items))

    best: Optional[tuple[int, float]] = None
    for i in candidates:
        ts, _ = items[i]
        try:
            diff = abs((parse_iso_utc(ts) - target_dt).total_seconds())
        except ValueError:
            continue
        if best is None or diff < best[1]:
            best = (i, diff)

    if best is None:
        return None

    ts, frame = items[best[0]]
    return ts, frame, best[1]


__all__ = [
    "BrightnessTransition",
    "CameraDaemon",
    "DaemonConfig",
    "compute_brightness",
    "default_camera_factory",
    "find_closest",
    "now_iso_utc_ms",
    "parse_iso_utc",
]
