"""Tests for the per-(device, scale) wizard suppression refactor (2026-04-27).

Closes Smell #8: pre-fix the wizard-suppression gate suppressed ALL Pi
events globally while ANY wizard session was active. Calibrating
scale-03 (live_scale) would freeze unrelated scale-01 (live_shelf)
events. The fix scopes suppression to ``(device_id, scale_id)`` tuples
so unrelated scales keep flowing.

Two layers under test:

  1. ``LiveTrackPoller.is_active_for(device_id, scale_id)`` — returns
     the matching session row only when both keys match. Mismatch on
     either side returns None.

  2. ``ScaleHandler._is_wizard_active_for(device_id, scale_id)`` — the
     gate predicate. Per-tuple match → suppress. Per-tuple miss → don't
     suppress (the very fix). Legacy global fallback only kicks in when
     scale_id is unknown.

  3. End-to-end: ``handle_scale_event`` for scale-01 with a wizard open
     against scale-02 → event is NOT suppressed (regression of the very
     bug). Wizard against scale-01 → that scale's events ARE suppressed.

The mutation argument: stripping the per-tuple match (e.g. returning
True from is_active_for unconditionally when ANY session is active) is
exactly the pre-fix behavior. These tests turn red on that mutation.
"""

from __future__ import annotations

import datetime as _dt
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.cloud.livetrack_poller import LiveTrackPoller  # noqa: E402
from server.config import AppConfig  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.shelves import build_registry_from_config  # noqa: E402
from server.storage import init_db  # noqa: E402


def _now_iso(offset_s: float = 0.0) -> str:
    t = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=offset_s)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Stubs
# ---------------------------------------------------------------------------


class _StubClient:
    """CloudClient stub serving the new multi-session list shape."""

    def __init__(self, sessions: list[dict] | None = None) -> None:
        self._sessions = sessions or []
        self.updates: list[tuple[str, dict]] = []

    def get_active_livetrack_sessions(self) -> list[dict]:
        return list(self._sessions)

    def get_active_livetrack_session(self):
        # Legacy single-session API — still queried by older callers.
        return self._sessions[0] if self._sessions else None

    def post_livetrack_session_update(self, session_id, **fields):
        self.updates.append((session_id, dict(fields)))
        return {"session_id": session_id, **fields}


class _NullCandidateSource:
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _make_handler(conn, tmp_path, *, poller=None, catch_all_enabled=True):
    cfg = AppConfig()
    cfg.catch_all_enabled = catch_all_enabled
    registry = build_registry_from_config(cfg)
    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    handler = ScaleHandler(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
        catch_all_enabled=catch_all_enabled,
        shelf_registry_override=registry,
    )
    if poller is not None:
        handler.set_livetrack_poller(poller)
    return handler


# ---------------------------------------------------------------------------
# Layer 1: LiveTrackPoller.is_active_for
# ---------------------------------------------------------------------------


def test_is_active_for_matches_only_specified_scale():
    """One session for scale-02. Lookup matches that scale_id only —
    other scales return None. The cloud-side device_id is the UUID of
    the live_shelf_devices row; every session reaching this poller
    belongs to THIS Pi by construction, so the lookup keys on scale_id
    alone (the device_id arg is required but used only for non-empty
    validation).
    Mutation kill: removing the ``sid == scale_str`` filter would
    return True for every lookup → recreates pre-fix global
    suppression."""
    client = _StubClient([
        {
            "session_id": "s1",
            "device_id": "cloud-uuid-A",
            "scale_id": "scale-02",
            "state": "waiting_barcode",
            "created_at": _now_iso(),
        },
    ])
    poller = LiveTrackPoller(client)
    poller.tick_once()

    # Hit: scale-02 (any non-empty device_id passes).
    hit = poller.is_active_for("scale-02", "scale-02")
    assert hit is not None
    assert hit["session_id"] == "s1"
    # Caller-side device_id is irrelevant when the cloud already scoped
    # the response to this Pi.
    hit2 = poller.is_active_for("anything-non-empty", "scale-02")
    assert hit2 is not None

    # Miss: different scale_id — THE regression fix.
    assert poller.is_active_for("scale-01", "scale-01") is None
    assert poller.is_active_for("scale-03", "scale-03") is None


def test_is_active_for_with_multiple_active_sessions():
    """Two sessions on the same device, different scales. Each scale_id
    resolves to its own row independently."""
    client = _StubClient([
        {
            "session_id": "s1",
            "device_id": "cloud-uuid-A",
            "scale_id": "scale-01",
            "state": "waiting_barcode",
            "created_at": _now_iso(),
        },
        {
            "session_id": "s2",
            "device_id": "cloud-uuid-A",
            "scale_id": "scale-03",
            "state": "waiting_scale",
            "created_at": _now_iso(),
        },
    ])
    poller = LiveTrackPoller(client)
    poller.tick_once()

    h1 = poller.is_active_for("scale-01", "scale-01")
    h2 = poller.is_active_for("scale-03", "scale-03")
    assert h1 is not None and h1["session_id"] == "s1"
    assert h2 is not None and h2["session_id"] == "s2"
    # Untargeted scale on the same Pi still misses.
    assert poller.is_active_for("scale-02", "scale-02") is None


def test_is_active_for_returns_shallow_copy():
    """Mutating the returned row must not bleed into the poller cache."""
    client = _StubClient([
        {
            "session_id": "s1", "device_id": "cloud-uuid-A", "scale_id": "scale-02",
            "state": "waiting_barcode", "created_at": _now_iso(),
        },
    ])
    poller = LiveTrackPoller(client)
    poller.tick_once()

    snap = poller.is_active_for("scale-02", "scale-02")
    snap["state"] = "MUTATED"
    snap2 = poller.is_active_for("scale-02", "scale-02")
    assert snap2["state"] == "waiting_barcode"


def test_is_active_for_none_args_returns_none():
    """Defensive: missing keys must NOT match — keeps the gate narrow."""
    client = _StubClient([
        {
            "session_id": "s1", "device_id": "cloud-uuid-A", "scale_id": "scale-02",
            "state": "waiting_barcode", "created_at": _now_iso(),
        },
    ])
    poller = LiveTrackPoller(client)
    poller.tick_once()

    assert poller.is_active_for(None, "scale-02") is None
    assert poller.is_active_for("scale-02", None) is None
    assert poller.is_active_for("", "scale-02") is None
    assert poller.is_active_for("scale-02", "") is None


def test_active_tuples_returns_set_of_tuples():
    client = _StubClient([
        {
            "session_id": "s1", "device_id": "cloud-uuid-A", "scale_id": "scale-01",
            "state": "waiting_barcode", "created_at": _now_iso(),
        },
        {
            "session_id": "s2", "device_id": "cloud-uuid-A", "scale_id": "scale-03",
            "state": "waiting_scale", "created_at": _now_iso(),
        },
    ])
    poller = LiveTrackPoller(client)
    poller.tick_once()

    tuples = poller.active_tuples()
    assert ("cloud-uuid-A", "scale-01") in tuples
    assert ("cloud-uuid-A", "scale-03") in tuples
    assert poller.active_scale_ids() == {"scale-01", "scale-03"}


def test_legacy_snapshot_still_reflects_newest_session():
    """Pre-existing callers using ``snapshot()`` keep working — newest
    row across every scale on the device. Important for the catch-all
    waiting_scale interception branch in scale_events.py."""
    client = _StubClient([
        {
            "session_id": "s_new", "device_id": "cloud-uuid-A", "scale_id": "scale-02",
            "state": "waiting_scale", "created_at": _now_iso(),
        },
        {
            "session_id": "s_old", "device_id": "cloud-uuid-A", "scale_id": "scale-01",
            "state": "waiting_barcode", "created_at": _now_iso(offset_s=-30),
        },
    ])
    poller = LiveTrackPoller(client)
    poller.tick_once()

    legacy = poller.snapshot()
    assert legacy is not None
    # Newest-first ordering: server returns s_new first.
    assert legacy["session_id"] == "s_new"


def test_legacy_client_fallback_when_method_missing(monkeypatch):
    """Test stubs constructed before this refactor only implement the
    single-session API. The poller must still work via the legacy
    fallback path."""

    class _LegacyOnlyClient:
        def __init__(self):
            self.session = {
                "session_id": "s1", "device_id": "cloud-uuid-A", "scale_id": "scale-02",
                "state": "waiting_barcode", "created_at": _now_iso(),
            }

        def get_active_livetrack_session(self):
            return self.session

    poller = LiveTrackPoller(_LegacyOnlyClient())
    poller.tick_once()

    # Legacy snapshot populated.
    assert poller.snapshot() is not None
    # Per-tuple lookup also works since the legacy session carries scale_id.
    hit = poller.is_active_for("scale-02", "scale-02")
    assert hit is not None


# ---------------------------------------------------------------------------
# Layer 2: ScaleHandler._is_wizard_active_for
# ---------------------------------------------------------------------------


class _StubPollerExact:
    """Poller with a pre-baked per-scale snapshot — bypasses tick_once
    so the gate predicate test stays decoupled from the poller's polling
    behavior. Mirrors the real LiveTrackPoller's lookup contract:
    ``is_active_for`` keys on scale_id alone (since every snapshot
    belongs to THIS Pi by construction; cloud's device_id UUID never
    matches the ESP-supplied scale-XX device id used by the gate)."""

    def __init__(self, by_scale: dict[str, dict] | None = None,
                 legacy: dict | None = None):
        self._by_scale = by_scale or {}
        self._legacy = legacy

    def is_active_for(self, device_id, scale_id):
        if not device_id or not scale_id:
            return None
        return self._by_scale.get(str(scale_id))

    def snapshot(self):
        return self._legacy


def test_gate_per_scale_match_returns_suppress(tmp_path):
    """The fix in action: per-scale match → gate fires."""
    conn = init_db(":memory:")
    snap = {
        "session_id": "sess-A", "device_id": "cloud-uuid-A", "scale_id": "scale-01",
        "state": "waiting_barcode", "created_at": _now_iso(),
    }
    poller = _StubPollerExact(by_scale={"scale-01": snap})
    handler = _make_handler(conn, tmp_path, poller=poller)

    suppress, sid, state = handler._is_wizard_active_for("scale-01", "scale-01")
    assert suppress is True
    assert sid == "sess-A"
    assert state == "waiting_barcode"


def test_gate_per_scale_miss_returns_inactive_on_other_scale(tmp_path):
    """The regression assertion: wizard open against scale-01 → events
    from scale-02 are NOT suppressed. Stripping the per-scale keying
    (matching ANY active session) flips this back to True — the test
    catches that mutation."""
    conn = init_db(":memory:")
    snap = {
        "session_id": "sess-A", "device_id": "cloud-uuid-A", "scale_id": "scale-01",
        "state": "waiting_barcode", "created_at": _now_iso(),
    }
    poller = _StubPollerExact(by_scale={"scale-01": snap})
    handler = _make_handler(conn, tmp_path, poller=poller)

    suppress, sid, state = handler._is_wizard_active_for("scale-02", "scale-02")
    assert suppress is False
    assert sid is None
    assert state is None

    # And scale-03 (live_scale) also flows.
    suppress2, _, _ = handler._is_wizard_active_for("scale-03", "scale-03")
    assert suppress2 is False


def test_gate_legacy_fallback_when_scale_id_missing(tmp_path):
    """Defensive fallback: when the event source can't supply scale_id
    (corrupt payload, pre-update Pi), fall back to legacy global
    suppression with a warning. This preserves over-suppression as the
    safe drift direction."""
    conn = init_db(":memory:")
    legacy_snap = {
        "session_id": "sess-A", "device_id": "cloud-uuid-A", "scale_id": "scale-01",
        "state": "waiting_barcode", "created_at": _now_iso(),
    }
    poller = _StubPollerExact(
        by_scale={"scale-01": legacy_snap},
        legacy=legacy_snap,
    )
    handler = _make_handler(conn, tmp_path, poller=poller)

    # Both args missing → legacy path engaged.
    suppress, sid, state = handler._is_wizard_active_for(None, None)
    assert suppress is True
    assert sid == "sess-A"


def test_gate_no_poller_attached_returns_inactive(tmp_path):
    """Pre-wiring path: no poller → never suppress."""
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path, poller=None)
    suppress, _, _ = handler._is_wizard_active_for("scale-01", "scale-01")
    assert suppress is False


# ---------------------------------------------------------------------------
# Layer 3: end-to-end via handle_scale_event
# ---------------------------------------------------------------------------


def test_unrelated_scale_event_passes_through_when_other_scale_calibrating(tmp_path):
    """The headline regression test.

    Wizard open against scale-02 (catch-all). Pi receives an event from
    scale-01 (live_shelf) — completely unrelated. Pre-fix: suppressed.
    Post-fix: flows through normal pipeline, scale_events row created."""
    conn = init_db(":memory:")
    # Wizard targets scale-02.
    wizard_snap = {
        "session_id": "sess-cal", "device_id": "cloud-uuid-A", "scale_id": "scale-02",
        "state": "waiting_barcode", "created_at": _now_iso(),
    }
    poller = _StubPollerExact(
        by_scale={"scale-02": wizard_snap},
        legacy=wizard_snap,
    )
    handler = _make_handler(conn, tmp_path, poller=poller)

    # Event from scale-01 (live_shelf) carrying its own scale_id.
    resp, status = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": "scale-01",
        "scale_id": "scale-01",
        "event_seq": 1,
        "delta_g": 314.0,
        "before_weight_g": 0.0,
        "after_weight_g": 314.0,
    })

    assert status == 200
    # Most important: NOT suppressed.
    assert "suppressed" not in resp, (
        f"unrelated-scale event should NOT be suppressed; got {resp!r}"
    )
    # And the normal pipeline ran (scale_events row written).
    rows = conn.execute("SELECT COUNT(*) FROM scale_events").fetchone()[0]
    assert rows == 1


def test_targeted_scale_event_is_suppressed_when_wizard_active(tmp_path):
    """Counterpart: wizard against scale-01 → events from scale-01 ARE
    suppressed. This is the original suppression behavior, kept intact."""
    conn = init_db(":memory:")
    wizard_snap = {
        "session_id": "sess-cal", "device_id": "cloud-uuid-A", "scale_id": "scale-01",
        "state": "waiting_barcode", "created_at": _now_iso(),
    }
    poller = _StubPollerExact(
        by_scale={"scale-01": wizard_snap},
        legacy=wizard_snap,
    )
    handler = _make_handler(conn, tmp_path, poller=poller)

    resp, status = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": "scale-01",
        "scale_id": "scale-01",
        "event_seq": 1,
        "delta_g": 314.0,
        "before_weight_g": 0.0,
        "after_weight_g": 314.0,
    })

    assert status == 200
    assert resp.get("suppressed") == "livetrack_wizard_active"
    assert resp.get("scale_id") == "scale-01"
    # And NO scale_events row.
    rows = conn.execute("SELECT COUNT(*) FROM scale_events").fetchone()[0]
    assert rows == 0
