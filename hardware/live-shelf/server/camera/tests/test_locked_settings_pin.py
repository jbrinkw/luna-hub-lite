"""Pin the calibrated v4l2 default values.

These numbers were measured on the physical rig. A drift in any one of
them (e.g. exposure_time_absolute accidentally bumped to 400) would
regress the post-open brightness-settling behavior that the
session-capture module depends on.

History:
    * 2026-04-21: exposure_time_absolute lowered from 166 → 8 after
      real fridge sessions showed 38/39 archived frames saturated at
      mean=249 with the LED on. Also added backlight_compensation=0
      and brightness=0 to the lock to stop post-exposure pixel-lift.
"""

from __future__ import annotations

from server.camera.locked_settings import DEFAULT_LOCKED_SETTINGS


def test_default_locked_settings_values():
    """Key values must match the calibrated rig values."""
    d = dict(DEFAULT_LOCKED_SETTINGS)
    assert d["exposure_time_absolute"] == 8
    assert d["auto_exposure"] == 1  # Manual Mode
    assert d["white_balance_temperature"] == 4600
    assert d["focus_absolute"] == 0
    assert d["backlight_compensation"] == 0
    assert d["brightness"] == 0
