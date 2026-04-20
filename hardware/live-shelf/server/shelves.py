"""Shelf registry — CATCH_ALL_SCALE_PLAN.md §4.3.

Two physical shelves in the demo:
  * 'live_shelf'  — the door-gated fridge shelf (scale-01 + /dev/video0)
  * 'catch_all'   — the weight-gated countertop scale (scale-02 + /dev/video2)

A tiny static registry + a ``get_shelf_for_device(device_id)`` helper is
enough while we have exactly two. If we ever scale to N shelves, promote
this module to a real ``shelves`` DB table with rows + CRUD.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Optional


ShelfId = Literal["live_shelf", "catch_all", "live_scale"]
SessionTrigger = Literal["brightness", "weight"]


@dataclass(frozen=True)
class ShelfConfig:
    """Static config for one physical shelf.

    ``photo_delay_seconds`` governs how long after the first scale-event
    ingress the frame picker reaches into the camera ring buffer. The
    live shelf uses 0 because the frame picker already handles settle
    via brightness-domain anchoring; the catch-all uses 1.5 s to let the
    user's hand clear the shot (CATCH_ALL_SCALE_PLAN.md §5.1).

    ``session_trigger`` selects the session open/close driver:
      * ``brightness`` — existing door-gated path (BrightnessHandler).
      * ``weight``     — catch-all path (WeightHandler), opens when
                         weight rises above threshold, closes on zero.
    """

    shelf_id: ShelfId
    name: str
    device_id: str          # ESP device_id expected on scale-event ingress
    camera_device: str      # e.g. "/dev/video0"
    session_trigger: SessionTrigger
    photo_delay_seconds: float


# Default registry — overridable at load time via `build_registry_from_config`.
DEFAULT_REGISTRY: dict[ShelfId, ShelfConfig] = {
    "live_shelf": ShelfConfig(
        shelf_id="live_shelf",
        name="Live Shelf",
        device_id="scale-01",
        camera_device="/dev/video0",
        session_trigger="brightness",
        photo_delay_seconds=0.0,
    ),
    "catch_all": ShelfConfig(
        shelf_id="catch_all",
        name="Catch-all",
        device_id="scale-02",
        camera_device="/dev/video2",
        session_trigger="weight",
        photo_delay_seconds=1.5,
    ),
    # Single-item scale (LiquidTrack-style). No camera — cloud resolves
    # product_id via scale_pairings. Event handling is pending; the
    # registry entry here makes the cloud UI aware of the scale so the
    # user can pair it to a product ahead of full handler support.
    "live_scale": ShelfConfig(
        shelf_id="live_scale",
        name="Single-item scale",
        device_id="scale-03",
        camera_device="",
        session_trigger="weight",
        photo_delay_seconds=0.0,
    ),
}


def build_registry_from_config(cfg: Any) -> dict[ShelfId, ShelfConfig]:
    """Materialize a registry with any overrides from ``AppConfig``.

    Only the catch-all's four tunable fields can be overridden via env
    (via the existing config.py loader). The live-shelf entry uses the
    hardcoded defaults — it's been running on scale-01 + /dev/video0
    since day one.
    """
    return {
        "live_shelf": DEFAULT_REGISTRY["live_shelf"],
        "catch_all": ShelfConfig(
            shelf_id="catch_all",
            name="Catch-all",
            device_id=getattr(cfg, "catch_all_device_id", "scale-02"),
            camera_device=getattr(cfg, "catch_all_camera_device", "/dev/video2"),
            session_trigger="weight",
            photo_delay_seconds=float(
                getattr(cfg, "catch_all_photo_delay_s", 1.5)
            ),
        ),
        "live_scale": DEFAULT_REGISTRY["live_scale"],
    }


def get_shelf_for_device(
    device_id: str,
    registry: Optional[dict[ShelfId, ShelfConfig]] = None,
) -> Optional[ShelfConfig]:
    """Resolve an incoming ``device_id`` to its shelf config.

    Returns None for an unknown device — the caller should treat that
    as a configuration mismatch (typically: log + reject the event).
    """
    reg = registry if registry is not None else DEFAULT_REGISTRY
    for shelf in reg.values():
        if shelf.device_id == device_id:
            return shelf
    return None


__all__ = [
    "DEFAULT_REGISTRY",
    "ShelfConfig",
    "ShelfId",
    "SessionTrigger",
    "build_registry_from_config",
    "get_shelf_for_device",
]
