"""Orchestrator handlers — glue between external triggers and subsystems.

* :mod:`brightness` — callback bound to :class:`camera.CameraDaemon`'s
  transition stream. Opens/closes sessions and runs reconciliation.
* :mod:`scale_events` — Flask blueprint for ``/api/scale-event`` and
  ``/api/scale-heartbeat`` from the ESP firmware.
"""

from __future__ import annotations

from .brightness import BrightnessHandler
from .scale_events import ScaleHandler, make_scale_bp

__all__ = ["BrightnessHandler", "ScaleHandler", "make_scale_bp"]
