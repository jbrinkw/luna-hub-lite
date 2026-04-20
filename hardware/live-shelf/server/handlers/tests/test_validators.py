"""Direct tests for ``_validate_event_payload`` and
``_validate_heartbeat_payload`` in ``server.handlers.scale_events``.

The ESP firmware falls back to a 1970-based ``millis()/1000`` timestamp
before NTP syncs. Silently accepting those creates orphan events with
1970 timestamps that no session window can ever claim, corrupting
session correlation. The validators must reject any ``ts`` whose year
is before ``_MIN_PLAUSIBLE_YEAR`` (= 2024) with a 400-triggering error
string so the ESP's FIFO retries post-NTP.

The happy-path branch is already covered by ``test_integration.py``;
this module pins the pre-NTP rejection contract so a regression in the
validator can't sneak back in.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.handlers import scale_events  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _valid_event_payload(ts: str) -> dict:
    """Build a minimal event payload with all required fields set.

    Only ``ts`` varies across the rejection tests; the weight math is
    kept sign-consistent so the 1g tolerance check doesn't fire first
    and mask the pre-NTP error we actually want to assert on.
    """
    return {
        "ts": ts,
        "device_id": "scale-01",
        "delta_g": -200.0,
        "before_weight_g": 1000.0,
        "after_weight_g": 800.0,
        "event_seq": 1,
    }


def _valid_heartbeat_payload(ts: str) -> dict:
    return {
        "ts": ts,
        "device_id": "scale-01",
        "weight_g": 500.0,
    }


# ---------------------------------------------------------------------------
# Event payload — pre-NTP rejection
# ---------------------------------------------------------------------------


def test_validate_event_payload_rejects_pre_ntp_ts():
    """A 1970-epoch timestamp (ESP pre-NTP fallback) must be rejected by
    ``_validate_event_payload``. The returned error string must mention
    the NTP condition so the ESP firmware can surface it in its retry
    logs rather than silently dropping the event.
    """
    # 1970-01-01 — classic ESP pre-NTP output (year 1970 < 2024).
    payload = _valid_event_payload("1970-01-01T00:00:05.000Z")

    err = scale_events._validate_event_payload(payload)

    assert err is not None, "expected a non-None error for pre-NTP ts"
    # Error must reference NTP so the firmware / UI can distinguish it
    # from other validation failures (missing fields, bad weights, etc.).
    assert "NTP" in err


def test_validate_event_payload_rejects_year_2023_ts():
    """Boundary: ``_MIN_PLAUSIBLE_YEAR`` is 2024, so 2023 must still
    reject. Guards against off-by-one regressions in the year check.
    """
    payload = _valid_event_payload("2023-12-31T23:59:59.000Z")

    err = scale_events._validate_event_payload(payload)

    assert err is not None
    assert "NTP" in err


def test_validate_event_payload_accepts_year_2026_ts():
    """Counter-test for the rejection path: a present-day ts (2026) must
    NOT be rejected by the pre-NTP guard. This confirms the validator
    returns None on the happy branch, not a coincidental error from
    elsewhere in the validator.
    """
    payload = _valid_event_payload("2026-04-15T12:00:00.000Z")

    err = scale_events._validate_event_payload(payload)

    assert err is None, f"unexpected validation error: {err}"


# ---------------------------------------------------------------------------
# Heartbeat payload — pre-NTP rejection
# ---------------------------------------------------------------------------


def test_validate_heartbeat_payload_rejects_pre_ntp_ts():
    """Same contract as events: a heartbeat with a 1970 timestamp would
    update ``last_scale_weight_g`` alongside a meaningless ts, polluting
    the weight trace and session-correlation data. Reject with 400 so
    the ESP retries after NTP.
    """
    payload = _valid_heartbeat_payload("1970-01-01T00:00:05.000Z")

    err = scale_events._validate_heartbeat_payload(payload)

    assert err is not None
    assert "NTP" in err


def test_validate_heartbeat_payload_rejects_year_2023_ts():
    """Boundary: 2023 is still below _MIN_PLAUSIBLE_YEAR and must reject.
    """
    payload = _valid_heartbeat_payload("2023-12-31T23:59:59.000Z")

    err = scale_events._validate_heartbeat_payload(payload)

    assert err is not None
    assert "NTP" in err


def test_validate_heartbeat_payload_accepts_year_2026_ts():
    """Counter-test: present-day ts must pass the pre-NTP guard."""
    payload = _valid_heartbeat_payload("2026-04-15T12:00:00.000Z")

    err = scale_events._validate_heartbeat_payload(payload)

    assert err is None, f"unexpected validation error: {err}"


# ---------------------------------------------------------------------------
# Helper: _ts_is_pre_ntp (belt-and-suspenders direct test)
# ---------------------------------------------------------------------------


def test_ts_is_pre_ntp_true_for_1970():
    """Direct test of the underlying helper — catches regressions where
    the helper's year check drifts even if the wrapping validators are
    updated to call through to a different helper.
    """
    assert scale_events._ts_is_pre_ntp("1970-01-01T00:00:00.000Z") is True


def test_ts_is_pre_ntp_false_for_current_era():
    """Helper must accept timestamps at or after _MIN_PLAUSIBLE_YEAR."""
    assert scale_events._ts_is_pre_ntp("2026-04-15T12:00:00.000Z") is False


def test_ts_is_pre_ntp_false_for_year_boundary():
    """Year == _MIN_PLAUSIBLE_YEAR (2024) itself must NOT be flagged —
    the check is strictly ``year < _MIN_PLAUSIBLE_YEAR``.
    """
    assert (
        scale_events._ts_is_pre_ntp("2024-01-01T00:00:00.000Z") is False
    )
