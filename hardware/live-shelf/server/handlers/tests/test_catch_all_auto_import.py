"""Catch-all auto-import: AI-estimated tare write in the dispatch path.

CATCH_ALL_TARE_CAPTURE_PLAN.md Task 8 (2026-05-02). When the catch-all
classifier picks a product whose ``products.tare_weight_g`` is currently
NULL, the AI may also return an ``estimated_tare_g`` (Task 5 prompt /
Task 7 parser). The dispatch path must:

  1. Detect tare==NULL on the picked product before any cloud emit.
  2. Validate the estimate (>0 AND < scale_reading - 1g).
  3. Push the estimate to cloud via the new
     ``CloudClient.push_product_state`` route (set-once enforced
     server-side at /shelf-ingest/product-tare).
  4. Log a ``TARE_AUTO_IMPORT`` lifecycle event for operator audit.
  5. Skip the push when the product already has a non-NULL tare
     (set-once: the AI's guess never refines a calibrated value).

The push is fire-and-forget — best-effort; cloud is the source of truth
on the actual write but server-side set-once protects existing values.

Mutation guard: removing the auto-import block from
``_dispatch_catch_all_add`` makes the assertions on the cloud client's
``push_product_state`` calls fail.
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

from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.shelves import DEFAULT_REGISTRY  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.lifecycle import ReasonCode  # noqa: E402
from server.storage.models import LotIn, ProductIn  # noqa: E402


class _NullCandidateSource:
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


class _RecordingCloudClient:
    """Stub CloudClient capturing tare-push calls.

    Mirrors the pattern from ``server/tests/test_tare_capture.py``. We
    care about both the legacy ``post_product_tare`` (still used by the
    ARM-driven capture path) and the new ``push_product_state`` (used by
    the catch-all auto-import block + future ``measured_full_at`` pushes
    in Tasks 9 and 10).
    """

    def __init__(self) -> None:
        self.tare_calls: list[dict] = []
        self.product_state_calls: list[dict] = []

    def post_product_tare(self, *, product_id: str, tare_g: float) -> dict:
        self.tare_calls.append({"product_id": product_id, "tare_g": tare_g})
        return {"ok": True}

    def push_product_state(
        self,
        *,
        product_id: str,
        tare_g: float | None = None,
        measured_full_at: str | None = None,
    ) -> dict:
        self.product_state_calls.append(
            {
                "product_id": product_id,
                "tare_g": tare_g,
                "measured_full_at": measured_full_at,
            }
        )
        return {"ok": True}


def _make_handler(tmp_path: Path, *, cloud_client=None):
    conn = init_db(str(tmp_path / "pi.sqlite3"))
    cloud_emitter = MagicMock()
    cloud_emitter.emit_catch_all_first_measurement = MagicMock(
        return_value="cli-1"
    )
    cloud_emitter.emit_catch_all_second_measurement = MagicMock(
        return_value="cli-2"
    )
    cloud_emitter.emit_manual_discard = MagicMock(return_value="cli-d")
    handler = ScaleHandler(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=tmp_path / "events",
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
        catch_all_enabled=True,
        shelf_registry_override=dict(DEFAULT_REGISTRY),
        cloud_emitter=cloud_emitter,
        cloud_client=cloud_client,
    )
    return handler, conn


def _seed_product(
    conn,
    *,
    product_id: str,
    tare: float | None,
    net: float = 500.0,
    barcode: str = "HRN-1",
):
    """Seed a product with optional null tare (the auto-import target).

    ``tare=None`` mirrors the post-Task-2 cloud state where measured_full_at
    is NULL and the AI is now responsible for proposing a value.
    """
    storage_repo.create_product(
        conn,
        ProductIn(
            barcode=barcode,
            name="Test Item",
            net_weight_g=net,
            gross_weight_g=(net + tare) if tare is not None else net,
            tare_weight_g=tare,
            unit_type="liquid",
            container_type="bottle",
            certified=1 if tare is not None else 0,
        ),
    )
    with conn:
        conn.execute(
            "UPDATE products SET product_id = ? WHERE barcode = ?",
            (product_id, barcode),
        )


def _seed_cloud_lot(
    conn,
    *,
    lot_id: str,
    product_id: str,
    qty: float = 0.5,
    in_flight_kind: str | None = None,
    pickup_event_id: str | None = None,
):
    with conn:
        conn.execute(
            """
            INSERT INTO cloud_lots (
                lot_id, product_id, qty_containers,
                in_flight_kind, pickup_event_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                lot_id, product_id, qty,
                in_flight_kind, pickup_event_id,
                "2026-05-02T00:00:00Z", "2026-05-02T00:00:00Z",
            ),
        )


# ---------------------------------------------------------------------------
# Layer 1: writes tare when product.tare_weight_g IS NULL + estimate is sane
# ---------------------------------------------------------------------------


def test_catch_all_auto_import_writes_tare_when_null(tmp_path):
    """Catch-all picks a product with tare_weight_g IS NULL and the
    classification carries ``estimated_tare_g``. The dispatch path
    pushes the estimate to ``CloudClient.push_product_state`` AND logs
    a TARE_AUTO_IMPORT lifecycle event.
    """
    cloud = _RecordingCloudClient()
    handler, conn = _make_handler(tmp_path, cloud_client=cloud)
    _seed_product(conn, product_id="prod-null", tare=None, net=500.0)
    _seed_cloud_lot(conn, lot_id="LOT-NULL", product_id="prod-null")

    handled = handler._dispatch_catch_all_add(
        classification={
            "item_id": "LOT-NULL",
            "estimated_tare_g": 42.5,
            "reasoning": "matches mason jar visual class",
        },
        delta_g=480.0,
        event_ts="2026-05-02T18:00:00.000Z",
        event_id="evt-auto-1",
        session_id="sess-auto-1",
    )

    # Dispatch handled this as a normal FIRST measurement.
    assert handled is True
    # Auto-import push fired with the right payload.
    assert len(cloud.product_state_calls) == 1, (
        "expected exactly one push_product_state call from auto-import"
    )
    call = cloud.product_state_calls[0]
    assert call["product_id"] == "prod-null"
    assert call["tare_g"] == pytest.approx(42.5)
    assert call["measured_full_at"] is None, (
        "Task 8 only pushes tare_g; measured_full_at lands in Tasks 9 + 10"
    )

    # Lifecycle row exists for the auto-import.
    rows = conn.execute(
        "SELECT actor, reason_code, payload_json "
        "FROM event_lifecycle WHERE reason_code = ?",
        (ReasonCode.TARE_AUTO_IMPORT,),
    ).fetchall()
    assert len(rows) == 1, (
        "auto-import must emit a single TARE_AUTO_IMPORT lifecycle row"
    )
    assert rows[0][0] == "catch_all_auto_import"
    # Payload carries the picked product + the estimate so operators can
    # audit retroactively which AI guesses landed in the cloud row.
    import json as _json
    payload = _json.loads(rows[0][2])
    assert payload["product_id"] == "prod-null"
    assert payload["tare_g"] == pytest.approx(42.5)
    assert payload["scale_reading_g"] == pytest.approx(480.0)


# ---------------------------------------------------------------------------
# Layer 2: set-once — never overwrite a calibrated tare
# ---------------------------------------------------------------------------


def test_catch_all_auto_import_skips_tare_write_when_already_set(tmp_path):
    """Set-once: when ``products.tare_weight_g IS NOT NULL`` the dispatch
    path does NOT push tare even if the model returned an estimate.
    Mirrors the cloud-side set-once guard (Task 2) at the Pi to avoid
    a redundant round trip.
    """
    cloud = _RecordingCloudClient()
    handler, conn = _make_handler(tmp_path, cloud_client=cloud)
    _seed_product(conn, product_id="prod-set", tare=25.0, net=500.0)
    _seed_cloud_lot(conn, lot_id="LOT-SET", product_id="prod-set")

    handled = handler._dispatch_catch_all_add(
        classification={
            "item_id": "LOT-SET",
            "estimated_tare_g": 99.0,  # ignored — tare already set
            "reasoning": "user has already calibrated this product",
        },
        delta_g=505.0,
        event_ts="2026-05-02T18:00:00.000Z",
        event_id="evt-auto-2",
        session_id="sess-auto-2",
    )
    assert handled is True

    # Set-once at the Pi: no TARE-carrying push when tare is already
    # set. The Task 9 block (measured_full stamp) may still fire on the
    # same dispatch since the placement happens to look full — that's a
    # separate concern; this test is exclusively scoped to the Task 8
    # tare path.
    tare_pushes = [
        c for c in cloud.product_state_calls if c.get("tare_g") is not None
    ]
    assert tare_pushes == [], (
        "set-once: must not re-push tare when products.tare_weight_g "
        "is already non-NULL"
    )
    rows = conn.execute(
        "SELECT 1 FROM event_lifecycle WHERE reason_code = ?",
        (ReasonCode.TARE_AUTO_IMPORT,),
    ).fetchall()
    assert rows == [], (
        "set-once: no TARE_AUTO_IMPORT lifecycle row when tare already set"
    )


# ---------------------------------------------------------------------------
# Layer 3: implausible-tare guard — estimate must be < scale_reading - 1g
# ---------------------------------------------------------------------------


def test_catch_all_auto_import_skips_when_estimate_exceeds_scale_reading(tmp_path):
    """Defense in depth: if the estimate >= scale_reading - 1g the math
    is impossible (tare can't equal the gross weight). Skip the push to
    avoid corrupting cloud with a clearly-wrong value, even though
    Task 6 instructs the model not to emit such values.
    """
    cloud = _RecordingCloudClient()
    handler, conn = _make_handler(tmp_path, cloud_client=cloud)
    _seed_product(conn, product_id="prod-implausible", tare=None, net=500.0)
    _seed_cloud_lot(
        conn, lot_id="LOT-IMPL", product_id="prod-implausible",
    )

    handled = handler._dispatch_catch_all_add(
        classification={
            "item_id": "LOT-IMPL",
            "estimated_tare_g": 480.0,  # >= 480g scale reading minus 1g
            "reasoning": "impossible value — should be ignored",
        },
        delta_g=480.0,
        event_ts="2026-05-02T18:00:00.000Z",
        event_id="evt-auto-3",
        session_id="sess-auto-3",
    )
    assert handled is True
    assert cloud.product_state_calls == [], (
        "implausible tare estimate must NOT be pushed"
    )


# ---------------------------------------------------------------------------
# Layer 4: missing estimate — silent skip (no push, no row)
# ---------------------------------------------------------------------------


def test_catch_all_auto_import_skips_when_no_estimate(tmp_path):
    """When ``estimated_tare_g`` is absent (or None) we just skip — no
    push, no lifecycle row. Covers the common case where the picked
    candidate already had ``needs_tare_estimate=False`` in the prompt.
    """
    cloud = _RecordingCloudClient()
    handler, conn = _make_handler(tmp_path, cloud_client=cloud)
    _seed_product(conn, product_id="prod-noest", tare=None, net=500.0)
    _seed_cloud_lot(conn, lot_id="LOT-NOEST", product_id="prod-noest")

    handled = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-NOEST"},
        delta_g=480.0,
        event_ts="2026-05-02T18:00:00.000Z",
        event_id="evt-auto-4",
        session_id="sess-auto-4",
    )
    assert handled is True
    assert cloud.product_state_calls == []


# ---------------------------------------------------------------------------
# Layer 5 (Task 9): measured_full_at stamp — fires when scale reading ≈
# tare + net (within 5% of net) and the cloud product has no
# measured_full_at yet. Set-once at the cloud layer; the Pi only ever
# reads its local product row to gate the push.
# ---------------------------------------------------------------------------


def test_catch_all_stamps_measured_full_when_reading_near_full(tmp_path):
    """Catch-all picks a fresh, full container: scale reading ≈ tare + net.
    Dispatch path issues a second ``push_product_state`` call carrying
    ``measured_full_at`` and emits a ``MEASURED_FULL_AUTO`` lifecycle row.

    Tolerance: 5% of net_weight_g. With tare=25g and net=500g the
    expected full reading is 525g; tolerance is 25g. A 521g reading
    (4g below expected) is well inside the window.
    """
    cloud = _RecordingCloudClient()
    handler, conn = _make_handler(tmp_path, cloud_client=cloud)
    # Tare already set — Task 8's tare-write block is a no-op so the
    # only push that fires comes from the Task 9 measured_full block.
    _seed_product(conn, product_id="prod-fresh", tare=25.0, net=500.0)
    _seed_cloud_lot(conn, lot_id="LOT-FRESH", product_id="prod-fresh")

    handled = handler._dispatch_catch_all_add(
        classification={
            "item_id": "LOT-FRESH",
            "reasoning": "fresh full bottle, recently picked up",
        },
        delta_g=521.0,  # |521 - 525| = 4g ≤ 25g tolerance
        event_ts="2026-05-02T18:00:00.000Z",
        event_id="evt-auto-5",
        session_id="sess-auto-5",
    )
    assert handled is True

    # Exactly one push, carrying measured_full_at (and no tare_g — Task 8
    # block was skipped because tare was already calibrated).
    full_calls = [
        c for c in cloud.product_state_calls
        if c.get("measured_full_at") is not None
    ]
    assert len(full_calls) == 1, (
        "expected exactly one push_product_state carrying measured_full_at"
    )
    assert full_calls[0]["product_id"] == "prod-fresh"
    assert full_calls[0]["tare_g"] is None, (
        "Task 9 stamp must not refine tare; tare is already set-once"
    )
    # ISO-8601 timestamp string, not a datetime — cloud route expects
    # JSON-friendly strings.
    assert isinstance(full_calls[0]["measured_full_at"], str)

    rows = conn.execute(
        "SELECT actor, reason_code, payload_json "
        "FROM event_lifecycle WHERE reason_code = ?",
        (ReasonCode.MEASURED_FULL_AUTO,),
    ).fetchall()
    assert len(rows) == 1
    assert rows[0][0] == "catch_all_auto_import"
    import json as _json
    payload = _json.loads(rows[0][2])
    assert payload["product_id"] == "prod-fresh"
    assert payload["scale_reading_g"] == pytest.approx(521.0)
    assert payload["expected_full_g"] == pytest.approx(525.0)
    assert payload["tolerance_g"] == pytest.approx(25.0)


def test_catch_all_does_not_stamp_when_reading_partial(tmp_path):
    """A reading mid-bottle (between tare and tare+net) MUST NOT stamp.

    With tare=25g and net=500g, expected full reading is 525g and
    tolerance is 25g. A 275g reading is 250g below expected — well
    outside the window — so no measured_full_at push is allowed. This
    is the core defense against false-positive calibration on partial
    placements.
    """
    cloud = _RecordingCloudClient()
    handler, conn = _make_handler(tmp_path, cloud_client=cloud)
    _seed_product(conn, product_id="prod-mid", tare=25.0, net=500.0)
    _seed_cloud_lot(conn, lot_id="LOT-MID", product_id="prod-mid")

    handled = handler._dispatch_catch_all_add(
        classification={
            "item_id": "LOT-MID",
            "reasoning": "half-full bottle returned to shelf",
        },
        delta_g=275.0,  # |275 - 525| = 250g  ≫ 25g tolerance
        event_ts="2026-05-02T18:00:00.000Z",
        event_id="evt-auto-6",
        session_id="sess-auto-6",
    )
    assert handled is True

    assert not any(
        c.get("measured_full_at") is not None
        for c in cloud.product_state_calls
    ), "partial-fill reading must NOT stamp measured_full_at"
    rows = conn.execute(
        "SELECT 1 FROM event_lifecycle WHERE reason_code = ?",
        (ReasonCode.MEASURED_FULL_AUTO,),
    ).fetchall()
    assert rows == []


# ---------------------------------------------------------------------------
# Layer 6 (Task 10): empty-container heuristic captures tare when null +
# placed weight reads under 30% of net_weight_g. Set-once: when tare is
# already non-NULL the legacy ≈tare path runs unchanged with NO tare push.
# ---------------------------------------------------------------------------


def _seed_local_lot(
    conn,
    *,
    product_id: str,
    shelf_id: str = "catch_all",
    status: str = "in_flight",
    placed_g: float = 600.0,
):
    """Seed a local ``lots`` row so the heuristic can be invoked directly.

    The empty-container heuristic reads ``lot.lot_id`` and ``lot.product_id``;
    nothing else on the lot matters for the null-tare branch under test.
    """
    return storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product_id,
            status=status,
            current_weight_g=placed_g,
            initial_weight_g=placed_g,
            pickup_weight_g=placed_g,
            in_flight_since=(
                "2026-05-02T18:00:00.000Z" if status == "in_flight" else None
            ),
            shelf_id=shelf_id,
        ),
    )


def test_empty_heuristic_writes_tare_when_null_and_reading_low(tmp_path):
    """When tare IS NULL and a placement reads under 30% of net_weight_g,
    treat as empty container: capture tare = scale_reading + delete lot
    + push tare to cloud (set-once at /shelf-ingest/product-tare).

    With net=500g, the 30% threshold is 150g. A 30g reading is far below
    that — clearly an empty container. Tare is captured from the reading
    itself (the placement IS the tare measurement) and pushed to cloud
    BEFORE the local lot delete so the products row keeps the tare
    even after the lot is gone.
    """
    cloud = _RecordingCloudClient()
    handler, conn = _make_handler(tmp_path, cloud_client=cloud)
    _seed_product(conn, product_id="prod-emptynull", tare=None, net=500.0)
    lot = _seed_local_lot(conn, product_id="prod-emptynull")

    fired = handler._maybe_emit_empty_container_discard(
        lot=lot,
        delta_g=30.0,  # 30g << 150g (30% of net=500g)
        event_ts="2026-05-02T18:00:00.000Z",
        event_id="evt-empty-null",
        session_id="sess-empty-null",
        confidence=0.95,
    )

    assert fired is True, (
        "null-tare branch must fire when reading is under 30% of net"
    )
    # Tare push fired with the captured value.
    tare_pushes = [
        c for c in cloud.product_state_calls if c.get("tare_g") is not None
    ]
    assert len(tare_pushes) == 1, (
        "expected exactly one push_product_state call carrying tare_g"
    )
    assert tare_pushes[0]["product_id"] == "prod-emptynull"
    assert tare_pushes[0]["tare_g"] == pytest.approx(30.0)
    # measured_full_at must NOT be on this push (this branch is empty,
    # not full).
    assert tare_pushes[0]["measured_full_at"] is None

    # Lifecycle row exists.
    rows = conn.execute(
        "SELECT actor, reason_code, payload_json "
        "FROM event_lifecycle WHERE reason_code = ?",
        (ReasonCode.TARE_AUTO_FROM_EMPTY,),
    ).fetchall()
    assert len(rows) == 1, (
        "auto-tare-on-empty must emit a single TARE_AUTO_FROM_EMPTY "
        "lifecycle row"
    )
    assert rows[0][0] == "catch_all_auto_import"
    import json as _json
    payload = _json.loads(rows[0][2])
    assert payload["product_id"] == "prod-emptynull"
    assert payload["tare_g"] == pytest.approx(30.0)
    assert payload["net_weight_g"] == pytest.approx(500.0)
    assert payload["placed_weight_g"] == pytest.approx(30.0)
    assert payload["threshold_g"] == pytest.approx(150.0)

    # Lot was deleted (matches existing empty-container semantics).
    assert storage_repo.get_lot(conn, lot.lot_id) is None, (
        "empty-container hit must DELETE the local lot row"
    )


def test_empty_heuristic_skips_tare_write_when_tare_already_set(tmp_path):
    """Set-once: tare is already calibrated → existing ≈tare path runs
    unchanged. The heuristic deletes the lot (empty observed) but MUST
    NOT refresh the existing tare even though we have a fresh reading.
    """
    cloud = _RecordingCloudClient()
    handler, conn = _make_handler(tmp_path, cloud_client=cloud)
    _seed_product(conn, product_id="prod-emptyset", tare=25.0, net=500.0)
    lot = _seed_local_lot(conn, product_id="prod-emptyset")

    # 27g sits inside the 5% window of (25 + 500) = 26.25g around tare=25g.
    fired = handler._maybe_emit_empty_container_discard(
        lot=lot,
        delta_g=27.0,
        event_ts="2026-05-02T18:00:00.000Z",
        event_id="evt-empty-set",
        session_id="sess-empty-set",
        confidence=0.95,
    )

    assert fired is True, (
        "≈tare reading on a calibrated product must still discard the lot"
    )
    # No tare push: existing tare is preserved (set-once at the Pi).
    tare_pushes = [
        c for c in cloud.product_state_calls if c.get("tare_g") is not None
    ]
    assert tare_pushes == [], (
        "set-once: must not push tare when products.tare_weight_g is "
        "already non-NULL"
    )
    rows = conn.execute(
        "SELECT 1 FROM event_lifecycle WHERE reason_code = ?",
        (ReasonCode.TARE_AUTO_FROM_EMPTY,),
    ).fetchall()
    assert rows == [], (
        "set-once: no TARE_AUTO_FROM_EMPTY row when tare already set"
    )


def test_empty_heuristic_falls_through_when_null_tare_and_reading_above_30pct(
    tmp_path,
):
    """Null tare + reading above 30% of net → DON'T fire. Half-full
    bottles read at ~50% of net so the 30% threshold protects against
    false-positive empty-detection on partial placements.
    """
    cloud = _RecordingCloudClient()
    handler, conn = _make_handler(tmp_path, cloud_client=cloud)
    _seed_product(conn, product_id="prod-emptypartial", tare=None, net=500.0)
    lot = _seed_local_lot(conn, product_id="prod-emptypartial")

    # 200g > 150g (30% of 500g) — a partially full container, NOT empty.
    fired = handler._maybe_emit_empty_container_discard(
        lot=lot,
        delta_g=200.0,
        event_ts="2026-05-02T18:00:00.000Z",
        event_id="evt-empty-partial",
        session_id="sess-empty-partial",
        confidence=0.95,
    )

    assert fired is False, (
        "null-tare branch must NOT fire when reading exceeds 30% of net"
    )
    assert cloud.product_state_calls == [], (
        "no cloud push when the heuristic falls through"
    )
    # Lot still present.
    assert storage_repo.get_lot(conn, lot.lot_id) is not None


# ---------------------------------------------------------------------------
# Layer 7 (audit M-Pi-1): measured_full_at Pi-side set-once guard
#
# scale_events.py:2515-2522 reads ``getattr(product, "measured_full_at",
# None)`` and short-circuits the second push when the local Product
# mirror reports a non-NULL value (set-once at the Pi). The catch is:
# the Pi's SQLite schema (``server/storage/schema.sql:5-35``) and the
# ``Product`` dataclass (``server/storage/models.py:147-163``) do NOT
# carry a ``measured_full_at`` column. ``_row_to_product`` never fills
# that field, so ``getattr(..., None)`` ALWAYS returns None and the
# guard is dead code on the production Pi.
#
# These tests capture both halves of that finding so a future migration
# that adds the column (and back-fills the dataclass) immediately
# starts exercising the real guard:
#
#   1. ``test_measured_full_pi_guard_is_dead_code_on_current_schema``
#      — bug-hypothesis test. Drives a scenario where the cloud has
#      already stamped the product as full; demonstrates the Pi
#      re-pushes anyway because its local mirror lacks the column.
#      Cloud-side set-once is the sole defense today.
#
#   2. ``test_measured_full_pi_guard_short_circuits_when_attribute_present``
#      — forward-compatibility test. Monkey-patches a ``measured_full_at``
#      attribute onto the Product instance returned by ``get_product`` to
#      simulate a future schema with that column. The guard at
#      scale_events.py:2519 ``not already_stamped`` then fires and the
#      Pi short-circuits — proves the guard logic itself is correct,
#      it's only the SQLite mirror that's missing.
# ---------------------------------------------------------------------------


def test_measured_full_pi_guard_is_dead_code_on_current_schema(
    tmp_path, monkeypatch,
):
    """Bug-hypothesis test (audit M-Pi-1).

    Today's Pi schema does NOT include ``products.measured_full_at`` and
    the ``Product`` dataclass has no such field. The catch-all dispatch
    path at ``scale_events.py:2515`` calls ``getattr(product,
    "measured_full_at", None)`` — which returns ``None`` regardless of
    whether the cloud has already stamped the column.

    Concretely: when the catch-all path encounters a fresh-full
    placement on a product whose CLOUD row has already been stamped
    measured_full_at (e.g. from a prior Pi reboot, or from another
    device on the same account), the Pi has no way to know. It pushes
    again. The cloud-side conditional UPDATE at /shelf-ingest/product-tare
    silently no-ops the duplicate write — no functional bug — but the
    redundant network round-trip + lifecycle row are dead-cycles the
    "Pi guard" comment claims to prevent.

    What this test asserts:
      * The Pi DOES push ``measured_full_at`` even though a hypothetical
        ``getattr(product, "measured_full_at")`` "should" guard it,
        because the dataclass doesn't carry that field.
      * A ``MEASURED_FULL_AUTO`` lifecycle row is recorded — confirming
        the supposedly-guarded code path executed.

    A future fix that adds the column to ``schema.sql`` + reads it in
    ``_row_to_product`` will need to KEEP the schema migration in lockstep
    with the dataclass. This test will start failing the moment that
    happens, signalling the migration to update.
    """
    # Pi-mirror reality: even if we manually annotate the dataclass with
    # measured_full_at = ANY value, the field doesn't exist as a column
    # so ``_row_to_product`` never populates it. We exercise the real
    # repo round-trip here (no monkeypatching) — the guard's getattr
    # falls through to its ``None`` default.
    cloud = _RecordingCloudClient()
    handler, conn = _make_handler(tmp_path, cloud_client=cloud)
    _seed_product(conn, product_id="prod-already-full", tare=25.0, net=500.0)
    _seed_cloud_lot(
        conn, lot_id="LOT-ALREADY-FULL", product_id="prod-already-full",
    )

    # Confirm the column-of-interest does NOT exist on the local
    # ``products`` table. If a future migration adds it, this assertion
    # flips — and the guard becomes reachable, so the rest of this test
    # SHOULD also flip (the test that follows asserts that future
    # behavior).
    cols = {
        row[1] for row in conn.execute("PRAGMA table_info(products)")
    }
    assert "measured_full_at" not in cols, (
        "Pi schema unexpectedly grew measured_full_at — update this "
        "test to assert the now-active set-once guard, see "
        "test_measured_full_pi_guard_short_circuits_when_attribute_present"
    )

    # Trigger the catch-all path with a fresh-full placement: scale
    # reads near tare + net so the Task 9 measured_full block fires.
    handled = handler._dispatch_catch_all_add(
        classification={
            "item_id": "LOT-ALREADY-FULL",
            "reasoning": "fresh full bottle, cloud already stamped",
        },
        delta_g=521.0,  # within 5% of expected_full=525g
        event_ts="2026-05-02T18:00:00.000Z",
        event_id="evt-dead-code",
        session_id="sess-dead-code",
    )
    assert handled is True

    # The push DID happen because the Pi guard had no local data to
    # short-circuit on. This is the dead-code finding.
    full_calls = [
        c for c in cloud.product_state_calls
        if c.get("measured_full_at") is not None
    ]
    assert len(full_calls) == 1, (
        "Pi guard cannot fire on the current schema (no measured_full_at "
        "column) — the dispatch path always reaches the push. If this "
        "assertion fails because the guard now short-circuits, ensure "
        "the schema + Product dataclass both grew the column together."
    )
    rows = conn.execute(
        "SELECT 1 FROM event_lifecycle WHERE reason_code = ?",
        (ReasonCode.MEASURED_FULL_AUTO,),
    ).fetchall()
    assert len(rows) == 1, (
        "lifecycle row also lands every time — confirming the guarded "
        "block executes unconditionally on the current Pi schema"
    )


def test_measured_full_pi_guard_short_circuits_when_attribute_present(
    tmp_path, monkeypatch,
):
    """Forward-compat / guard-logic test.

    This isolates the GUARD LOGIC at scale_events.py:2515-2522 from the
    schema-shape concern in the test above. We monkey-patch
    ``storage_repo.get_product`` to return a Product whose
    ``measured_full_at`` attribute is non-None (mimicking a future
    schema that mirrors the cloud column). The guard MUST then
    short-circuit: no measured_full_at push, no MEASURED_FULL_AUTO
    lifecycle row.

    If a future refactor accidentally drops the
    ``and not already_stamped`` clause from line 2519, this test will
    fail — even before the schema migration lands.
    """
    cloud = _RecordingCloudClient()
    handler, conn = _make_handler(tmp_path, cloud_client=cloud)
    _seed_product(conn, product_id="prod-stamped", tare=25.0, net=500.0)
    _seed_cloud_lot(conn, lot_id="LOT-STAMPED", product_id="prod-stamped")

    # Wrap the real get_product so we keep all the standard behavior
    # (column reads, _row_to_product) and then dynamically attach the
    # missing field so the dispatch path's getattr observes a non-None
    # value. We import the symbol the production code imports — i.e.
    # the one the dispatcher actually calls — so monkeypatching the
    # right binding is unambiguous.
    from server.handlers import scale_events as scale_events_mod

    real_get_product = scale_events_mod.storage_repo.get_product

    def _get_product_with_stamp(conn_arg, product_id):
        product = real_get_product(conn_arg, product_id)
        if product is not None and str(product_id) == "prod-stamped":
            # Inject the field that a future migration would back-fill
            # from the cloud-mirrored column. The dataclass is not
            # frozen, so attribute injection works.
            product.measured_full_at = "2026-05-01T18:00:00.000Z"
        return product

    monkeypatch.setattr(
        scale_events_mod.storage_repo,
        "get_product",
        _get_product_with_stamp,
    )

    handled = handler._dispatch_catch_all_add(
        classification={
            "item_id": "LOT-STAMPED",
            "reasoning": "fresh full bottle, but already stamped",
        },
        delta_g=521.0,  # within 5% of expected_full=525g
        event_ts="2026-05-02T18:00:00.000Z",
        event_id="evt-guard-fires",
        session_id="sess-guard-fires",
    )
    assert handled is True

    # Guard fires: no measured_full_at push, no lifecycle row.
    full_calls = [
        c for c in cloud.product_state_calls
        if c.get("measured_full_at") is not None
    ]
    assert full_calls == [], (
        "Pi-side set-once: when product.measured_full_at is non-None "
        "the dispatch path MUST short-circuit before push_product_state"
    )
    rows = conn.execute(
        "SELECT 1 FROM event_lifecycle WHERE reason_code = ?",
        (ReasonCode.MEASURED_FULL_AUTO,),
    ).fetchall()
    assert rows == [], (
        "no MEASURED_FULL_AUTO lifecycle row when the Pi guard fires"
    )
