"""Extra validator cases beyond the pre-NTP rejection in test_validators.py.

Covers:
  * NaN / Infinity rejection for numeric fields.
  * Sign-consistency check between delta_g and (after - before).
  * Floating-point drift within the 1g tolerance is accepted.

These guards prevent garbage payloads from corrupting classifier math
(``abs(delta_g)`` on NaN gives NaN, which poisons every downstream
comparison).
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.handlers import scale_events  # noqa: E402


def _payload(**overrides) -> dict:
    base = {
        "ts": "2026-04-15T12:00:00.000Z",
        "device_id": "scale-01",
        "delta_g": -100.0,
        "before_weight_g": 500.0,
        "after_weight_g": 400.0,
        "event_seq": 1,
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# NaN / infinity rejection
# ---------------------------------------------------------------------------


def test_validate_event_payload_rejects_nan():
    """float('nan') in delta_g must produce a 400-triggering error.
    Downstream code does ``abs(delta_g)`` and comparisons; NaN silently
    poisons every check.
    """
    err = scale_events._validate_event_payload(
        _payload(delta_g=float("nan"))
    )
    assert err is not None
    assert "finite" in err.lower() or "delta_g" in err


def test_validate_event_payload_rejects_infinity():
    """float('inf') in after_weight_g must be rejected."""
    err = scale_events._validate_event_payload(
        _payload(after_weight_g=float("inf"))
    )
    assert err is not None
    assert "finite" in err.lower() or "after_weight_g" in err


# ---------------------------------------------------------------------------
# Sign-consistency check
# ---------------------------------------------------------------------------


def test_validate_event_payload_rejects_sign_mismatch():
    """delta_g=-200 but (before - after) = 500 → 300g discrepancy, well
    above the 1g tolerance. Must reject with an 'inconsistent' message
    so ESP hardware glitches / replays don't feed the classifier lies.
    """
    err = scale_events._validate_event_payload(_payload(
        delta_g=-200.0,
        before_weight_g=1000.0,
        after_weight_g=500.0,  # actual delta = -500, mismatch by 300
    ))
    assert err is not None
    assert "inconsistent" in err.lower()


def test_validate_event_payload_accepts_small_floating_point_drift():
    """0.3g drift is within the 1g tolerance → accepted. Protects against
    false rejections from normal ESP float precision."""
    err = scale_events._validate_event_payload(_payload(
        delta_g=100.0,
        before_weight_g=0.0,
        after_weight_g=100.3,  # computed delta 100.3, diff 0.3g < 1g
    ))
    assert err is None, f"expected accept for tiny drift; got {err!r}"
