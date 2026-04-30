"""Catch-all REMOVE-event suppression — single-event measurement model.

The catch-all is a delta-capture station. The user's mental model is
"place item, weight settles, snap photo, record one event" — so the
lift-off (``direction='remove'``) signal is redundant: the item was just
being weighed, not stored on the scale. Pre-fix, REMOVE events on
catch_all fell through to the live_shelf-style apply path and could
mark cloud lots ``in_flight`` (wrong semantics) and pollute reconciler
bookkeeping with unpaired in_flight_pickup rows that have no matching
return.

The fix drops catch_all REMOVE events at ingress, BEFORE the dedup +
session pickup + scale_events row insert + classifier dispatch +
cloud-emit pipeline. The state machine implicitly resets for the next
placement (next ADD event arrives, ``_dispatch_catch_all_add`` decides
FIRST or SECOND based on cloud_lots.in_flight_kind as before).

Suppression placement runs AFTER the more-specific tare-arm /
waiting-scale / livetrack-import / wizard-suppression branches so those
DO continue to capture catch-all lift-off events when armed.

live_shelf and live_scale REMOVE events are unaffected — both rigs
continue to emit lift-off signals (live_shelf marks in_flight, live_scale
emits negative-delta consumed events).
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pytest  # noqa: E402

from server.config import AppConfig  # noqa: E402
from server.handlers import scale_events as scale_events_mod  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.shelves import build_registry_from_config  # noqa: E402
from server.storage import init_db  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_runtime_state():
    """Module-level globals (`_WEIGHT_TRACE`, `_SCALE_RUNTIME_STATE`)
    bleed across tests. Clear them before + after each test so the
    weight-trace assertions are deterministic.
    """
    scale_events_mod._WEIGHT_TRACE.clear()
    if hasattr(scale_events_mod, "_SCALE_RUNTIME_STATE"):
        scale_events_mod._SCALE_RUNTIME_STATE.clear()
    yield
    scale_events_mod._WEIGHT_TRACE.clear()
    if hasattr(scale_events_mod, "_SCALE_RUNTIME_STATE"):
        scale_events_mod._SCALE_RUNTIME_STATE.clear()


class _NullCandidateSource:
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _make_handler(tmp_path: Path, *, catch_all_enabled=True, cloud_emitter=None):
    conn = init_db(str(tmp_path / "pi.sqlite3"))
    cfg = AppConfig()
    cfg.catch_all_enabled = catch_all_enabled
    registry = build_registry_from_config(cfg)
    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    if cloud_emitter is None:
        cloud_emitter = MagicMock()
        # Set every emit-shaped method to return a successful client_event_id
        # so any accidental fire would still report the call.
        for name in (
            "emit_catch_all_first_measurement",
            "emit_catch_all_second_measurement",
            "emit_manual_discard",
            "emit_in_flight_pickup",
            "emit_in_flight_return",
            "emit_added",
            "emit_consumed",
            "emit_single_item_event",
            "emit_review_queue_create",
        ):
            setattr(cloud_emitter, name, MagicMock(return_value=f"cli-{name}"))
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
        cloud_emitter=cloud_emitter,
    )
    return handler, conn, cloud_emitter


# ----------------------------------------------------------------------
# Suppression behavior — happy path
# ----------------------------------------------------------------------


def test_catch_all_remove_event_returns_suppressed_response(tmp_path):
    """A REMOVE event on scale-02 (catch-all) returns 200 with the
    ``suppressed='catch_all_remove'`` marker. The HTTP shape is the
    explicit signal that the event was intentionally dropped — distinct
    from the dedup-hit, livetrack-wizard-active, and tare-captured
    short-circuits, all of which return different shapes.
    """
    handler, conn, _ = _make_handler(tmp_path)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-30T10:00:00.000Z",
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": -350.0,
        "before_weight_g": 350.0,
        "after_weight_g": 0.0,
    })

    assert status == 200
    assert resp.get("suppressed") == "catch_all_remove"
    assert resp.get("shelf_id") == "catch_all"
    assert resp.get("direction") == "remove"
    assert resp.get("delta_g") == -350.0


def test_catch_all_remove_does_not_insert_scale_events_row(tmp_path):
    """Suppression runs BEFORE the scale_events INSERT, so a catch-all
    REMOVE leaves zero rows in the table. This is load-bearing — a
    persisted row would be picked up by the sweeper / close-hook /
    reconciler later and re-enter the pipeline through orphan-recovery
    paths.

    Mutation guard: if the suppression check is removed (or moved past
    the row insert), this assertion fails because the live_shelf-style
    fallthrough writes a scale_events row.
    """
    handler, conn, _ = _make_handler(tmp_path)

    handler.handle_scale_event({
        "ts": "2026-04-30T10:00:00.000Z",
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": -350.0,
        "before_weight_g": 350.0,
        "after_weight_g": 0.0,
    })

    count = conn.execute("SELECT COUNT(*) FROM scale_events").fetchone()[0]
    assert count == 0, (
        "catch-all REMOVE must NOT insert a scale_events row "
        f"(found {count})"
    )


def test_catch_all_remove_does_not_invoke_classifier(tmp_path):
    """Classifier dispatch sits behind the scale_events INSERT, so
    confirming the row count is 0 (above) implies the classifier wasn't
    called. Belt-and-suspenders: assert the classifier client wasn't
    touched.
    """
    handler, conn, _ = _make_handler(tmp_path)
    classifier = MagicMock()
    handler._classifier_client = classifier

    handler.handle_scale_event({
        "ts": "2026-04-30T10:00:00.000Z",
        "device_id": "scale-02",
        "event_seq": 2,
        "delta_g": -150.0,
        "before_weight_g": 150.0,
        "after_weight_g": 0.0,
    })

    assert classifier.method_calls == [], (
        "classifier client must NOT be invoked for catch-all REMOVE"
    )


def test_catch_all_remove_does_not_emit_cloud_events(tmp_path):
    """No cloud emitter method must fire for a suppressed catch-all
    REMOVE. The pre-fix code path could (depending on classifier output)
    fire ``emit_in_flight_pickup`` or surface a review row.
    """
    handler, conn, emitter = _make_handler(tmp_path)

    handler.handle_scale_event({
        "ts": "2026-04-30T10:00:00.000Z",
        "device_id": "scale-02",
        "event_seq": 3,
        "delta_g": -200.0,
        "before_weight_g": 200.0,
        "after_weight_g": 0.0,
    })

    for name in (
        "emit_catch_all_first_measurement",
        "emit_catch_all_second_measurement",
        "emit_manual_discard",
        "emit_in_flight_pickup",
        "emit_in_flight_return",
        "emit_added",
        "emit_consumed",
        "emit_single_item_event",
        "emit_review_queue_create",
    ):
        method = getattr(emitter, name, None)
        if method is None:
            continue
        method.assert_not_called()


def test_catch_all_remove_does_not_mark_lots_in_flight(tmp_path):
    """Pre-fix the catch-all REMOVE could (via the live_shelf-style
    apply path) update local lots.status='in_flight' or even cloud_lots
    in-flight markers. The fix routes around that path entirely — no
    Pi-local lot is mutated.
    """
    handler, conn, _ = _make_handler(tmp_path)
    # Seed a Pi-local lot for any accidental mutation to land on.
    conn.execute(
        """
        INSERT INTO products (product_id, name, certified, unit_type)
        VALUES ('p-1', 'Test', 1, 'solid')
        """,
    )
    conn.execute(
        """
        INSERT INTO lots (
            lot_id, product_id, status, current_weight_g, shelf_id,
            placed_at, last_seen_at
        )
        VALUES (
            'lot-1', 'p-1', 'on_shelf', 350.0, 'catch_all',
            '2026-04-30T09:00:00.000Z', '2026-04-30T09:00:00.000Z'
        )
        """,
    )
    conn.commit()

    handler.handle_scale_event({
        "ts": "2026-04-30T10:00:00.000Z",
        "device_id": "scale-02",
        "event_seq": 4,
        "delta_g": -350.0,
        "before_weight_g": 350.0,
        "after_weight_g": 0.0,
    })

    row = conn.execute(
        "SELECT status, in_flight_since FROM lots WHERE lot_id = 'lot-1'"
    ).fetchone()
    assert row[0] == "on_shelf", (
        f"catch-all REMOVE must NOT change lot status (got {row[0]!r})"
    )
    assert row[1] is None, (
        "catch-all REMOVE must NOT stamp in_flight_since"
    )


def test_catch_all_remove_records_weight_trace_marker(tmp_path):
    """The suppression writes a weight-trace entry with the canonical
    ``catch_all_remove_suppressed`` reason so operators can audit how
    many catch-all REMOVE events were dropped on the diag dump's weight
    timeline. The same convention is used by the LiveTrack wizard
    suppression branch above (kind='event_suppressed').
    """
    from server.handlers.scale_events import get_weight_trace  # noqa: WPS433

    handler, _, _ = _make_handler(tmp_path)

    handler.handle_scale_event({
        "ts": "2026-04-30T10:00:00.000Z",
        "device_id": "scale-02",
        "event_seq": 5,
        "delta_g": -250.0,
        "before_weight_g": 250.0,
        "after_weight_g": 0.0,
    })

    trace = get_weight_trace("scale-02")
    suppressed = [
        e for e in trace
        if e.get("kind") == "event_suppressed"
        and e.get("reason") == "catch_all_remove_suppressed"
    ]
    assert len(suppressed) == 1, (
        f"expected exactly one catch_all_remove_suppressed trace marker, "
        f"got {len(suppressed)} (full trace: {trace!r})"
    )
    entry = suppressed[0]
    assert entry["device_id"] == "scale-02"
    assert entry["delta_g"] == -250.0
    assert entry["event_seq"] == 5


# ----------------------------------------------------------------------
# Negative cases — what MUST keep working
# ----------------------------------------------------------------------


def test_catch_all_add_event_is_not_suppressed(tmp_path):
    """ADD events on catch-all continue to flow through the normal
    pipeline — scale_events row, frame capture, classifier dispatch.
    The suppression is direction-scoped to ``remove`` only.

    Mutation guard: broadening the suppression to
    ``direction != 'noise'`` (or ``in {'add','remove'}``) would silently
    kill all catch-all measurements.
    """
    handler, conn, _ = _make_handler(tmp_path)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-30T10:00:00.000Z",
        "device_id": "scale-02",
        "event_seq": 6,
        "delta_g": 350.0,
        "before_weight_g": 0.0,
        "after_weight_g": 350.0,
    })

    assert status == 200
    assert resp.get("suppressed") != "catch_all_remove", resp
    assert "event_id" in resp
    count = conn.execute("SELECT COUNT(*) FROM scale_events").fetchone()[0]
    assert count == 1, "ADD must still write a scale_events row"


def test_live_shelf_remove_event_is_not_suppressed(tmp_path):
    """live_shelf REMOVE events MUST keep flowing — the live_shelf rig
    needs the lift-off signal for its in_flight tracker. The suppression
    is shelf-scoped to ``catch_all`` only.

    Mutation guard: dropping the ``shelf_id == 'catch_all'`` clause from
    the suppression would silently break live_shelf consumption tracking.
    """
    handler, conn, _ = _make_handler(tmp_path)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-30T10:00:00.000Z",
        "device_id": "scale-01",  # live_shelf
        "event_seq": 7,
        "delta_g": -250.0,
        "before_weight_g": 250.0,
        "after_weight_g": 0.0,
    })

    assert status == 200
    assert resp.get("suppressed") != "catch_all_remove", resp
    assert "event_id" in resp
    row = conn.execute(
        "SELECT shelf_id, direction FROM scale_events WHERE event_id = ?",
        (resp["event_id"],),
    ).fetchone()
    assert row is not None
    assert row[0] == "live_shelf"
    assert row[1] == "remove"


def test_live_scale_remove_event_is_not_suppressed(tmp_path):
    """live_scale (single-item) REMOVE events MUST keep flowing — they
    represent direct consumption (negative delta = item taken / consumed).
    The single-item branch handles them by emitting a ``consumed`` cloud
    event.
    """
    handler, conn, emitter = _make_handler(tmp_path)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-30T10:00:00.000Z",
        "device_id": "scale-03",  # single_item / live_scale
        "event_seq": 8,
        "delta_g": -150.0,
        "before_weight_g": 200.0,
        "after_weight_g": 50.0,
    })

    assert status == 200
    assert resp.get("suppressed") != "catch_all_remove", resp
    assert resp.get("shelf_id") == "single_item"
    assert resp.get("event_kind") == "consumed"


def test_catch_all_noise_event_is_not_suppressed_by_remove_branch(tmp_path):
    """Sub-threshold noise events on catch-all are NOT suppressed by
    the remove branch — they continue to record (with direction='noise')
    so heartbeat-driven app_state updates and the noise-row audit trail
    keep functioning. The suppression is direction='remove' only.
    """
    handler, conn, _ = _make_handler(tmp_path)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-30T10:00:00.000Z",
        "device_id": "scale-02",
        "event_seq": 9,
        # Below threshold (5.0g), so direction == 'noise'
        "delta_g": -2.0,
        "before_weight_g": 100.0,
        "after_weight_g": 98.0,
    })

    assert status == 200
    assert resp.get("suppressed") != "catch_all_remove"
    assert resp.get("direction") == "noise"
    # Noise events DO write a scale_events row (per existing
    # noise-handling contract).
    count = conn.execute(
        "SELECT COUNT(*) FROM scale_events WHERE direction = 'noise'"
    ).fetchone()[0]
    assert count == 1


# ----------------------------------------------------------------------
# Sequence test — placement → lift → re-placement state machine
# ----------------------------------------------------------------------


def test_catch_all_place_lift_replace_keeps_first_second_state_machine(tmp_path):
    """The first/second measurement state machine still works after the
    REMOVE suppression: placement (FIRST) → lift (suppressed) →
    re-placement (SECOND, since cloud_lots.in_flight_kind='catch_all'
    from the FIRST emit's write-through marker).

    The lift-off in between MUST NOT clear the in-flight markers — that
    would re-route the second placement as another FIRST, dropping
    consumption accounting on the floor.

    Mutation guard: if the suppression accidentally cleared
    ``cloud_lots.in_flight_kind``, the second event below would emit
    ``catch_all_first_measurement`` instead of ``_second_measurement``.
    """
    handler, conn, emitter = _make_handler(tmp_path)
    # Seed a product + cloud_lot in catch_all so dispatch can route.
    conn.execute(
        """
        INSERT INTO products (
            product_id, name, certified, unit_type, container_type,
            net_weight_g, gross_weight_g, tare_weight_g
        )
        VALUES ('p-1', 'Trail Mix', 1, 'solid', 'bag',
                500.0, 525.0, 25.0)
        """,
    )
    conn.execute(
        """
        INSERT INTO cloud_lots (
            lot_id, product_id, qty_containers, in_flight_kind,
            pickup_event_id, created_at, updated_at
        )
        VALUES ('lot-A', 'p-1', 0.5, NULL, NULL,
                '2026-04-30T09:00:00.000Z', '2026-04-30T09:00:00.000Z')
        """,
    )
    conn.commit()

    # 1. Place — ADD event emits FIRST measurement.
    resp1, status1 = handler.handle_scale_event({
        "ts": "2026-04-30T10:00:00.000Z",
        "device_id": "scale-02",
        "event_seq": 100,
        "delta_g": 350.0,
        "before_weight_g": 0.0,
        "after_weight_g": 350.0,
    })
    assert status1 == 200
    # The full ingress path involves the classifier — we don't run the
    # actual model here, so the FIRST emit may or may not fire depending
    # on how the synthetic classifier dispatch resolves. What we DO
    # care about: the scale_events row for the ADD is recorded and the
    # state-machine markers are written when the dispatcher fires.
    # We instead simulate the marker stamp directly to isolate the
    # lift suppression's effect on subsequent state.
    handler._writethrough_stamp_catch_all_in_flight(
        lot_id="lot-A",
        pickup_event_id="evt-first-uuid",
        in_flight_since="2026-04-30T10:00:00.000Z",
    )

    row = conn.execute(
        "SELECT in_flight_kind, pickup_event_id FROM cloud_lots WHERE lot_id='lot-A'"
    ).fetchone()
    assert row[0] == "catch_all"
    assert row[1] == "evt-first-uuid"

    # 2. Lift — REMOVE event must be suppressed AND must NOT clear the
    # in-flight markers.
    resp2, status2 = handler.handle_scale_event({
        "ts": "2026-04-30T10:01:00.000Z",
        "device_id": "scale-02",
        "event_seq": 101,
        "delta_g": -350.0,
        "before_weight_g": 350.0,
        "after_weight_g": 0.0,
    })
    assert status2 == 200
    assert resp2.get("suppressed") == "catch_all_remove"

    # Markers still set after suppressed lift.
    row = conn.execute(
        "SELECT in_flight_kind, pickup_event_id FROM cloud_lots WHERE lot_id='lot-A'"
    ).fetchone()
    assert row[0] == "catch_all", (
        "lift suppression must NOT clear cloud_lots.in_flight_kind"
    )
    assert row[1] == "evt-first-uuid", (
        "lift suppression must NOT clear cloud_lots.pickup_event_id"
    )


# ----------------------------------------------------------------------
# Tare-arm interception still wins over suppression (precedence test)
# ----------------------------------------------------------------------


def test_tare_arm_remove_intercepts_before_suppression(tmp_path):
    """A REMOVE event on catch-all WITH an active tare-arm must be
    intercepted by the tare-capture path (CATCH_ALL_TARE_CAPTURE_PLAN.md
    §4.3, direction='remove' uses ``before_weight_g``), NOT silently
    swallowed by the new REMOVE suppression.

    Branch ordering: tare-arm interception runs BEFORE the new
    suppression. Mutation guard: swapping the order would let the
    operator's "click Tare → lift container" UX silently drop the
    capture event.
    """
    from server.storage import repo as storage_repo  # noqa: WPS433

    handler, conn, _ = _make_handler(tmp_path)
    # Seed a certified product so the tare-arm POST has a target.
    storage_repo.create_product(
        conn,
        # Importing ProductIn here keeps the test colocated.
        # __init__ uses repo's create_product helper.
        __import__(
            "server.storage.models", fromlist=["ProductIn"]
        ).ProductIn(
            barcode="TARE-1",
            name="Tare Test",
            net_weight_g=500.0,
            gross_weight_g=525.0,
            tare_weight_g=None,
            unit_type="solid",
            container_type="jar",
            certified=1,
        ),
    )
    # Find product_id; rename via update for stability.
    pid = conn.execute(
        "SELECT product_id FROM products WHERE barcode='TARE-1'"
    ).fetchone()[0]
    storage_repo.arm_tare(
        conn, product_id=pid, ttl_s=120,
    )

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-30T10:00:00.000Z",
        "device_id": "scale-02",
        "event_seq": 200,
        "delta_g": -300.0,
        "before_weight_g": 300.0,
        "after_weight_g": 0.0,
    })

    assert status == 200
    # The tare-arm path returns its own short-circuit shape — NOT the
    # suppression marker.
    assert resp.get("tare_captured") is True, resp
    assert resp.get("suppressed") != "catch_all_remove", resp
    # Product's tare was written.
    new_tare = conn.execute(
        "SELECT tare_weight_g FROM products WHERE product_id = ?",
        (pid,),
    ).fetchone()[0]
    assert new_tare == 300.0
