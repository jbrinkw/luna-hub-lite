"""Unit tests for the Pi clock-drift monitor in ``server.cloud.client``.

The monitor is called from ``CloudClient._parse_or_raise`` on every
response. It parses the cloud-supplied HTTP ``Date`` header, computes
drift vs the local UTC clock, and logs a WARNING when drift exceeds
:data:`DRIFT_WARN_THRESHOLD_S`, with a :data:`DRIFT_LOG_COOLDOWN_S`
cooldown so sustained skew doesn't flood logs.

Tests drive ``observe_drift`` directly rather than through the full
HTTP path: we only care about the drift math + cooldown logic here.
"""

from __future__ import annotations

import email.utils
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.client import (  # noqa: E402
    DRIFT_LOG_COOLDOWN_S,
    DRIFT_WARN_THRESHOLD_S,
    _reset_drift_state_for_tests,
    get_last_drift_s,
    observe_drift,
)


@pytest.fixture(autouse=True)
def _reset_state():
    """Every test starts from a clean module-level drift state."""
    _reset_drift_state_for_tests()
    yield
    _reset_drift_state_for_tests()


def _fmt(dt: datetime) -> str:
    """RFC 7231 / RFC 1123 Date header (matches what HTTP servers emit)."""
    return email.utils.format_datetime(dt, usegmt=True)


class TestDriftBasics:
    def test_no_header_returns_none(self, caplog):
        caplog.set_level(logging.WARNING, logger="server.cloud.client")
        assert observe_drift(None) is None
        assert get_last_drift_s() is None
        assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []

    def test_malformed_header_returns_none(self, caplog):
        caplog.set_level(logging.WARNING, logger="server.cloud.client")
        assert observe_drift("not-a-date") is None
        assert get_last_drift_s() is None
        assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []

    def test_small_drift_does_not_log(self, caplog):
        """<= threshold: silently update last-known drift, no WARNING."""
        caplog.set_level(logging.WARNING, logger="server.cloud.client")
        local = datetime(2026, 4, 21, 12, 0, 0, tzinfo=timezone.utc)
        # Cloud is 5s ahead — well under the 60s threshold.
        cloud = local + timedelta(seconds=5)
        drift = observe_drift(_fmt(cloud), now_fn=lambda: local)
        assert drift == pytest.approx(5.0)
        assert get_last_drift_s() == pytest.approx(5.0)
        warn_records = [
            r for r in caplog.records if r.levelno >= logging.WARNING
        ]
        assert warn_records == []


class TestDriftLoggingAndCooldown:
    def test_drift_above_threshold_fires_warning(self, caplog):
        """>= threshold: WARN, and state records the drift."""
        caplog.set_level(logging.WARNING, logger="server.cloud.client")
        local = datetime(2026, 4, 21, 12, 0, 0, tzinfo=timezone.utc)
        cloud = local + timedelta(seconds=120)  # 120s > 60s threshold

        drift = observe_drift(_fmt(cloud), now_fn=lambda: local)

        assert drift == pytest.approx(120.0)
        assert get_last_drift_s() == pytest.approx(120.0)
        warn = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert len(warn) == 1
        assert "drift" in warn[0].getMessage().lower()

    def test_cooldown_suppresses_second_warning_within_10min(self, caplog):
        """Inside cooldown window: first WARN fires, second is suppressed."""
        caplog.set_level(logging.WARNING, logger="server.cloud.client")
        t0 = datetime(2026, 4, 21, 12, 0, 0, tzinfo=timezone.utc)
        cloud0 = t0 + timedelta(seconds=120)
        observe_drift(_fmt(cloud0), now_fn=lambda: t0)

        # 5 minutes later — still inside the 10-minute cooldown.
        t1 = t0 + timedelta(minutes=5)
        cloud1 = t1 + timedelta(seconds=120)
        observe_drift(_fmt(cloud1), now_fn=lambda: t1)

        warn = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert len(warn) == 1  # only the first observation logged

    def test_cooldown_elapses_and_second_warning_fires(self, caplog):
        """Past cooldown: a fresh drift observation WARNs again."""
        caplog.set_level(logging.WARNING, logger="server.cloud.client")
        t0 = datetime(2026, 4, 21, 12, 0, 0, tzinfo=timezone.utc)
        cloud0 = t0 + timedelta(seconds=120)
        observe_drift(_fmt(cloud0), now_fn=lambda: t0)

        # Past the cooldown (10 min + 1s).
        t1 = t0 + timedelta(seconds=int(DRIFT_LOG_COOLDOWN_S) + 1)
        cloud1 = t1 + timedelta(seconds=120)
        observe_drift(_fmt(cloud1), now_fn=lambda: t1)

        warn = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert len(warn) == 2

    def test_negative_drift_also_warns(self, caplog):
        """Drift is signed; Pi ahead of cloud must also surface."""
        caplog.set_level(logging.WARNING, logger="server.cloud.client")
        local = datetime(2026, 4, 21, 12, 0, 0, tzinfo=timezone.utc)
        cloud = local - timedelta(seconds=120)

        drift = observe_drift(_fmt(cloud), now_fn=lambda: local)

        assert drift == pytest.approx(-120.0)
        warn = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert len(warn) == 1


class TestThresholdExactBoundary:
    def test_drift_at_exact_threshold_does_not_fire(self, caplog):
        """Monitor uses ``> threshold``, so exactly 60s is silent."""
        caplog.set_level(logging.WARNING, logger="server.cloud.client")
        local = datetime(2026, 4, 21, 12, 0, 0, tzinfo=timezone.utc)
        cloud = local + timedelta(seconds=int(DRIFT_WARN_THRESHOLD_S))

        observe_drift(_fmt(cloud), now_fn=lambda: local)

        warn = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert warn == []
