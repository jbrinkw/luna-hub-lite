"""Tests for the volatile scale runtime-state cache in ``scale_events``.

The cache is written by heartbeats and read by ``/api/state``. After an ESP
reboot, the stored ``scale_stable`` can remain pre-reboot indefinitely if no
fresh heartbeat arrives — so the getter enforces a TTL and suppresses stale
entries from reads without deleting them.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from server.handlers import scale_events


@pytest.fixture(autouse=True)
def _clear_runtime_state():
    """Each test starts with an empty runtime-state cache."""
    with scale_events._SCALE_RUNTIME_LOCK:
        scale_events._SCALE_RUNTIME_STATE.clear()
    yield
    with scale_events._SCALE_RUNTIME_LOCK:
        scale_events._SCALE_RUNTIME_STATE.clear()


def _now_iso(offset_seconds: float = 0.0) -> str:
    return (
        datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)
    ).isoformat()


def _seed(device_id: str, *, ts: str, **extra) -> None:
    with scale_events._SCALE_RUNTIME_LOCK:
        scale_events._SCALE_RUNTIME_STATE[device_id] = {
            "device_id": device_id,
            "ts": ts,
            "stable": True,
            "weight_g": 1234.5,
            "uptime_s": 10,
            **extra,
        }


class TestRuntimeStateTTL:
    def test_empty_returns_empty_dict(self):
        assert scale_events.get_scale_runtime_state() == {}
        assert scale_events.get_scale_runtime_state("scale-01") == {}

    def test_fresh_heartbeat_returned(self):
        _seed("scale-01", ts=_now_iso(offset_seconds=-1.0))
        state = scale_events.get_scale_runtime_state()
        assert state["device_id"] == "scale-01"
        assert state["stable"] is True
        assert state["weight_g"] == 1234.5

    def test_fresh_by_device_id(self):
        _seed("scale-01", ts=_now_iso(offset_seconds=-0.5))
        state = scale_events.get_scale_runtime_state("scale-01")
        assert state["device_id"] == "scale-01"

    def test_unknown_device_id_returns_empty(self):
        _seed("scale-01", ts=_now_iso())
        assert scale_events.get_scale_runtime_state("does-not-exist") == {}

    def test_stale_entry_suppressed_default_lookup(self):
        """An entry older than the TTL must be hidden from the default read."""
        stale_ts = _now_iso(
            offset_seconds=-(scale_events._RUNTIME_STATE_TTL_SECONDS + 1.0)
        )
        _seed("scale-01", ts=stale_ts)
        # Default (no device_id): should return empty because the only
        # entry is stale.
        assert scale_events.get_scale_runtime_state() == {}

    def test_stale_entry_suppressed_device_lookup(self):
        stale_ts = _now_iso(
            offset_seconds=-(scale_events._RUNTIME_STATE_TTL_SECONDS + 5.0)
        )
        _seed("scale-01", ts=stale_ts)
        assert scale_events.get_scale_runtime_state("scale-01") == {}

    def test_stale_entry_is_not_deleted(self):
        """Stale entries must remain in the dict so a fresh heartbeat can revive
        them without losing device metadata."""
        stale_ts = _now_iso(
            offset_seconds=-(scale_events._RUNTIME_STATE_TTL_SECONDS + 30.0)
        )
        _seed("scale-01", ts=stale_ts, uptime_s=999)
        # Reader suppresses...
        assert scale_events.get_scale_runtime_state("scale-01") == {}
        # ...but the underlying entry is still there.
        with scale_events._SCALE_RUNTIME_LOCK:
            assert "scale-01" in scale_events._SCALE_RUNTIME_STATE
            assert (
                scale_events._SCALE_RUNTIME_STATE["scale-01"]["uptime_s"] == 999
            )

    def test_fresh_revives_previously_stale_entry(self):
        """After a fresh heartbeat, the entry is readable again."""
        stale_ts = _now_iso(
            offset_seconds=-(scale_events._RUNTIME_STATE_TTL_SECONDS + 5.0)
        )
        _seed("scale-01", ts=stale_ts, stable=False)
        assert scale_events.get_scale_runtime_state("scale-01") == {}
        # New heartbeat: just overwrite the entry.
        _seed("scale-01", ts=_now_iso(offset_seconds=-0.2), stable=True)
        state = scale_events.get_scale_runtime_state("scale-01")
        assert state["stable"] is True

    def test_malformed_ts_treated_as_stale(self):
        """If the stored ts is unparseable, suppress the entry defensively."""
        _seed("scale-01", ts="not-a-timestamp")
        assert scale_events.get_scale_runtime_state("scale-01") == {}

    def test_missing_ts_treated_as_stale(self):
        with scale_events._SCALE_RUNTIME_LOCK:
            scale_events._SCALE_RUNTIME_STATE["scale-01"] = {
                "device_id": "scale-01",
                "stable": True,
                # no 'ts' key
            }
        assert scale_events.get_scale_runtime_state("scale-01") == {}

    def test_z_suffix_accepted(self):
        """ISO-8601 with 'Z' shorthand for UTC must parse correctly."""
        # datetime.isoformat() emits '+00:00'; simulate an older client
        # that sends the 'Z' shorthand.
        fresh = (datetime.now(timezone.utc) - timedelta(seconds=1)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        _seed("scale-01", ts=fresh)
        state = scale_events.get_scale_runtime_state("scale-01")
        assert state.get("device_id") == "scale-01"


class TestRuntimeStateSnapshot:
    """Cover ``get_scale_runtime_state_snapshot`` — the multi-device
    accessor wired into :class:`WeightSyncPoller` for live_scale lots."""

    def test_empty_returns_empty_dict(self):
        assert scale_events.get_scale_runtime_state_snapshot() == {}

    def test_returns_only_fresh_devices(self):
        """Stale entries are excluded from the snapshot."""
        _seed("scale-fresh", ts=_now_iso(offset_seconds=-0.5), weight_g=120.0)
        _seed("scale-stale", ts=_now_iso(offset_seconds=-300.0), weight_g=999.0)
        snap = scale_events.get_scale_runtime_state_snapshot()
        assert "scale-fresh" in snap
        assert "scale-stale" not in snap
        assert snap["scale-fresh"]["weight_g"] == 120.0

    def test_returns_independent_copies(self):
        """Mutating a returned entry must NOT mutate the underlying state."""
        _seed("scale-1", ts=_now_iso(offset_seconds=-0.5), weight_g=50.0)
        snap = scale_events.get_scale_runtime_state_snapshot()
        snap["scale-1"]["weight_g"] = 9999.0
        # Re-read; should still be the original value.
        snap2 = scale_events.get_scale_runtime_state_snapshot()
        assert snap2["scale-1"]["weight_g"] == 50.0

    def test_multiple_devices_all_returned(self):
        for i in range(3):
            _seed(f"scale-{i}", ts=_now_iso(offset_seconds=-0.1), weight_g=i)
        snap = scale_events.get_scale_runtime_state_snapshot()
        assert set(snap.keys()) == {"scale-0", "scale-1", "scale-2"}
