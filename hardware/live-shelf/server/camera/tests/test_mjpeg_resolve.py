"""Unit tests for :func:`server.camera.mjpeg.resolve_daemon`.

The MJPEG endpoint in :mod:`server.app` delegates shelf→daemon routing
to this helper. Tests cover the three outcomes:

* known shelf + daemon present → returns the daemon
* known shelf + daemon absent (hardware missing) → returns None
  (route should map to HTTP 503)
* unknown shelf → raises KeyError
  (route should map to HTTP 404 — distinguishing "typo / not configured"
  from "hardware absent")
* empty / omitted shelf → falls back to the ``live_shelf`` default
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.camera import mjpeg  # noqa: E402


class _StubDaemon:
    """Marker object — resolve_daemon is agnostic to the camera shape."""


def test_resolve_daemon_returns_registered_entry():
    live = _StubDaemon()
    catch = _StubDaemon()
    reg = {"live_shelf": live, "catch_all": catch}
    assert mjpeg.resolve_daemon(reg, "live_shelf") is live
    assert mjpeg.resolve_daemon(reg, "catch_all") is catch


def test_resolve_daemon_hardware_absent_returns_none():
    """Shelf key is registered but the daemon slot is ``None`` — the
    registry entry exists (boot-time wiring ran) but the camera failed
    to initialize (e.g. ``/dev/video2`` absent). Route should surface
    this as HTTP 503.
    """
    reg = {"live_shelf": _StubDaemon(), "catch_all": None}
    assert mjpeg.resolve_daemon(reg, "catch_all") is None


def test_resolve_daemon_unknown_shelf_raises_keyerror():
    """Shelf key isn't in the registry at all — caller used a typo or
    asked for a shelf the backend doesn't know about. Route should
    surface this as HTTP 404, which is why we raise rather than return
    ``None`` (a ``None`` return means "hardware absent", which the route
    must distinguish).
    """
    reg = {"live_shelf": _StubDaemon()}
    with pytest.raises(KeyError):
        mjpeg.resolve_daemon(reg, "pantry")


def test_resolve_daemon_defaults_to_live_shelf_when_empty_or_none():
    live = _StubDaemon()
    reg = {"live_shelf": live}
    assert mjpeg.resolve_daemon(reg, None) is live
    assert mjpeg.resolve_daemon(reg, "") is live
    assert mjpeg.resolve_daemon(reg, "   ") is live


def test_resolve_daemon_empty_registry_raises_for_default_shelf():
    """Defensive: if the registry is completely empty (no shelves wired
    yet), even the default fallback should raise KeyError rather than
    silently returning None and masking a configuration bug."""
    with pytest.raises(KeyError):
        mjpeg.resolve_daemon({}, None)
