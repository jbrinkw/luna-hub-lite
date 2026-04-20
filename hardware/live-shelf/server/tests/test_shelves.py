"""Tests for the shelf registry (CATCH_ALL_SCALE_PLAN.md §4.3)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.config import AppConfig  # noqa: E402
from server.shelves import (  # noqa: E402
    DEFAULT_REGISTRY,
    build_registry_from_config,
    get_shelf_for_device,
)


def test_default_registry_has_all_shelves():
    assert set(DEFAULT_REGISTRY.keys()) == {"live_shelf", "catch_all", "live_scale"}


def test_live_shelf_defaults():
    s = DEFAULT_REGISTRY["live_shelf"]
    assert s.device_id == "scale-01"
    assert s.session_trigger == "brightness"
    assert s.photo_delay_seconds == 0.0


def test_catch_all_defaults():
    s = DEFAULT_REGISTRY["catch_all"]
    assert s.device_id == "scale-02"
    assert s.session_trigger == "weight"
    assert s.photo_delay_seconds == 1.5
    assert s.camera_device == "/dev/video2"


def test_get_shelf_for_device_scale_01_returns_live_shelf():
    shelf = get_shelf_for_device("scale-01")
    assert shelf is not None
    assert shelf.shelf_id == "live_shelf"


def test_get_shelf_for_device_scale_02_returns_catch_all():
    shelf = get_shelf_for_device("scale-02")
    assert shelf is not None
    assert shelf.shelf_id == "catch_all"


def test_get_shelf_for_device_unknown_returns_none():
    assert get_shelf_for_device("scale-99") is None


def test_build_registry_from_config_applies_catch_all_overrides():
    cfg = AppConfig()
    cfg.catch_all_device_id = "scale-42"
    cfg.catch_all_camera_device = "/dev/video7"
    cfg.catch_all_photo_delay_s = 2.25

    registry = build_registry_from_config(cfg)
    assert registry["catch_all"].device_id == "scale-42"
    assert registry["catch_all"].camera_device == "/dev/video7"
    assert registry["catch_all"].photo_delay_seconds == 2.25
    # live_shelf untouched.
    assert registry["live_shelf"].device_id == "scale-01"


def test_get_shelf_for_device_respects_custom_registry():
    cfg = AppConfig()
    cfg.catch_all_device_id = "scale-custom"
    registry = build_registry_from_config(cfg)
    assert get_shelf_for_device("scale-custom", registry).shelf_id == "catch_all"
    assert get_shelf_for_device("scale-02", registry) is None
