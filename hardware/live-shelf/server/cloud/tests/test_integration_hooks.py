"""Integration tests for the cloud event emission hooks.

These tests exercise the producer → outbox path end-to-end against an
in-memory SQLite DB (with the real migrations applied). They verify
that the reconciler adapter, the in-flight TTL reaper, and the public
single-item hook all enqueue correctly-shaped outbox payloads when the
emitter is enabled — and that they become complete no-ops when
``CLOUD_ENABLED=false``.

A ``FakeCloudClient`` stand-in is available for any test that wants to
drive the full worker-drain cycle, but most tests here don't need it:
the spec is "does the producer enqueue a row?" — the worker's behavior
is covered by :mod:`server.cloud.tests.test_worker`.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import threading
import uuid
from pathlib import Path
from typing import Any

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.adapters.reconciler_repo import RepoReconcilerAdapter  # noqa: E402
from server.cloud.integration import (  # noqa: E402
    CloudEventEmitter,
    PATTERN_TO_EVENT_KIND,
    null_emitter,
)
from server.reconciler.models import SessionResolution  # noqa: E402
from server.storage import init_db, repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn, ScaleEventIn  # noqa: E402


# ---------------------------------------------------------------------------
# Fakes + fixtures
# ---------------------------------------------------------------------------


class FakeCloudClient:
    """Lightweight stand-in for :class:`server.cloud.client.CloudClient`.

    Records every ``post()`` + ``get()`` call for assertions. Useful when
    a test wants to drive the full worker drain cycle; most integration
    tests here just inspect the ``cloud_outbox`` table directly.
    """

    def __init__(self) -> None:
        self.posts: list[dict[str, Any]] = []
        self.gets: list[dict[str, Any]] = []

    def post(self, path: str, body: dict) -> dict:
        self.posts.append({"path": path, "body": body})
        return {}

    def get(self, path: str, params: dict | None = None) -> dict:
        self.gets.append({"path": path, "params": params})
        return {}


@pytest.fixture
def conn() -> sqlite3.Connection:
    """Fresh in-memory DB with migrations (including ``cloud_outbox``)."""
    c = init_db(":memory:")
    try:
        yield c
    finally:
        c.close()


@pytest.fixture
def seed_product(conn) -> str:
    """Insert one product + return its product_id."""
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Fixture Yogurt",
            brand="TestCo",
            net_weight_g=170.0,
            container_type="jar",
        ),
    )
    return product.product_id


@pytest.fixture
def seed_session(conn) -> str:
    """Open a demo session and return the session_id.

    Resolutions reference their session via FK; we don't need to close
    it for the outbox-mirror path (that runs purely against the write
    path, not reconciler dispatch).
    """
    session = storage_repo.open_session(
        conn, ts="2026-04-19T14:00:00.000Z", initial_weight_g=0.0,
    )
    return session.session_id


@pytest.fixture
def seed_lot(conn, seed_product) -> str:
    """Create an on-shelf lot for ``seed_product``. Returns the lot_id."""
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=seed_product,
            status="on_shelf",
            current_weight_g=450.0,
            initial_weight_g=450.0,
            total_consumed_g=0.0,
        ),
    )
    return lot.lot_id


# ---------------------------------------------------------------------------
# Reconciler adapter hooks
# ---------------------------------------------------------------------------


class TestReconcilerAdapterEnqueues:
    """``RepoReconcilerAdapter.write_resolution`` mirrors to cloud outbox."""

    def test_use_return_consumed_enqueues_consumed_event(
        self, conn, seed_session, seed_product, seed_lot
    ):
        """The most common reconciler pattern: REMOVE+ADD round trip
        produced a consumption. Delta must be negative and signed."""
        emitter = CloudEventEmitter(conn, enabled=True)
        adapter = RepoReconcilerAdapter(
            conn, db_lock=threading.RLock(), cloud_emitter=emitter,
            scale_id="scale-01", shelf_kind="live_shelf",
        )
        res = SessionResolution(
            session_id=seed_session,
            pattern="use_return_consumed",
            lot_id=seed_lot,
            consumed_g=42.5,
            confidence=0.9,
        )
        adapter.write_resolution(res)

        rows = conn.execute(
            "SELECT payload_json FROM cloud_outbox WHERE sent_at IS NULL"
        ).fetchall()
        assert len(rows) == 1
        payload = json.loads(rows[0]["payload_json"])
        assert payload["event_kind"] == "consumed"
        assert payload["product_id"] == seed_product
        assert payload["scale_id"] == "scale-01"
        assert payload["kind"] == "live_shelf"
        assert payload["delta_g"] == pytest.approx(-42.5)
        assert "client_event_id" in payload  # auto-stamped by enqueue_event

    def test_topped_up_enqueues_refilled_event(
        self, conn, seed_session, seed_product, seed_lot
    ):
        """``topped_up`` stores consumed_g as negative (user added mass);
        cloud receives a positive delta on a ``refilled`` event."""
        emitter = CloudEventEmitter(conn, enabled=True)
        adapter = RepoReconcilerAdapter(
            conn, db_lock=threading.RLock(), cloud_emitter=emitter,
        )
        res = SessionResolution(
            session_id=seed_session,
            pattern="topped_up",
            lot_id=seed_lot,
            consumed_g=-60.0,  # negative: user added 60g
            confidence=0.8,
        )
        adapter.write_resolution(res)

        rows = conn.execute(
            "SELECT payload_json FROM cloud_outbox"
        ).fetchall()
        assert len(rows) == 1
        payload = json.loads(rows[0]["payload_json"])
        assert payload["event_kind"] == "refilled"
        assert payload["delta_g"] == pytest.approx(60.0)

    def test_new_arrival_uses_add_event_delta(
        self, conn, seed_session, seed_product, seed_lot
    ):
        """new_arrival emits an ``added`` event with the add event's
        absolute delta_g as the stock increase."""
        # Seed an ADD scale_event that the adapter will read to derive
        # the delta_g. ``record_scale_event`` stamps a fresh event_id.
        event = storage_repo.record_scale_event(
            conn,
            ScaleEventIn(
                session_id=seed_session,
                ts="2026-04-19T15:00:00.000Z",
                delta_g=175.0,
                before_weight_g=0.0,
                after_weight_g=175.0,
                direction="add",
                classification=None,
                classifier_status="classified",
            ),
        )
        emitter = CloudEventEmitter(conn, enabled=True)
        adapter = RepoReconcilerAdapter(
            conn, db_lock=threading.RLock(), cloud_emitter=emitter,
        )
        res = SessionResolution(
            session_id=seed_session,
            pattern="new_arrival",
            lot_id=seed_lot,
            confidence=0.9,
            add_event_id=event.event_id,
        )
        adapter.write_resolution(res)

        rows = conn.execute(
            "SELECT payload_json FROM cloud_outbox"
        ).fetchall()
        assert len(rows) == 1
        payload = json.loads(rows[0]["payload_json"])
        assert payload["event_kind"] == "added"
        assert payload["delta_g"] == pytest.approx(175.0)
        assert payload["occurred_at"] == "2026-04-19T15:00:00.000Z"

    def test_swap_and_unknown_resolutions_do_not_enqueue(
        self, conn, seed_session, seed_product, seed_lot
    ):
        """v2 patterns should write locally but NOT touch the outbox."""
        emitter = CloudEventEmitter(conn, enabled=True)
        adapter = RepoReconcilerAdapter(
            conn, db_lock=threading.RLock(), cloud_emitter=emitter,
        )
        for pattern in ("swap_in", "swap_out", "unknown", "no_op",
                        "relocation", "use_return_no_consumption"):
            adapter.write_resolution(
                SessionResolution(
                    session_id=seed_session,
                    pattern=pattern,
                    lot_id=seed_lot,
                )
            )
        # All six resolutions landed locally...
        local = conn.execute(
            "SELECT COUNT(*) FROM session_resolutions "
            "WHERE session_id = ?", (seed_session,),
        ).fetchone()[0]
        assert local == 6
        # ...but none made it to the outbox.
        cloud_count = conn.execute(
            "SELECT COUNT(*) FROM cloud_outbox"
        ).fetchone()[0]
        assert cloud_count == 0

    def test_consumed_or_removed_falls_back_to_remove_event_delta(
        self, conn, seed_session, seed_product, seed_lot
    ):
        """When consumed_g is None, the adapter uses |remove_event.delta_g|
        and emits it as a negative delta."""
        event = storage_repo.record_scale_event(
            conn,
            ScaleEventIn(
                session_id=seed_session,
                ts="2026-04-19T15:05:00.000Z",
                delta_g=-120.0,
                before_weight_g=500.0,
                after_weight_g=380.0,
                direction="remove",
                classification=None,
                classifier_status="classified",
            ),
        )
        emitter = CloudEventEmitter(conn, enabled=True)
        adapter = RepoReconcilerAdapter(
            conn, db_lock=threading.RLock(), cloud_emitter=emitter,
        )
        res = SessionResolution(
            session_id=seed_session,
            pattern="consumed_or_removed",
            lot_id=seed_lot,
            consumed_g=None,
            remove_event_id=event.event_id,
        )
        adapter.write_resolution(res)

        rows = conn.execute(
            "SELECT payload_json FROM cloud_outbox"
        ).fetchall()
        assert len(rows) == 1
        payload = json.loads(rows[0]["payload_json"])
        assert payload["event_kind"] == "consumed"
        assert payload["delta_g"] == pytest.approx(-120.0)


# ---------------------------------------------------------------------------
# Single-item handler hook
# ---------------------------------------------------------------------------


class TestSingleItemHook:
    """``CloudEventEmitter.emit_single_item_event`` classifies correctly."""

    def test_consumption_below_noise_is_ignored(self, conn):
        emitter = CloudEventEmitter(conn, enabled=True)
        result = emitter.emit_single_item_event(
            scale_id="scale-single",
            product_id="prod-1",
            delta_g=-1.0,
            noise_floor_g=2.0,
            refill_threshold_g=15.0,
            depleted=False,
        )
        assert result is None
        assert conn.execute(
            "SELECT COUNT(*) FROM cloud_outbox"
        ).fetchone()[0] == 0

    def test_negative_delta_enqueues_consumed(self, conn):
        emitter = CloudEventEmitter(conn, enabled=True)
        cid = emitter.emit_single_item_event(
            scale_id="scale-single",
            product_id="prod-1",
            delta_g=-50.0,
            noise_floor_g=2.0,
            refill_threshold_g=15.0,
            depleted=False,
            occurred_at="2026-04-19T16:00:00.000Z",
        )
        assert cid is not None
        row = conn.execute(
            "SELECT payload_json FROM cloud_outbox"
        ).fetchone()
        payload = json.loads(row["payload_json"])
        assert payload["event_kind"] == "consumed"
        assert payload["kind"] == "live_scale"
        assert payload["delta_g"] == pytest.approx(-50.0)
        assert payload["product_id"] == "prod-1"
        assert payload["scale_id"] == "scale-single"

    def test_large_positive_delta_enqueues_refilled(self, conn):
        emitter = CloudEventEmitter(conn, enabled=True)
        emitter.emit_single_item_event(
            scale_id="scale-single",
            product_id="prod-1",
            delta_g=200.0,
            noise_floor_g=2.0,
            refill_threshold_g=15.0,
            depleted=False,
        )
        row = conn.execute(
            "SELECT payload_json FROM cloud_outbox"
        ).fetchone()
        payload = json.loads(row["payload_json"])
        assert payload["event_kind"] == "refilled"
        assert payload["delta_g"] == pytest.approx(200.0)

    def test_refill_threshold_is_inclusive(self, conn):
        """Mutation-testing gap: ``delta_g >= abs(refill_threshold_g)``
        flipped to ``>`` silently drops the boundary event. An input
        exactly equal to the refill threshold must still enqueue a
        ``refilled`` event — otherwise the single-item classifier
        silently under-reports refills that land on the configured
        threshold.
        """
        emitter = CloudEventEmitter(conn, enabled=True)
        cid = emitter.emit_single_item_event(
            scale_id="scale-single",
            product_id="prod-1",
            delta_g=15.0,           # exactly the threshold
            noise_floor_g=2.0,
            refill_threshold_g=15.0,
            depleted=False,
        )
        assert cid is not None, (
            "delta_g == refill_threshold_g must still emit a refilled "
            "event — boundary is inclusive"
        )
        row = conn.execute(
            "SELECT payload_json FROM cloud_outbox"
        ).fetchone()
        payload = json.loads(row["payload_json"])
        assert payload["event_kind"] == "refilled"
        assert payload["delta_g"] == pytest.approx(15.0)

    def test_consumption_threshold_is_inclusive(self, conn):
        """Mutation-testing gap: ``delta_g <= -abs(noise_floor_g)``
        flipped to ``<`` silently drops the boundary consumed event.
        An input exactly equal to -noise_floor must still enqueue a
        ``consumed`` event.
        """
        emitter = CloudEventEmitter(conn, enabled=True)
        cid = emitter.emit_single_item_event(
            scale_id="scale-single",
            product_id="prod-1",
            delta_g=-2.0,           # exactly the negative noise floor
            noise_floor_g=2.0,
            refill_threshold_g=15.0,
            depleted=False,
        )
        assert cid is not None, (
            "delta_g == -noise_floor_g must still emit a consumed event "
            "— boundary is inclusive"
        )
        row = conn.execute(
            "SELECT payload_json FROM cloud_outbox"
        ).fetchone()
        payload = json.loads(row["payload_json"])
        assert payload["event_kind"] == "consumed"
        assert payload["delta_g"] == pytest.approx(-2.0)

    def test_depleted_emits_depleted_event(self, conn):
        """depleted=True routes to a ``depleted`` event with negative
        delta regardless of the input sign."""
        emitter = CloudEventEmitter(conn, enabled=True)
        emitter.emit_single_item_event(
            scale_id="scale-single",
            product_id="prod-1",
            delta_g=180.0,   # magnitude of mass that vanished
            noise_floor_g=2.0,
            refill_threshold_g=15.0,
            depleted=True,
        )
        row = conn.execute(
            "SELECT payload_json FROM cloud_outbox"
        ).fetchone()
        payload = json.loads(row["payload_json"])
        assert payload["event_kind"] == "depleted"
        assert payload["delta_g"] == pytest.approx(-180.0)


# ---------------------------------------------------------------------------
# In-flight TTL reap hook
# ---------------------------------------------------------------------------


class TestInFlightReapHook:
    """``CloudEventEmitter.emit_in_flight_reap`` emits ``consumed``."""

    def test_ttl_reap_emits_consumed_with_full_pickup_mass(self, conn):
        emitter = CloudEventEmitter(conn, enabled=True)
        cid = emitter.emit_in_flight_reap(
            scale_id="scale-01",
            product_id="prod-1",
            consumed_g=250.0,
            occurred_at="2026-04-19T17:00:00.000Z",
        )
        assert cid is not None
        row = conn.execute(
            "SELECT payload_json FROM cloud_outbox"
        ).fetchone()
        payload = json.loads(row["payload_json"])
        assert payload["event_kind"] == "consumed"
        assert payload["kind"] == "live_shelf"
        assert payload["delta_g"] == pytest.approx(-250.0)
        assert payload["occurred_at"] == "2026-04-19T17:00:00.000Z"

    def test_zero_or_negative_consumption_is_noop(self, conn):
        emitter = CloudEventEmitter(conn, enabled=True)
        assert emitter.emit_in_flight_reap(
            scale_id="scale-01", product_id="prod-1", consumed_g=0.0,
        ) is None
        assert emitter.emit_in_flight_reap(
            scale_id="scale-01", product_id="prod-1", consumed_g=-5.0,
        ) is None
        assert conn.execute(
            "SELECT COUNT(*) FROM cloud_outbox"
        ).fetchone()[0] == 0

    def test_missing_product_id_is_noop(self, conn):
        """Defensive: the reaper falls back to product_id="" when the
        lot's FK is orphaned. That must not produce a garbage cloud event."""
        emitter = CloudEventEmitter(conn, enabled=True)
        assert emitter.emit_in_flight_reap(
            scale_id="scale-01", product_id="", consumed_g=100.0,
        ) is None


# ---------------------------------------------------------------------------
# CLOUD_ENABLED=false disables every path
# ---------------------------------------------------------------------------


class TestCloudDisabledPath:
    """When the flag is off, no hook produces outbox rows."""

    def test_null_emitter_is_a_silent_noop(self, conn, seed_session, seed_lot):
        """The null emitter is a drop-in CloudEventEmitter that short-
        circuits every emit method to ``None``. Used by legacy callers +
        when CLOUD_ENABLED=false."""
        emitter = null_emitter()
        assert not emitter.enabled
        # Try every emit path.
        assert emitter.emit_reconciler_resolution(
            pattern="use_return_consumed",
            product_id="prod-1",
            scale_id="scale-01",
            kind="live_shelf",
            delta_g=-10.0,
        ) is None
        assert emitter.emit_single_item_event(
            scale_id="scale-single",
            product_id="prod-1",
            delta_g=-50.0,
            noise_floor_g=2.0,
            refill_threshold_g=15.0,
            depleted=False,
        ) is None
        assert emitter.emit_in_flight_reap(
            scale_id="scale-01",
            product_id="prod-1",
            consumed_g=100.0,
        ) is None
        assert conn.execute(
            "SELECT COUNT(*) FROM cloud_outbox"
        ).fetchone()[0] == 0

    def test_reconciler_adapter_with_null_emitter_still_writes_locally(
        self, conn, seed_session, seed_lot
    ):
        """Local session_resolutions must still land even when the cloud
        mirror is a no-op. That's the offline/disabled-mode contract."""
        adapter = RepoReconcilerAdapter(
            conn, db_lock=threading.RLock(), cloud_emitter=null_emitter(),
        )
        adapter.write_resolution(
            SessionResolution(
                session_id=seed_session,
                pattern="use_return_consumed",
                lot_id=seed_lot,
                consumed_g=42.0,
            )
        )
        local = conn.execute(
            "SELECT COUNT(*) FROM session_resolutions "
            "WHERE session_id = ?", (seed_session,),
        ).fetchone()[0]
        assert local == 1
        cloud = conn.execute(
            "SELECT COUNT(*) FROM cloud_outbox"
        ).fetchone()[0]
        assert cloud == 0


# ---------------------------------------------------------------------------
# Pattern map sanity
# ---------------------------------------------------------------------------


class TestPatternMap:
    """Document + lock down the pattern → event_kind mapping."""

    def test_every_consumption_pattern_routes_to_consumed(self):
        """Every pattern that should mutate cloud stock downward must
        map to ``consumed`` so the edge function's handler branch is
        deterministic."""
        consumption_patterns = (
            "use_return_consumed",
            "consumed_or_removed",
            "in_flight_return",
            "in_flight_replaced_new_item",
            "in_flight_ttl_expired",
        )
        for p in consumption_patterns:
            assert PATTERN_TO_EVENT_KIND[p] == "consumed"

    def test_topped_up_and_new_arrival_route_to_correct_kinds(self):
        assert PATTERN_TO_EVENT_KIND["topped_up"] == "refilled"
        assert PATTERN_TO_EVENT_KIND["new_arrival"] == "added"

    def test_v2_patterns_are_skipped(self):
        # in_flight_pickup was removed from this list in the 2026-04-22
        # Pi↔Cloud sync audit fix — see test_in_flight_pickup_emits_*.
        for p in ("swap_in", "swap_out", "relocation", "unknown",
                  "no_op", "use_return_no_consumption"):
            assert PATTERN_TO_EVENT_KIND[p] is None

    def test_in_flight_pickup_emits_as_dedicated_kind(self):
        # Bug B fix 2026-04-22: in_flight_pickup now maps to the
        # like-named cloud event_kind so stock_lots.in_flight_since gets
        # stamped without mutating qty. Before this fix the mapping was
        # None and cloud state diverged from Pi lots (chocolate-milk
        # invisible on /chef/inventory because the companion
        # consumed_or_removed row zero'd qty while Pi still tracked
        # the bottle as physically in-flight).
        assert PATTERN_TO_EVENT_KIND["in_flight_pickup"] == "in_flight_pickup"


# ---------------------------------------------------------------------------
# Pass-2 audit finding #5: _pick_occurred_at per-pattern preference
# ---------------------------------------------------------------------------


class TestPickOccurredAt:
    """``_pick_occurred_at`` chooses the event timestamp that best
    represents when the user physically acted on the item.

    The resolution lives at commit time but the consumption/restock
    happened earlier: at the REMOVE event for use-return patterns, at
    the ADD event for new_arrival/topped_up. Picking the wrong side
    files cloud analytics under the wrong wall-clock (often hours off).
    """

    def test_remove_side_patterns_prefer_remove_ts(self):
        from server.cloud.integration import (
            REMOVE_SIDE_PATTERNS,
            _pick_occurred_at,
        )
        remove_ts = "2026-04-18T12:00:00.000Z"
        add_ts = "2026-04-18T16:00:00.000Z"
        fallback = "2026-04-18T17:00:00.000Z"
        for pattern in REMOVE_SIDE_PATTERNS:
            picked = _pick_occurred_at(pattern, remove_ts, add_ts, fallback)
            assert picked == remove_ts, (
                f"pattern {pattern!r} should timestamp at the REMOVE "
                "event, not the ADD event"
            )

    def test_add_side_patterns_prefer_add_ts(self):
        from server.cloud.integration import (
            ADD_SIDE_PATTERNS,
            _pick_occurred_at,
        )
        remove_ts = "2026-04-18T12:00:00.000Z"
        add_ts = "2026-04-18T16:00:00.000Z"
        fallback = "2026-04-18T17:00:00.000Z"
        for pattern in ADD_SIDE_PATTERNS:
            picked = _pick_occurred_at(pattern, remove_ts, add_ts, fallback)
            assert picked == add_ts, (
                f"pattern {pattern!r} should timestamp at the ADD event"
            )

    def test_remove_side_falls_back_to_add_then_fallback(self):
        from server.cloud.integration import _pick_occurred_at
        # remove ts missing, add present
        assert _pick_occurred_at(
            "use_return_consumed", None, "add", "fallback",
        ) == "add"
        # both missing — fallback
        assert _pick_occurred_at(
            "use_return_consumed", None, None, "fallback",
        ) == "fallback"

    def test_add_side_falls_back_to_remove_then_fallback(self):
        from server.cloud.integration import _pick_occurred_at
        assert _pick_occurred_at(
            "new_arrival", "remove", None, "fallback",
        ) == "remove"
        assert _pick_occurred_at(
            "new_arrival", None, None, "fallback",
        ) == "fallback"

    def test_unknown_pattern_returns_fallback(self):
        from server.cloud.integration import _pick_occurred_at
        # A pattern outside both sets (e.g. 'swap_in' in v2) should
        # neither flip sides nor blow up — just pass through to the
        # fallback.
        assert _pick_occurred_at(
            "swap_in", "remove", "add", "fallback",
        ) == "fallback"

    def test_consolidated_sets_are_canonical(self):
        """Both REMOVE_SIDE_PATTERNS and ADD_SIDE_PATTERNS live in
        ``cloud.integration``. Finding #13 consolidated them — the
        adapter used to carry its own copy. Guard against drift by
        asserting the reconciler adapter imports the same instances.
        """
        from server.adapters import reconciler_repo as adapter_mod
        from server.cloud import integration as integ_mod
        assert adapter_mod.REMOVE_SIDE_PATTERNS is (
            integ_mod.REMOVE_SIDE_PATTERNS
        )
        assert adapter_mod.ADD_SIDE_PATTERNS is integ_mod.ADD_SIDE_PATTERNS

    def test_literal_pattern_remove_add_mapping(self):
        """Hard-code the pattern → side mapping.

        The other tests in this class iterate over REMOVE_SIDE_PATTERNS /
        ADD_SIDE_PATTERNS themselves — which makes them tautological: if
        the set memberships get swapped (e.g. ``consumed_or_removed``
        moved into ADD_SIDE_PATTERNS), those loops silently keep
        passing. This test instead pins the expected side per literal
        pattern string so swapping the sets breaks the build.
        """
        from server.cloud.integration import _pick_occurred_at
        remove_ts = "2026-04-18T12:00:00.000Z"
        add_ts = "2026-04-18T16:00:00.000Z"
        fallback = "2026-04-18T17:00:00.000Z"

        # REMOVE-side patterns — consumption happens at pickup
        assert _pick_occurred_at(
            "consumed_or_removed", remove_ts, add_ts, fallback,
        ) == remove_ts
        assert _pick_occurred_at(
            "use_return_consumed", remove_ts, add_ts, fallback,
        ) == remove_ts
        assert _pick_occurred_at(
            "in_flight_ttl_expired", remove_ts, add_ts, fallback,
        ) == remove_ts
        assert _pick_occurred_at(
            "in_flight_return", remove_ts, add_ts, fallback,
        ) == remove_ts
        assert _pick_occurred_at(
            "in_flight_replaced_new_item", remove_ts, add_ts, fallback,
        ) == remove_ts

        # ADD-side patterns — restock happens when item arrives
        assert _pick_occurred_at(
            "new_arrival", remove_ts, add_ts, fallback,
        ) == add_ts
        assert _pick_occurred_at(
            "topped_up", remove_ts, add_ts, fallback,
        ) == add_ts


# ---------------------------------------------------------------------------
# Pass-2 audit finding #4: Pi RTC plausibility guard on cloud emits
# ---------------------------------------------------------------------------


class TestRtcPlausibilityGuard:
    """Events with pre-NTP timestamps (year < 2024) must never land in
    the outbox. The cloud's validator rejects them, and since 422 is
    retryable per finding #8, they'd stall forever."""

    def test_pre_ntp_remove_side_resolution_is_dropped(self, conn):
        emitter = CloudEventEmitter(conn, enabled=True)
        # Simulate a resolution whose remove_event ts has rolled back
        # to 1970 — Pi rebooted before NTP completed, RTC was cleared.
        cid = emitter.emit_reconciler_resolution(
            pattern="use_return_consumed",
            product_id="p-1",
            scale_id="scale-01",
            kind="live_shelf",
            delta_g=-100.0,
            occurred_at="1970-01-01T00:00:05.000Z",
        )
        assert cid is None
        outbox_count = conn.execute(
            "SELECT COUNT(*) AS c FROM cloud_outbox"
        ).fetchone()["c"]
        assert outbox_count == 0

    def test_post_ntp_resolution_is_enqueued(self, conn):
        emitter = CloudEventEmitter(conn, enabled=True)
        cid = emitter.emit_reconciler_resolution(
            pattern="use_return_consumed",
            product_id="p-1",
            scale_id="scale-01",
            kind="live_shelf",
            delta_g=-100.0,
            occurred_at="2026-04-18T12:00:00.000Z",
        )
        assert cid is not None
        outbox_count = conn.execute(
            "SELECT COUNT(*) AS c FROM cloud_outbox"
        ).fetchone()["c"]
        assert outbox_count == 1

    def test_boundary_year_2024_is_plausible(self, conn):
        """2024-01-01 is the first plausible year (guard uses strict <)."""
        emitter = CloudEventEmitter(conn, enabled=True)
        cid = emitter.emit_reconciler_resolution(
            pattern="new_arrival",
            product_id="p-1",
            scale_id="scale-01",
            kind="live_shelf",
            delta_g=100.0,
            occurred_at="2024-01-01T00:00:00.000Z",
        )
        assert cid is not None

    def test_pre_ntp_single_item_event_is_dropped(self, conn):
        emitter = CloudEventEmitter(conn, enabled=True)
        cid = emitter.emit_single_item_event(
            scale_id="scale-single",
            product_id="p-1",
            delta_g=-50.0,
            noise_floor_g=2.0,
            refill_threshold_g=20.0,
            depleted=False,
            occurred_at="1970-01-01T00:00:00.000Z",
        )
        assert cid is None
        assert conn.execute(
            "SELECT COUNT(*) AS c FROM cloud_outbox"
        ).fetchone()["c"] == 0

    def test_pre_ntp_in_flight_reap_is_dropped(self, conn):
        emitter = CloudEventEmitter(conn, enabled=True)
        cid = emitter.emit_in_flight_reap(
            scale_id="scale-01",
            product_id="p-1",
            consumed_g=100.0,
            occurred_at="1970-01-01T00:00:05.000Z",
        )
        assert cid is None
        assert conn.execute(
            "SELECT COUNT(*) AS c FROM cloud_outbox"
        ).fetchone()["c"] == 0


# ---------------------------------------------------------------------------
# Pass-2 audit finding #6: backfill window is configurable
# ---------------------------------------------------------------------------


class TestBackfillWindowHours:
    """``backfill_missing_outbox_events`` accepts a configurable
    ``window_hours`` so the operator can tune how far back to scan for
    orphaned resolutions. The default jumped from 24h → 168h (7d) in
    pass-2 audit finding #6.
    """

    def test_default_window_is_168_hours(self):
        """The module-level default is the 7-day value, not the old 24h."""
        from server.cloud.integration import _BACKFILL_WINDOW_HOURS
        assert _BACKFILL_WINDOW_HOURS == 168

    def test_window_is_threaded_through_to_sql(self, conn):
        """The ``window_hours`` arg must reach the SQL query as a
        negative-hour offset ``datetime('now', '-{N} hours')``. Wrap
        the connection so the test can observe the parameter tuple
        without mutating ``sqlite3.Connection``'s read-only attrs.
        """
        from server.cloud.integration import backfill_missing_outbox_events

        captured: list[Any] = []

        class _Probing:
            def __init__(self, inner):
                self._inner = inner

            def execute(self, sql: str, params: tuple = ()):
                if "session_resolutions" in sql:
                    captured.append(params)
                return self._inner.execute(sql, params)

            def __getattr__(self, name):
                return getattr(self._inner, name)

        probing = _Probing(conn)
        emitter = CloudEventEmitter(conn, enabled=True)
        backfill_missing_outbox_events(
            probing, emitter, window_hours=72,
        )
        assert captured, "expected a query against session_resolutions"
        # ``(f'-{int(window_hours)} hours',)`` — exercise the formatter.
        assert captured[0] == ("-72 hours",)

    def test_config_exposes_knob(self):
        """``AppConfig.cloud_backfill_window_hours`` mirrors the
        default — the orchestrator threads it into the helper."""
        from server.config import AppConfig, DEFAULTS
        cfg = AppConfig()
        assert cfg.cloud_backfill_window_hours == 168
        assert DEFAULTS["CLOUD_BACKFILL_WINDOW_HOURS"] == 168


class TestBackfillPatternCoverage:
    """Mutation-testing gap: the backfill scan's ``WHERE pattern IN (...)``
    clause hard-codes the list of cloud-emitting patterns. Dropping any
    one of them silently leaves orphan resolutions of that pattern
    un-backfilled on boot — the cloud permanently misses the event
    after a Pi crash between the local commit and the outbox insert.

    These tests seed one resolution per pattern via the low-level
    repo (simulating the crash window) and assert the backfill scan
    emits an outbox row. Parametrized so removing ANY pattern from the
    SQL filter fails at least one case.
    """

    @pytest.mark.parametrize("pattern,seed_direction,consumed_g,expected_kind,expected_delta", [
        ("use_return_consumed", "remove", 42.5, "consumed", -42.5),
        ("topped_up",           "add",    -60.0, "refilled", 60.0),
        ("consumed_or_removed", "remove", 120.0, "consumed", -120.0),
        ("new_arrival",         "add",    None,  "added",    175.0),
        ("in_flight_return",    "remove", 80.0,  "consumed", -80.0),
        ("in_flight_replaced_new_item", "remove", 90.0, "consumed", -90.0),
        ("in_flight_ttl_expired",       "remove", 100.0, "consumed", -100.0),
    ])
    def test_every_emitting_pattern_is_backfilled(
        self, conn, seed_session, seed_product, seed_lot,
        pattern, seed_direction, consumed_g, expected_kind, expected_delta,
    ):
        from server.cloud.integration import backfill_missing_outbox_events
        from server.storage.models import SessionResolutionIn

        # Seed the scale event the adapter needs for delta derivation
        # (new_arrival reads add delta; consumed_or_removed falls back
        # to remove delta). Use a consistent 175g add magnitude so the
        # new_arrival case has a non-zero delta_g.
        delta_g_for_event = 175.0 if seed_direction == "add" else -120.0
        event = storage_repo.record_scale_event(
            conn,
            ScaleEventIn(
                session_id=seed_session,
                ts="2026-04-19T15:00:00.000Z",
                delta_g=delta_g_for_event,
                before_weight_g=0.0,
                after_weight_g=max(0.0, delta_g_for_event),
                direction=seed_direction,
                classification=None,
                classifier_status="classified",
            ),
        )
        res_in_kwargs: dict[str, Any] = {
            "session_id": seed_session,
            "pattern": pattern,
            "lot_id": seed_lot,
        }
        if consumed_g is not None:
            res_in_kwargs["consumed_g"] = consumed_g
        if seed_direction == "add":
            res_in_kwargs["add_event_id"] = event.event_id
        else:
            res_in_kwargs["remove_event_id"] = event.event_id
        res = storage_repo.write_resolution(
            conn, SessionResolutionIn(**res_in_kwargs),
        )

        # Outbox is empty before backfill — simulates a crash between
        # the local commit and the outbox insert.
        assert conn.execute(
            "SELECT COUNT(*) FROM cloud_outbox"
        ).fetchone()[0] == 0

        emitter = CloudEventEmitter(conn, enabled=True)
        count = backfill_missing_outbox_events(
            conn, emitter, scale_id="scale-01",
            shelf_kind="live_shelf", window_hours=168,
        )

        assert count == 1, (
            f"pattern {pattern!r} must be included in the backfill "
            f"scan's WHERE filter — otherwise a crashed-commit for "
            f"this pattern silently orphans the resolution"
        )
        rows = conn.execute(
            "SELECT payload_json FROM cloud_outbox WHERE sent_at IS NULL"
        ).fetchall()
        assert len(rows) == 1
        payload = json.loads(rows[0]["payload_json"])
        assert payload.get("_pi_resolution_id") == res.resolution_id
        assert payload["event_kind"] == expected_kind
        # new_arrival uses the add event's abs delta; others use consumed_g
        if pattern == "new_arrival":
            assert payload["delta_g"] == pytest.approx(abs(delta_g_for_event))
        else:
            assert payload["delta_g"] == pytest.approx(expected_delta)


# ---------------------------------------------------------------------------
# pi_event_id pass-through — cloud event-viewer image lookup support
# ---------------------------------------------------------------------------


class TestPiEventIdPassThrough:
    """pi_event_id lands in the outbox payload verbatim so the cloud's
    shelf_event_log.pi_event_id column can be populated. The browser event
    viewer relies on that to construct LAN image URLs pointing back at the
    Pi at http://<lan_ip>:8000/event/<pi_event_id>/before.jpg.
    """

    def test_reconciler_resolution_includes_pi_event_id(self, conn):
        emitter = CloudEventEmitter(conn, enabled=True)
        cid = emitter.emit_reconciler_resolution(
            pattern="use_return_consumed",
            product_id="p-1",
            scale_id="scale-01",
            kind="live_shelf",
            delta_g=-100.0,
            occurred_at="2026-04-21T12:00:00.000Z",
            pi_event_id="evt-abc-123",
        )
        assert cid is not None
        payload = json.loads(
            conn.execute("SELECT payload_json FROM cloud_outbox").fetchone()["payload_json"]
        )
        assert payload["pi_event_id"] == "evt-abc-123"

    def test_reconciler_resolution_omits_pi_event_id_when_none(self, conn):
        emitter = CloudEventEmitter(conn, enabled=True)
        cid = emitter.emit_reconciler_resolution(
            pattern="use_return_consumed",
            product_id="p-1",
            scale_id="scale-01",
            kind="live_shelf",
            delta_g=-100.0,
            occurred_at="2026-04-21T12:00:00.000Z",
        )
        assert cid is not None
        payload = json.loads(
            conn.execute("SELECT payload_json FROM cloud_outbox").fetchone()["payload_json"]
        )
        assert "pi_event_id" not in payload

    def test_in_flight_reap_includes_pi_event_id(self, conn):
        emitter = CloudEventEmitter(conn, enabled=True)
        cid = emitter.emit_in_flight_reap(
            scale_id="scale-01",
            product_id="p-1",
            consumed_g=250.0,
            occurred_at="2026-04-21T12:00:00.000Z",
            pi_event_id="pickup-evt-xyz",
        )
        assert cid is not None
        payload = json.loads(
            conn.execute("SELECT payload_json FROM cloud_outbox").fetchone()["payload_json"]
        )
        assert payload["pi_event_id"] == "pickup-evt-xyz"

    def test_single_item_event_includes_pi_event_id(self, conn):
        emitter = CloudEventEmitter(conn, enabled=True)
        cid = emitter.emit_single_item_event(
            scale_id="scale-single",
            product_id="p-1",
            delta_g=-50.0,
            noise_floor_g=2.0,
            refill_threshold_g=15.0,
            depleted=False,
            occurred_at="2026-04-21T12:00:00.000Z",
            pi_event_id="single-evt-42",
        )
        assert cid is not None
        payload = json.loads(
            conn.execute("SELECT payload_json FROM cloud_outbox").fetchone()["payload_json"]
        )
        assert payload["pi_event_id"] == "single-evt-42"


# ---------------------------------------------------------------------------
# EMIT→HANDLE matrix meta-guard (2026-04-27)
# ---------------------------------------------------------------------------


class TestEmitHandleMatrixSync:
    """Pin the Pi-emit → cloud-handle contract so future drift fails loudly.

    Background
    ----------
    A single emitted ``event_kind`` string the cloud edge function
    doesn't know about 400's at the validator. That 400 is permanent
    (the Pi worker categorizes 4xx as non-retryable), so one orphaned
    emit path bricks every event of that kind forever. Symmetrically, a
    cloud-side ``event_kind`` branch no producer ever reaches is dead
    code rotting silently.

    The 2026-04-22 ``in_flight_pickup`` incident was the first-observed
    fallout (2 rows stuck permanent-fail until the cloud caught up).
    The 2026-04-27 discovery of the ``in_flight_return`` hole — cloud
    had a handler but no producer — was the mirror: unused handler +
    stuck in_flight marker on every return.

    These tests enforce the two-directional contract:

      1. Every non-None value in ``PATTERN_TO_EVENT_KIND`` must appear
         in the cloud's ``VALID_EVENT_KINDS`` (else the emit 400's).
      2. Every direct ``event_kind`` written by a dedicated emitter
         method (``emit_single_item_event``, ``emit_in_flight_reap``,
         ``emit_in_flight_return_marker``) must appear in
         ``VALID_EVENT_KINDS``.
      3. Every cloud-side ``VALID_EVENT_KINDS`` entry must be reachable
         via at least one Pi emit path (dead-handler guard).
    """

    # Source of truth for the cloud-side validator set. Mirrored here
    # instead of parsing supabase/functions/shelf-ingest/index.ts at
    # runtime — Deno source isn't importable into Python, and the
    # drift-check lives in test assertions rather than a runtime
    # fetch. If you edit VALID_EVENT_KINDS in the edge function, you
    # MUST mirror the change here and in the migration's CHECK list
    # below. The drift gate + the harness scenario coverage both
    # depend on this set.
    CLOUD_VALID_EVENT_KINDS = frozenset({
        "consumed",
        "added",
        "refilled",
        "depleted",
        "in_flight_pickup",
        "in_flight_return",
    })

    # Event kinds emitted by dedicated helper methods that bypass
    # PATTERN_TO_EVENT_KIND (the helpers hard-code the kind string). If
    # you add a new helper, list its kind here.
    DIRECT_EMIT_EVENT_KINDS = frozenset({
        # emit_single_item_event → one of these three based on delta sign
        "consumed",
        "refilled",
        "depleted",
        # emit_in_flight_reap → always consumed (already covered)
        # emit_in_flight_return_marker → in_flight_return
        "in_flight_return",
    })

    def test_every_pattern_map_value_is_a_valid_cloud_event_kind(self):
        """Drift guard: mutating PATTERN_TO_EVENT_KIND to introduce a
        new event_kind that isn't in the cloud validator would cause
        every event of that pattern to 400 at the edge function —
        permanently bricking the outbox row. Catch this at test time
        so it never hits production.
        """
        from server.cloud.integration import PATTERN_TO_EVENT_KIND
        for pattern, kind in PATTERN_TO_EVENT_KIND.items():
            if kind is None:
                continue
            assert kind in self.CLOUD_VALID_EVENT_KINDS, (
                f"PATTERN_TO_EVENT_KIND[{pattern!r}] = {kind!r} is NOT in "
                f"the cloud's VALID_EVENT_KINDS. The edge function will "
                f"reject every event of this kind with a 400 — bricking "
                f"the outbox row. Either add {kind!r} to "
                f"supabase/functions/shelf-ingest/index.ts + a new "
                f"handler branch in private.apply_shelf_event, or map "
                f"this pattern to an existing valid kind."
            )

    def test_direct_emit_kinds_are_valid_cloud_event_kinds(self):
        """The hard-coded event_kind strings inside emit_* methods must
        also round-trip through the cloud validator. Guard against a
        rename that forgets to update one call site."""
        for kind in self.DIRECT_EMIT_EVENT_KINDS:
            assert kind in self.CLOUD_VALID_EVENT_KINDS, (
                f"emit_* helper hard-codes event_kind={kind!r} but the "
                f"cloud's VALID_EVENT_KINDS does not accept it."
            )

    def test_every_cloud_event_kind_has_at_least_one_pi_emit_path(self):
        """Dead-handler guard: a cloud VALID_EVENT_KINDS entry that no
        Pi producer ever emits means the edge function's validator +
        the apply_shelf_event branch are unreachable code paths. The
        2026-04-27 finding was exactly this for ``in_flight_return``.

        Aggregate every kind reachable via either PATTERN_TO_EVENT_KIND
        OR the direct-emit helper set. If any cloud kind is missing,
        either the handler is dead code or the Pi is missing an emit
        path.
        """
        from server.cloud.integration import PATTERN_TO_EVENT_KIND
        pi_emitted = set()
        for k in PATTERN_TO_EVENT_KIND.values():
            if k is not None:
                pi_emitted.add(k)
        pi_emitted |= set(self.DIRECT_EMIT_EVENT_KINDS)

        missing = self.CLOUD_VALID_EVENT_KINDS - pi_emitted
        assert not missing, (
            f"cloud VALID_EVENT_KINDS contains {missing!r} but no Pi "
            f"producer path emits them. The cloud handler branch is "
            f"dead code, OR the Pi is missing an emit call site. "
            f"See the 2026-04-27 EMIT→HANDLE matrix audit — this is "
            f"exactly the class of bug that bricks features silently "
            f"(ex: stuck in_flight_since markers on every return)."
        )

    def test_in_flight_return_clear_pattern_is_mapped(self):
        """Regression test for the 2026-04-27 fix.

        Before the fix, no entry in PATTERN_TO_EVENT_KIND produced the
        ``in_flight_return`` event_kind. The synthetic pattern key
        ``in_flight_return_clear`` was added as the emit-only bridge.
        Pin the mapping so future refactors can't drop it silently.
        """
        from server.cloud.integration import PATTERN_TO_EVENT_KIND
        assert (
            PATTERN_TO_EVENT_KIND.get("in_flight_return_clear")
            == "in_flight_return"
        )

    def test_cloud_valid_event_kinds_mirror_matches_edge_function(self):
        """Smoke check that the mirrored set in this test file matches
        the real edge function source. We can't import Deno TypeScript
        at runtime, but we can scan the file as text for the
        ``VALID_EVENT_KINDS = [...]`` block and cross-check names.

        This catches the case where someone edits the edge function
        without updating this test — the whole meta-guard is worthless
        if the mirror falls out of sync.
        """
        import re
        repo_root = Path(__file__).resolve().parents[5]
        edge_fn = (
            repo_root / "supabase" / "functions" / "shelf-ingest" / "index.ts"
        )
        text = edge_fn.read_text()
        m = re.search(
            r"VALID_EVENT_KINDS\s*=\s*\[(.*?)\]\s*as\s*const",
            text, re.DOTALL,
        )
        assert m, (
            f"could not locate VALID_EVENT_KINDS in {edge_fn}; the regex "
            f"may need updating if the edge function was restructured."
        )
        # Extract every single-quoted literal inside the array.
        literals = set(re.findall(r"'([a-z_]+)'", m.group(1)))
        assert literals == self.CLOUD_VALID_EVENT_KINDS, (
            f"test mirror and edge function VALID_EVENT_KINDS drifted. "
            f"test has {self.CLOUD_VALID_EVENT_KINDS!r}; edge fn has "
            f"{literals!r}. Sync the test mirror to the edge fn."
        )
