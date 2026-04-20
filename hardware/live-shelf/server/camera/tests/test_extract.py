"""Tests for the live-shelf camera module.

All tests run without a real webcam via a synthetic `VideoCapture` mock that
returns numbered frames on a controllable clock. The Pi-side code under test
is the same code that runs against the real camera — only the `read()`
implementation is swapped.

Covered:
    * Ring buffer retains the most recent `ring_capacity` frames in order.
    * `frame_at(ts)` returns the frame whose stored ts is closest to the
      requested target (within `max_slop_seconds`).
    * `offset_seconds` shifts the target correctly (e.g., -2.0s before).
    * `FrameNotAvailableError` is raised when nothing is within slop.
    * Capture thread recovers from transient `read()` failures with
      exponential backoff, does not crash, and resumes capturing.
    * Brightness watcher emits one `open` transition on rising-edge, one
      `close` on falling-edge, and respects debounce.
    * `current_frame()` / `current_frame_jpeg()` raise when ring is empty.
    * `apply_locked_settings()` gracefully handles missing `v4l2-ctl`.
    * `find_closest()` behavior on empty / out-of-range inputs.
    * MJPEG generator emits multipart chunks and exits on shutdown.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from unittest import mock

import cv2
import numpy as np
import pytest

from server.camera import (
    BrightnessTransition,
    CameraDaemon,
    DaemonConfig,
    DEFAULT_LOCKED_SETTINGS,
    FrameNotAvailableError,
    apply_locked_settings,
    compute_brightness,
    find_closest,
    frame_at_with,
    mjpeg_stream,
    now_iso_utc_ms,
)
from server.camera.daemon import parse_iso_utc


# =============================================================================
# Synthetic VideoCapture used by all daemon tests
# =============================================================================


class SyntheticCamera:
    """Minimal `cv2.VideoCapture`-compatible fake.

    Each `read()` call returns a freshly-generated BGR frame where pixel (0,0)
    encodes the frame index, plus an overall brightness controlled via
    `set_brightness()`. `set_failure()` makes the next N reads return
    `(False, None)` — simulates a transient camera glitch.

    The fake is thread-safe: the capture thread may read while the test
    thread twiddles brightness / failure count.
    """

    def __init__(self, *, size: tuple[int, int] = (160, 120), brightness: int = 200):
        self._w, self._h = size
        self._brightness = brightness
        self._failures_remaining = 0
        self._opened = True
        self._count = 0
        self._lock = threading.Lock()

    def isOpened(self) -> bool:
        return self._opened

    def read(self) -> tuple[bool, Optional[np.ndarray]]:
        with self._lock:
            if self._failures_remaining > 0:
                self._failures_remaining -= 1
                return False, None
            self._count += 1
            count = self._count
            brightness = self._brightness
        frame = np.full((self._h, self._w, 3), brightness, dtype=np.uint8)
        # Stamp the frame index into pixel (0,0) so tests can verify which
        # frame was returned. 16-bit counter packed across two channels.
        frame[0, 0, 0] = count & 0xFF
        frame[0, 0, 1] = (count >> 8) & 0xFF
        return True, frame

    def set(self, propId: int, value: float) -> bool:  # noqa: N803 (cv2 name)
        return True

    def get(self, propId: int) -> float:  # noqa: N803
        return 0.0

    def release(self) -> None:
        self._opened = False

    # -- test helpers ---------------------------------------------------------

    def set_brightness(self, brightness: int) -> None:
        with self._lock:
            self._brightness = int(brightness)

    def set_failure(self, count: int) -> None:
        with self._lock:
            self._failures_remaining = int(count)

    @property
    def frame_count(self) -> int:
        with self._lock:
            return self._count


def _make_factory(cam: SyntheticCamera):
    def factory(cfg: DaemonConfig):
        return cam
    return factory


def _wait_for(predicate, timeout: float = 3.0, interval: float = 0.02):
    """Busy-wait until `predicate()` is truthy or `timeout` elapses."""
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        if predicate():
            return True
        time.sleep(interval)
    return False


# =============================================================================
# Ring-buffer level tests (pure: no threading)
# =============================================================================


def _make_frame(idx: int) -> np.ndarray:
    """Build a 160x120 BGR frame whose color is uniquely determined by `idx`.

    JPEG compression smears single-pixel signals, so we fill the entire frame
    with a solid color encoding the index. After JPEG round-trip the recovered
    color is within a few units of the original; tests use that to identify
    which frame was picked from the ring buffer.
    """
    f = np.zeros((120, 160, 3), dtype=np.uint8)
    f[:, :, 0] = idx & 0xFF
    f[:, :, 1] = (idx >> 8) & 0xFF
    return f


def _decode_frame_idx(img: np.ndarray) -> int:
    """Recover the frame index from a JPEG-decoded BGR image.

    JPEG quantization drifts each channel by up to ~3 units on solid colors,
    so we average a central patch and round.
    """
    patch = img[40:80, 40:120, :2]  # avoid edges where bleed is worst
    lo = int(round(float(patch[:, :, 0].mean())))
    hi = int(round(float(patch[:, :, 1].mean())))
    return (hi << 8) | lo


def _iso_at(dt: datetime) -> str:
    ms = dt.microsecond // 1000
    return dt.strftime(f"%Y-%m-%dT%H:%M:%S.{ms:03d}Z")


def test_find_closest_empty_returns_none():
    assert find_closest([], "2026-04-15T12:00:00.000Z") is None


def test_find_closest_exact_match():
    base = datetime(2026, 4, 15, 12, 0, 0, 0, tzinfo=timezone.utc)
    items = [(_iso_at(base + timedelta(milliseconds=100 * i)), _make_frame(i)) for i in range(10)]
    target = _iso_at(base + timedelta(milliseconds=500))
    result = find_closest(items, target)
    assert result is not None
    ts, frame, diff = result
    assert ts == target
    assert diff == 0.0
    # Returned ndarray still in-memory (pre-JPEG) so check pixel channel 0.
    assert int(frame[0, 0, 0]) == 5


def test_find_closest_between_samples_picks_nearest():
    base = datetime(2026, 4, 15, 12, 0, 0, 0, tzinfo=timezone.utc)
    # Frames at 0, 100, 200, 300ms
    items = [(_iso_at(base + timedelta(milliseconds=100 * i)), _make_frame(i)) for i in range(4)]
    # Target 140ms -> closer to 100ms (idx=1)
    target = _iso_at(base + timedelta(milliseconds=140))
    result = find_closest(items, target)
    assert result is not None
    ts, frame, diff = result
    assert int(frame[0, 0, 0]) == 1
    assert 0.03 < diff < 0.05

    # Target 160ms -> closer to 200ms (idx=2)
    target = _iso_at(base + timedelta(milliseconds=160))
    result = find_closest(items, target)
    assert result is not None
    _, frame, diff = result
    assert int(frame[0, 0, 0]) == 2
    assert 0.03 < diff < 0.05


# =============================================================================
# frame_at tests with a pre-seeded daemon (no capture thread)
# =============================================================================


def _seed_daemon(daemon: CameraDaemon, n: int, fps: int, start: datetime) -> list[str]:
    """Manually populate the daemon's ring buffer with n evenly-spaced frames.

    Returns the list of timestamps (ISO) used.
    """
    period = timedelta(seconds=1.0 / fps)
    timestamps: list[str] = []
    # Access the internal ring directly — tests are allowed to.
    for i in range(n):
        ts = _iso_at(start + period * i)
        frame = _make_frame(i)
        daemon._ring.append((ts, frame))  # type: ignore[attr-defined]
        daemon.last_frame_ts = ts
        timestamps.append(ts)
    return timestamps


def test_frame_at_writes_correct_frame(tmp_path: Path):
    cfg = DaemonConfig(capture_fps=10, ring_seconds=30)
    daemon = CameraDaemon(cfg)
    base = datetime(2026, 4, 15, 12, 0, 0, 0, tzinfo=timezone.utc)
    timestamps = _seed_daemon(daemon, 300, 10, base)

    # Ask for frame idx 150 exactly.
    target = timestamps[150]
    path = frame_at_with(daemon, target, output_dir=tmp_path)
    img = cv2.imread(path)
    assert img is not None
    assert _decode_frame_idx(img) == 150


def test_frame_at_offset_shifts_by_seconds(tmp_path: Path):
    cfg = DaemonConfig(capture_fps=10, ring_seconds=30)
    daemon = CameraDaemon(cfg)
    base = datetime(2026, 4, 15, 12, 0, 0, 0, tzinfo=timezone.utc)
    timestamps = _seed_daemon(daemon, 300, 10, base)

    # Ask for "2 seconds before frame 150" -> frame 130 (10 fps * 2s = 20 frames)
    target = timestamps[150]
    path = frame_at_with(daemon, target, offset_seconds=-2.0, output_dir=tmp_path)
    img = cv2.imread(path)
    assert img is not None
    assert _decode_frame_idx(img) == 130


def test_frame_at_raises_when_slop_exceeded(tmp_path: Path):
    cfg = DaemonConfig(capture_fps=10, ring_seconds=30)
    daemon = CameraDaemon(cfg)
    base = datetime(2026, 4, 15, 12, 0, 0, 0, tzinfo=timezone.utc)
    _seed_daemon(daemon, 100, 10, base)

    # Ask for a timestamp 5 minutes after the last frame.
    late = _iso_at(base + timedelta(minutes=5))
    with pytest.raises(FrameNotAvailableError) as exc_info:
        frame_at_with(daemon, late, output_dir=tmp_path)
    assert exc_info.value.closest_diff_s is not None
    assert exc_info.value.closest_diff_s > 0.5


def test_frame_at_raises_when_ring_empty(tmp_path: Path):
    cfg = DaemonConfig(capture_fps=10, ring_seconds=30)
    daemon = CameraDaemon(cfg)
    with pytest.raises(FrameNotAvailableError):
        frame_at_with(daemon, now_iso_utc_ms(), output_dir=tmp_path)


def test_frame_at_picks_nearest_within_slop(tmp_path: Path):
    """Frame timestamps at 10fps (100ms apart). Requesting a ts 40ms off the
    nearest frame should succeed (within 500ms slop) and pick that nearest
    frame."""
    cfg = DaemonConfig(capture_fps=10, ring_seconds=30)
    daemon = CameraDaemon(cfg)
    base = datetime(2026, 4, 15, 12, 0, 0, 0, tzinfo=timezone.utc)
    timestamps = _seed_daemon(daemon, 20, 10, base)

    # Frame 10 is at base + 1.0s. Ask for base + 1.04s -> still frame 10.
    target = _iso_at(base + timedelta(milliseconds=1040))
    path = frame_at_with(daemon, target, output_dir=tmp_path)
    img = cv2.imread(path)
    assert img is not None
    assert _decode_frame_idx(img) == 10


# =============================================================================
# Capture-thread integration tests (real threading, synthetic camera)
# =============================================================================


def test_capture_thread_fills_ring_buffer():
    cam = SyntheticCamera(size=(80, 60), brightness=120)
    cfg = DaemonConfig(
        capture_fps=50,  # go fast so the test is quick
        ring_seconds=1,  # capacity = 50
        brightness_detection_enabled=False,
    )
    daemon = CameraDaemon(cfg, camera_factory=_make_factory(cam))
    daemon.start()
    try:
        assert _wait_for(lambda: daemon.frames_captured >= 60, timeout=3.0), (
            f"expected >=60 frames, got {daemon.frames_captured}"
        )
        snapshot = daemon.snapshot_ring()
        # Ring should be capped at capacity = 50.
        assert len(snapshot) == 50
        # Timestamps must be monotonically non-decreasing.
        ts_list = [t for t, _ in snapshot]
        assert ts_list == sorted(ts_list)
        # Frames must encode increasing indices.
        idx_list = [int(f[0, 0, 0]) | (int(f[0, 0, 1]) << 8) for _, f in snapshot]
        assert idx_list == sorted(idx_list)
    finally:
        daemon.shutdown_event.set()
        daemon.join(timeout=3.0)


def test_capture_thread_recovers_from_read_failures():
    cam = SyntheticCamera(size=(80, 60), brightness=120)
    cfg = DaemonConfig(
        capture_fps=50,
        ring_seconds=1,
        brightness_detection_enabled=False,
    )
    daemon = CameraDaemon(cfg, camera_factory=_make_factory(cam))
    daemon.start()
    try:
        # Let a few frames through.
        assert _wait_for(lambda: daemon.frames_captured >= 5, timeout=3.0)
        before = daemon.frames_captured
        # Inject 3 consecutive failures.
        cam.set_failure(3)
        # Capture thread must log + backoff but keep going.
        assert _wait_for(lambda: daemon.grab_failures >= 3, timeout=3.0)
        # After failures subside, capture resumes.
        assert _wait_for(
            lambda: daemon.frames_captured > before + 5, timeout=5.0
        ), "capture did not resume after transient failures"
        assert daemon.is_alive()
    finally:
        daemon.shutdown_event.set()
        daemon.join(timeout=3.0)


def test_brightness_watcher_emits_open_and_close():
    cam = SyntheticCamera(size=(80, 60), brightness=10)  # dark to start
    cfg = DaemonConfig(
        capture_fps=50,
        ring_seconds=1,
        brightness_threshold=60.0,
        brightness_hysteresis=20.0,
        debounce_seconds=0.05,  # short so test is fast
    )
    daemon = CameraDaemon(cfg, camera_factory=_make_factory(cam))
    received: list[BrightnessTransition] = []
    daemon.on_brightness_transition(received.append)
    daemon.start()
    try:
        # Wait until at least a couple of dark frames are captured.
        assert _wait_for(lambda: daemon.frames_captured >= 5, timeout=3.0)
        assert not daemon.door_open()
        # Rising edge -> open.
        cam.set_brightness(200)
        assert _wait_for(
            lambda: any(t.kind == "open" for t in received), timeout=3.0
        ), f"no open transition received (got {received})"
        assert daemon.door_open()
        # Wait out the debounce before falling edge.
        time.sleep(0.1)
        cam.set_brightness(10)
        assert _wait_for(
            lambda: any(t.kind == "close" for t in received), timeout=3.0
        ), f"no close transition received (got {received})"
        assert not daemon.door_open()

        opens = [t for t in received if t.kind == "open"]
        closes = [t for t in received if t.kind == "close"]
        assert len(opens) == 1
        assert len(closes) == 1
        # Timestamps are ISO strings ending in Z.
        for t in received:
            assert t.ts_iso.endswith("Z")
            # Verify parseable.
            parse_iso_utc(t.ts_iso)
    finally:
        daemon.shutdown_event.set()
        daemon.join(timeout=3.0)


def test_brightness_watcher_disabled_emits_nothing():
    cam = SyntheticCamera(size=(80, 60), brightness=10)
    cfg = DaemonConfig(
        capture_fps=50,
        ring_seconds=1,
        brightness_detection_enabled=False,
    )
    daemon = CameraDaemon(cfg, camera_factory=_make_factory(cam))
    received: list[BrightnessTransition] = []
    daemon.on_brightness_transition(received.append)
    daemon.start()
    try:
        cam.set_brightness(200)
        # Wait a few capture periods — should not trigger.
        _wait_for(lambda: daemon.frames_captured >= 20, timeout=3.0)
        assert received == []
        assert not daemon.door_open()
    finally:
        daemon.shutdown_event.set()
        daemon.join(timeout=3.0)


def test_camera_open_failure_is_retried_not_fatal():
    """If the factory raises, the daemon must log and retry, not die."""
    attempts = {"n": 0}

    def flaky_factory(cfg: DaemonConfig):
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise RuntimeError("simulated camera open failure")
        return SyntheticCamera(size=(80, 60), brightness=120)

    cfg = DaemonConfig(
        capture_fps=50,
        ring_seconds=1,
        brightness_detection_enabled=False,
    )
    daemon = CameraDaemon(cfg, camera_factory=flaky_factory)
    daemon.start()
    try:
        assert _wait_for(lambda: daemon.frames_captured >= 3, timeout=10.0), (
            f"daemon never recovered (attempts={attempts['n']}, "
            f"frames={daemon.frames_captured})"
        )
        assert attempts["n"] >= 3
        assert daemon.is_alive()
    finally:
        daemon.shutdown_event.set()
        daemon.join(timeout=3.0)


def test_current_frame_and_jpeg_while_running():
    cam = SyntheticCamera(size=(80, 60), brightness=150)
    cfg = DaemonConfig(
        capture_fps=50,
        ring_seconds=1,
        brightness_detection_enabled=False,
    )
    daemon = CameraDaemon(cfg, camera_factory=_make_factory(cam))
    daemon.start()
    try:
        assert _wait_for(lambda: daemon.frames_captured >= 5, timeout=3.0)
        frame = daemon.current_frame()
        assert frame is not None
        assert frame.shape == (60, 80, 3)
        jpeg = daemon.current_frame_jpeg()
        assert jpeg is not None and len(jpeg) > 0
        # Valid JPEG magic bytes.
        assert jpeg[:3] == b"\xff\xd8\xff"
    finally:
        daemon.shutdown_event.set()
        daemon.join(timeout=3.0)


def test_current_frame_returns_none_when_empty():
    cfg = DaemonConfig(capture_fps=10, ring_seconds=5, brightness_detection_enabled=False)
    daemon = CameraDaemon(cfg)
    assert daemon.current_frame() is None
    assert daemon.current_frame_jpeg() is None


# =============================================================================
# MJPEG generator
# =============================================================================


def test_mjpeg_stream_emits_chunks_and_stops_on_shutdown():
    cam = SyntheticCamera(size=(80, 60), brightness=150)
    cfg = DaemonConfig(
        capture_fps=20,
        ring_seconds=1,
        brightness_detection_enabled=False,
    )
    daemon = CameraDaemon(cfg, camera_factory=_make_factory(cam))
    daemon.start()
    try:
        assert _wait_for(lambda: daemon.frames_captured >= 5, timeout=3.0)

        gen = mjpeg_stream(daemon, stream_fps=10.0)
        chunks: list[bytes] = []
        # Pull a couple of chunks.
        for _ in range(3):
            chunks.append(next(gen))
        # Each chunk is a multipart packet.
        for chunk in chunks:
            assert chunk.startswith(b"--frame")
            assert b"Content-Type: image/jpeg" in chunk
            assert b"\xff\xd8\xff" in chunk  # JPEG magic inside

        # Once shutdown fires, the generator exits.
        daemon.shutdown_event.set()
        remaining = list(gen)
        # At most one more packet before the loop exits.
        assert len(remaining) <= 1
    finally:
        daemon.shutdown_event.set()
        daemon.join(timeout=3.0)


def test_mjpeg_stream_placeholder_when_ring_empty():
    """Before any frames are captured, stream emits a `waiting for camera`
    placeholder rather than crashing."""
    cfg = DaemonConfig(capture_fps=10, ring_seconds=1, brightness_detection_enabled=False)
    daemon = CameraDaemon(cfg)  # not started
    gen = mjpeg_stream(daemon, stream_fps=10.0)
    chunk = next(gen)
    assert chunk.startswith(b"--frame")
    assert b"\xff\xd8\xff" in chunk  # JPEG magic
    daemon.shutdown_event.set()


# =============================================================================
# Helper-function tests
# =============================================================================


def test_now_iso_utc_ms_format():
    ts = now_iso_utc_ms()
    # YYYY-MM-DDTHH:MM:SS.mmmZ  -> 24 chars
    assert len(ts) == 24
    assert ts.endswith("Z")
    # Round-trip through parse.
    dt = parse_iso_utc(ts)
    assert dt.tzinfo is not None


def test_compute_brightness_on_flat_frame():
    bright = np.full((120, 160, 3), 200, dtype=np.uint8)
    dark = np.full((120, 160, 3), 20, dtype=np.uint8)
    b1 = compute_brightness(bright)
    b2 = compute_brightness(dark)
    assert b1 > b2
    assert 180 < b1 < 220
    assert 0 <= b2 < 40


# =============================================================================
# locked_settings tests
# =============================================================================


def test_apply_locked_settings_handles_missing_v4l2_ctl():
    """If `v4l2-ctl` is not on PATH, the function returns cleanly."""
    with mock.patch("server.camera.locked_settings.shutil.which", return_value=None):
        result = apply_locked_settings(device="/dev/video0")
    assert result["ok"] is False
    assert result["tool"] is None
    assert result["applied"] == []
    assert len(result["skipped"]) >= 1
    # Skipped entries include (name, value, reason). Assert on controls
    # that are known to live in the manual-lock default set.
    names = {entry[0] for entry in result["skipped"]}
    assert "auto_exposure" in names
    assert "focus_absolute" in names


def test_apply_locked_settings_invokes_v4l2_ctl_when_present(tmp_path: Path):
    calls: list[list[str]] = []

    def fake_run(cmd, **kw):
        calls.append(cmd)
        return mock.Mock(returncode=0, stdout="", stderr="")

    with mock.patch(
        "server.camera.locked_settings.shutil.which", return_value="/usr/bin/v4l2-ctl"
    ), mock.patch("server.camera.locked_settings.subprocess.run", side_effect=fake_run):
        result = apply_locked_settings(device="/dev/video0")
    assert result["ok"] is True
    assert result["tool"] == "v4l2-ctl"
    # One v4l2-ctl invocation per entry in DEFAULT_LOCKED_SETTINGS. Assert
    # against the live length so this test doesn't go stale when the lock
    # set is tuned per rig.
    assert len(calls) == len(DEFAULT_LOCKED_SETTINGS)
    # Spot-check: each call targets /dev/video0 with a "name=value" argument.
    for cmd in calls:
        assert cmd[0] == "v4l2-ctl"
        assert "-d" in cmd and "/dev/video0" in cmd
        assert any("=" in arg for arg in cmd)
    applied_names = [name for name, _ in result["applied"]]
    assert "auto_exposure" in applied_names
    assert "focus_absolute" in applied_names
    assert "white_balance_temperature" in applied_names
    # auto_exposure is set to 1 (Manual Mode) so the camera skips the
    # auto-exposure adaptation loop and the first post-open frame is
    # immediately usable (internal AGC keeps brightness in range).
    # Assert against the live DEFAULT_LOCKED_SETTINGS value rather than
    # a hard-coded number so rig-specific tuning doesn't break the test.
    expected_ae = dict(DEFAULT_LOCKED_SETTINGS)["auto_exposure"]
    auto_exposure_calls = [
        c for c in calls if any("auto_exposure=" in a for a in c)
    ]
    assert auto_exposure_calls
    assert any(f"auto_exposure={expected_ae}" in arg for arg in auto_exposure_calls[0])


def test_apply_locked_settings_reads_overrides_from_json(tmp_path: Path):
    cfg_path = tmp_path / "camera_locked.json"
    cfg_path.write_text(
        '{"exposure_time_absolute": 2000, "focus_absolute": 75}',
        encoding="utf-8",
    )
    captured: list[list[str]] = []

    def fake_run(cmd, **kw):
        captured.append(cmd)
        return mock.Mock(returncode=0, stdout="", stderr="")

    with mock.patch(
        "server.camera.locked_settings.shutil.which", return_value="/usr/bin/v4l2-ctl"
    ), mock.patch("server.camera.locked_settings.subprocess.run", side_effect=fake_run):
        result = apply_locked_settings(device="/dev/video0", config_path=cfg_path)

    assert result["ok"] is True
    # Find the exposure call and verify overridden value.
    exposure_calls = [c for c in captured if any("exposure_time_absolute" in a for a in c)]
    assert exposure_calls
    assert any("exposure_time_absolute=2000" in arg for arg in exposure_calls[0])

    focus_calls = [c for c in captured if any("focus_absolute" in a for a in c)]
    assert focus_calls
    assert any("focus_absolute=75" in arg for arg in focus_calls[0])


def test_apply_locked_settings_handles_v4l2_failure_gracefully():
    """If v4l2-ctl is present but a control set fails (on every known alias),
    we log + continue."""
    def fake_run(cmd, **kw):
        # Fail white_balance_automatic on BOTH known aliases
        # (`white_balance_automatic` and `white_balance_temperature_auto`)
        # so the retry loop exhausts; other controls succeed.
        # Pick a control that's in DEFAULT_LOCKED_SETTINGS and has known
        # alias fallbacks so the retry loop can be exercised.
        if any(
            "white_balance_automatic" in a
            or "white_balance_temperature_auto" in a
            for a in cmd
        ):
            return mock.Mock(returncode=1, stdout="", stderr="Invalid argument")
        return mock.Mock(returncode=0, stdout="", stderr="")

    with mock.patch(
        "server.camera.locked_settings.shutil.which", return_value="/usr/bin/v4l2-ctl"
    ), mock.patch("server.camera.locked_settings.subprocess.run", side_effect=fake_run):
        result = apply_locked_settings(device="/dev/video0")

    assert result["ok"] is True
    applied = [n for n, _ in result["applied"]]
    skipped = [n for n, _, _ in result["skipped"]]
    assert "white_balance_automatic" in skipped
    # Others still succeed.
    assert "focus_absolute" in applied
