"""Pin the calibrated v4l2 default values.

These numbers were measured on the physical rig. A drift in any one of
them (e.g. exposure_time_absolute accidentally bumped to 400) would
regress the post-open brightness-settling behavior that the
session-capture module depends on.
"""

from __future__ import annotations

from server.camera.locked_settings import DEFAULT_LOCKED_SETTINGS


def test_default_locked_settings_exposure_166():
    """All four key values must match the calibrated rig values."""
    d = dict(DEFAULT_LOCKED_SETTINGS)
    assert d["exposure_time_absolute"] == 166
    assert d["auto_exposure"] == 1  # Manual Mode
    assert d["white_balance_temperature"] == 4600
    assert d["focus_absolute"] == 0
