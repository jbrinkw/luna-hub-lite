"""Apply v4l2 locked settings to a USB camera so OpenCV sees deterministic frames.

The live-shelf camera (Logitech class UVC) needs auto exposure / auto WB /
autofocus disabled with specific fixed values. These values were calibrated on
the physical rig and are stored here as defaults; if a `camera_locked.json`
file exists next to this module (or at a caller-supplied path), its values
override the defaults.

The function is best-effort: if `v4l2-ctl` is not installed (e.g., running on a
dev Mac or in CI), we log a warning and return. The capture thread still works
with whatever settings the driver defaults to; image quality just won't be
reproducible.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

# Lock everything to manual so door-open has ZERO adaptation delay.
# Measured on this rig: in auto mode, first post-open frame is 253.6
# (whiteout) and takes ~3 seconds to stabilize at ~150.
#
# BRIGHT-SCENE SATURATION (2026-04-21, fridge LED sessions blown to
# mean=249 / 82% pixels at 255 for entire door-open window): an
# earlier calibration comment claimed that exposure_time_absolute
# doesn't matter because "internal AGC maintains brightness" — that
# was only true when tested with DIM ambient (door closed) and the
# sensor well was never filled. With the fridge's internal LED on,
# the scene is bright enough that exposure=166 over-saturates the
# pixels regardless of AGC: once pixels clip at 255 there's nothing
# the ISP can recover. Direct evidence: session
# 2026-04-21T15-52-00.525Z archived 38 frames at mean=249 + 1 frame
# at mean=149 (door closing, scene suddenly dim). v4l2 state during
# capture was verified Manual Mode + exposure=166.
#
# Fix: drop exposure_time_absolute to 8 (≈1/125s-equivalent) — low
# enough to prevent saturation under the LED, still usable in the
# dim-ambient case because (a) the sensor is sensitive, (b) the
# BRIGHTNESS_THRESHOLD gate (8) only archives frames where the
# fridge LED is on, and (c) the session_capture.LIT_BRIGHTNESS_MIN
# filter rejects anything darker than 8 anyway so a few dropped
# dim frames during door-close are expected. Also disable
# backlight_compensation (default 9 / near-max) — it's a post-
# exposure pixel-lift for "backlit scenes" that pushes bright
# scenes further toward 255.
# Focus is fixed-focus or has very wide DOF — Laplacian-variance sweep
# showed ~28 for focus 0-200, dropping to 5.9 at 255. Lock at 0.
# Order matters: "auto" flags must be off BEFORE setting manual values.
DEFAULT_LOCKED_SETTINGS: list[tuple[str, int]] = [
    ("auto_exposure", 1),                   # 1 = Manual Mode
    ("exposure_time_absolute", 8),          # low enough to avoid LED saturation
    ("white_balance_automatic", 0),
    ("white_balance_temperature", 4600),    # default
    ("focus_automatic_continuous", 0),
    ("focus_absolute", 0),                  # fixed-focus lens; 0-200 all sharp
    ("backlight_compensation", 0),          # off: pixel-lift was blowing highlights
    ("brightness", 0),                      # default gain; tune negative if needed
]

# Legacy/alternate control names some UVC drivers expose. We try each group
# in order; the first one that succeeds is recorded. Unknown names just log a
# debug message and move on.
_CONTROL_ALIASES: dict[str, list[str]] = {
    "exposure_time_absolute": ["exposure_time_absolute", "exposure_absolute"],
    "focus_absolute": ["focus_absolute"],
    "white_balance_temperature": ["white_balance_temperature"],
    "auto_exposure": ["auto_exposure"],
    "focus_automatic_continuous": ["focus_automatic_continuous", "focus_auto"],
    "white_balance_automatic": ["white_balance_automatic", "white_balance_temperature_auto"],
    "backlight_compensation": ["backlight_compensation"],
    "brightness": ["brightness"],
}


def _load_overrides(config_path: Path | None) -> dict[str, int]:
    """Read camera_locked.json if present. Returns a dict of control→value."""
    if config_path is None:
        return {}
    if not config_path.exists():
        return {}
    try:
        with config_path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            log.warning(
                "camera_locked.json is not a JSON object; ignoring (%s)", config_path
            )
            return {}
        overrides: dict[str, int] = {}
        for k, v in data.items():
            try:
                overrides[str(k)] = int(v)
            except (TypeError, ValueError):
                log.warning("camera_locked.json value for %r is not int; skipping", k)
        return overrides
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("failed to read %s (%s); using defaults", config_path, exc)
        return {}


def _effective_settings(
    overrides: dict[str, int],
) -> list[tuple[str, int]]:
    """Merge defaults with overrides while preserving apply order."""
    out: list[tuple[str, int]] = []
    seen: set[str] = set()
    for name, default in DEFAULT_LOCKED_SETTINGS:
        out.append((name, overrides.get(name, default)))
        seen.add(name)
    # Any extra keys in the override file get applied last.
    for name, val in overrides.items():
        if name not in seen:
            out.append((name, val))
    return out


def _run_v4l2(
    device: str, control: str, value: int, *, timeout: float = 3.0
) -> tuple[bool, str]:
    """Run `v4l2-ctl -d <device> -c control=value`. Returns (ok, stderr)."""
    cmd = ["v4l2-ctl", "-d", device, "-c", f"{control}={value}"]
    try:
        res = subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        return False, f"{type(exc).__name__}: {exc}"
    if res.returncode != 0:
        return False, (res.stderr or res.stdout or "").strip()
    return True, ""


def apply_locked_settings(
    device: str = "/dev/video0",
    config_path: Path | str | None = None,
) -> dict[str, Any]:
    """Apply the known-good v4l2 settings to the given video device.

    Args:
        device: The v4l2 device path (e.g. "/dev/video0").
        config_path: Optional path to a JSON file of control→value overrides.
            If None, we look for `camera_locked.json` next to this module.

    Returns:
        A report dict with:
            - `ok`: True if `v4l2-ctl` was present and at least one control
              was applied. False if `v4l2-ctl` is missing.
            - `applied`: list of (control, value) tuples we successfully set.
            - `skipped`: list of (control, value, reason) for controls that
              failed (unsupported on the driver, device busy, etc).
            - `tool`: "v4l2-ctl" or None when not found.

    The function never raises; it logs and returns. The caller can decide
    whether to treat a failure as fatal.
    """
    if config_path is None:
        config_path = Path(__file__).with_name("camera_locked.json")
    elif isinstance(config_path, str):
        config_path = Path(config_path)

    overrides = _load_overrides(config_path)
    settings = _effective_settings(overrides)

    tool = shutil.which("v4l2-ctl")
    if tool is None:
        log.warning(
            "v4l2-ctl not found on PATH; skipping camera lock (device=%s). "
            "Capture will still work with driver defaults.",
            device,
        )
        return {
            "ok": False,
            "applied": [],
            "skipped": [(name, val, "v4l2-ctl missing") for name, val in settings],
            "tool": None,
        }

    applied: list[tuple[str, int]] = []
    skipped: list[tuple[str, int, str]] = []

    for name, val in settings:
        aliases = _CONTROL_ALIASES.get(name, [name])
        success = False
        last_err = ""
        for alias in aliases:
            ok, err = _run_v4l2(device, alias, val)
            if ok:
                log.info("v4l2: %s=%d (as %s)", name, val, alias)
                applied.append((name, val))
                success = True
                break
            last_err = err
        if not success:
            log.warning("v4l2: could not set %s=%d (%s)", name, val, last_err)
            skipped.append((name, val, last_err or "unknown"))

    return {
        "ok": True,
        "applied": applied,
        "skipped": skipped,
        "tool": "v4l2-ctl",
    }


# -----------------------------------------------------------------------------
# Auto-exposure fallback
# -----------------------------------------------------------------------------


# v4l2 auto_exposure mode values:
#   1 = Manual Mode (the locked preset)
#   3 = Aperture Priority Mode (driver chooses exposure; used as fallback when
#       the locked manual value is too dark/bright for the current scene).
AUTO_EXPOSURE_APERTURE_PRIORITY: int = 3
AUTO_EXPOSURE_MANUAL: int = 1


# Manual exposure value to use when the "locked exposure" button is pressed
# on the dashboard. Kept aligned with DEFAULT_LOCKED_SETTINGS so the
# dashboard toggle matches startup state. See the DEFAULT_LOCKED_SETTINGS
# comment above for why this value was lowered from 166 → 8 in
# 2026-04-21 (bright-scene sensor saturation).
MANUAL_EXPOSURE_TIME_ABSOLUTE: int = 8


def set_auto_exposure(device: str = "/dev/video0", enabled: bool = True) -> bool:
    """Flip the camera to/from auto-exposure (Aperture Priority) mode.

    Returns True if the v4l2 call succeeded. When ``enabled=True`` the driver
    picks an exposure based on the current scene. When ``enabled=False`` we
    switch to Manual Mode with the calibrated
    :data:`MANUAL_EXPOSURE_TIME_ABSOLUTE` value — only sensible if the shelf
    has deterministic lighting (e.g., a dedicated internal LED).
    """
    tool = shutil.which("v4l2-ctl")
    if tool is None:
        log.warning("v4l2-ctl missing; cannot toggle auto-exposure")
        return False
    if enabled:
        ok, err = _run_v4l2(device, "auto_exposure", AUTO_EXPOSURE_APERTURE_PRIORITY)
        if ok:
            log.info("camera: auto-exposure ON (Aperture Priority)")
        else:
            log.warning("camera: failed to enable auto-exposure: %s", err)
        return ok
    # Switch to manual mode and set the calibrated exposure value. The mode
    # flip has to happen before the value write or the driver rejects it.
    ok1, err1 = _run_v4l2(device, "auto_exposure", AUTO_EXPOSURE_MANUAL)
    if not ok1:
        log.warning("camera: failed to enter manual exposure mode: %s", err1)
        return False
    ok2, err2 = _run_v4l2(
        device, "exposure_time_absolute", MANUAL_EXPOSURE_TIME_ABSOLUTE,
    )
    if not ok2:
        log.warning("camera: failed to set manual exposure value: %s", err2)
        return False
    log.info(
        "camera: manual exposure ON (exposure_time_absolute=%d)",
        MANUAL_EXPOSURE_TIME_ABSOLUTE,
    )
    return True


# -----------------------------------------------------------------------------
# Diagnostic readback
# -----------------------------------------------------------------------------


def read_v4l2_controls(
    device: str,
    names: list[str] | None = None,
    *,
    timeout: float = 3.0,
) -> dict[str, str]:
    """Read back the live values of a set of v4l2 controls.

    Returns a dict of ``{control_name: "value (mode)"}`` as reported by
    ``v4l2-ctl --get-ctrl``. Unknown controls map to ``"?"``. The result
    is suitable for a single-line log entry at session open so we have
    positive evidence of what the camera is actually doing, rather than
    trusting that ``apply_locked_settings`` stuck since the app started.

    This is a read-only diagnostic — it never writes. Safe to call from
    any thread, though it does spawn a ``v4l2-ctl`` subprocess each
    invocation so don't call it per-frame.
    """
    if names is None:
        names = [
            "auto_exposure",
            "exposure_time_absolute",
            "backlight_compensation",
            "brightness",
            "white_balance_automatic",
        ]
    out: dict[str, str] = {name: "?" for name in names}
    tool = shutil.which("v4l2-ctl")
    if tool is None:
        return out
    cmd = [tool, "-d", device, "--get-ctrl=" + ",".join(names)]
    try:
        res = subprocess.run(
            cmd, check=False, capture_output=True, text=True, timeout=timeout,
        )
    except (subprocess.TimeoutExpired, OSError):
        return out
    if res.returncode != 0:
        # Some controls may be unknown on this device — v4l2-ctl still
        # prints the known ones and writes "unknown control ..." to
        # stderr. Parse whatever we got on stdout.
        pass
    for line in (res.stdout or "").splitlines():
        # Format: "auto_exposure: 1 (Manual Mode)"  or  "brightness: 0"
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        k = k.strip()
        v = v.strip()
        if k in out:
            out[k] = v
    return out


__all__ = [
    "AUTO_EXPOSURE_APERTURE_PRIORITY",
    "AUTO_EXPOSURE_MANUAL",
    "DEFAULT_LOCKED_SETTINGS",
    "apply_locked_settings",
    "read_v4l2_controls",
    "set_auto_exposure",
]
