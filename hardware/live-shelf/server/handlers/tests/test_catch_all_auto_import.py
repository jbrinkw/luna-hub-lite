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

import json
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
        certified: bool | None = None,
    ) -> dict:
        self.product_state_calls.append(
            {
                "product_id": product_id,
                "tare_g": tare_g,
                "measured_full_at": measured_full_at,
                "certified": certified,
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


# ---------------------------------------------------------------------------
# Layer 8 (two-pass catch-all classification, 2026-05-03):
# ``meta["needs_certify"] == True`` triggers a certify auto-import push.
# ---------------------------------------------------------------------------


def test_catch_all_pushes_certified_when_needs_certify_meta_true(tmp_path):
    """Pass-2 wins (meta.needs_certify=True) → dispatch pushes certified=true.

    The two-pass classifier stamps ``meta["needs_certify"]=True`` on the
    classification result when pass-2 (uncertified-only) produced the
    match. The dispatch path reads that flag and fires a third push to
    ``CloudClient.push_product_state`` with ``certified=True``, plus a
    ``CERTIFY_AUTO_IMPORT`` lifecycle row for operator audit.

    Mutation guard: removing the certify auto-import block from
    ``_dispatch_catch_all_add`` makes the assertion on the
    ``certified=True`` push call fail.
    """
    cloud = _RecordingCloudClient()
    handler, conn = _make_handler(tmp_path, cloud_client=cloud)
    # Tare already set so the existing TARE_AUTO_IMPORT block is a no-op.
    # The MEASURED_FULL_AUTO block also won't fire because the reading is
    # well below the 5%-of-net tolerance band.
    _seed_product(conn, product_id="prod-pass2", tare=25.0, net=500.0)
    _seed_cloud_lot(conn, lot_id="LOT-PASS2", product_id="prod-pass2")

    handled = handler._dispatch_catch_all_add(
        classification={
            "item_id": "LOT-PASS2",
            "reasoning": "two-pass classifier matched against uncertified",
            "meta": {
                "catch_all_pass": 2,
                "needs_certify": True,
                "catch_all_pass1_item_id": "UNKNOWN",
                "catch_all_pass1_confidence": 0.1,
                "catch_all_pass2_item_id": "LOT-PASS2",
                "catch_all_pass2_confidence": 0.92,
            },
        },
        delta_g=275.0,  # mid-bottle — outside the measured_full window
        event_ts="2026-05-03T18:00:00.000Z",
        event_id="evt-certify-1",
        session_id="sess-certify-1",
    )
    assert handled is True

    # Exactly one certify push fired with the expected payload.
    cert_calls = [
        c for c in cloud.product_state_calls if c.get("certified") is True
    ]
    assert len(cert_calls) == 1, (
        "expected exactly one push_product_state with certified=True"
    )
    assert cert_calls[0]["product_id"] == "prod-pass2"
    # Tare and measured_full_at MUST be None — this push is exclusively
    # the certify flag (pass-2 may not have estimated tare; the existing
    # tare-set rules handle that path independently).
    assert cert_calls[0].get("tare_g") is None
    assert cert_calls[0].get("measured_full_at") is None

    # Lifecycle row: one CERTIFY_AUTO_IMPORT, payload carries the audit
    # trail so operators can correlate the cert flip with which pass-2
    # call produced it.
    rows = conn.execute(
        "SELECT actor, reason_code, payload_json "
        "FROM event_lifecycle WHERE reason_code = ?",
        (ReasonCode.CERTIFY_AUTO_IMPORT,),
    ).fetchall()
    assert len(rows) == 1
    assert rows[0][0] == "catch_all_auto_import"
    payload = json.loads(rows[0][2])
    assert payload["product_id"] == "prod-pass2"
    assert payload["catch_all_pass"] == 2
    assert payload["pass2_item_id"] == "LOT-PASS2"
    assert payload["pass2_confidence"] == pytest.approx(0.92)


def test_catch_all_does_not_push_certified_when_needs_certify_false(tmp_path):
    """Pass-1 wins (meta.needs_certify=False) → no certify push.

    When the standard pass-1 (certified-only) path matched, the product
    was ALREADY certified; pushing certified=true again would be a wasted
    round trip. Dispatch path leaves the flag untouched.
    """
    cloud = _RecordingCloudClient()
    handler, conn = _make_handler(tmp_path, cloud_client=cloud)
    _seed_product(conn, product_id="prod-pass1", tare=25.0, net=500.0)
    _seed_cloud_lot(conn, lot_id="LOT-PASS1", product_id="prod-pass1")

    handled = handler._dispatch_catch_all_add(
        classification={
            "item_id": "LOT-PASS1",
            "reasoning": "pass-1 confident hit",
            "meta": {
                "catch_all_pass": 1,
                "needs_certify": False,
                "catch_all_pass1_item_id": "LOT-PASS1",
                "catch_all_pass1_confidence": 0.95,
            },
        },
        delta_g=275.0,
        event_ts="2026-05-03T18:00:00.000Z",
        event_id="evt-certify-2",
        session_id="sess-certify-2",
    )
    assert handled is True

    cert_calls = [
        c for c in cloud.product_state_calls if c.get("certified") is True
    ]
    assert cert_calls == [], (
        "needs_certify=False MUST NOT trigger a certify push"
    )
    rows = conn.execute(
        "SELECT 1 FROM event_lifecycle WHERE reason_code = ?",
        (ReasonCode.CERTIFY_AUTO_IMPORT,),
    ).fetchall()
    assert rows == [], (
        "no CERTIFY_AUTO_IMPORT lifecycle row when pass-1 wins"
    )


def test_catch_all_does_not_push_certified_when_meta_missing(tmp_path):
    """Classification with no meta block → no certify push.

    Backwards compatibility: dispatch path tolerates the legacy
    single-pass classification shape (no meta, or meta without the
    ``needs_certify`` field) — it just skips the cert auto-import block.
    Critical for any caller that hasn't migrated to the two-pass
    orchestrator.
    """
    cloud = _RecordingCloudClient()
    handler, conn = _make_handler(tmp_path, cloud_client=cloud)
    _seed_product(conn, product_id="prod-legacy", tare=25.0, net=500.0)
    _seed_cloud_lot(conn, lot_id="LOT-LEGACY", product_id="prod-legacy")

    handled = handler._dispatch_catch_all_add(
        classification={
            "item_id": "LOT-LEGACY",
            "reasoning": "legacy single-pass classification, no meta",
        },
        delta_g=275.0,
        event_ts="2026-05-03T18:00:00.000Z",
        event_id="evt-certify-3",
        session_id="sess-certify-3",
    )
    assert handled is True

    cert_calls = [
        c for c in cloud.product_state_calls if c.get("certified") is True
    ]
    assert cert_calls == [], (
        "missing meta block MUST be treated as 'no certify request'"
    )


def test_catch_all_does_not_push_certified_when_first_emit_fails(tmp_path):
    """Audit A-CRIT-1 (2026-05-04): order of operations.

    The certify auto-import push MUST NOT fire when the FIRST measurement
    cloud emit returned None (transient cloud failure). Pre-fix, the
    certify block ran BEFORE the FIRST emit guard — a failed emit could
    leave ``certified=true`` permanently flipped on a product whose
    FIRST event was never actually applied cloud-side.

    Post-fix order: emit_catch_all_first_measurement → success guard →
    writethrough mirror → certify push. A None return from the FIRST
    emit short-circuits the whole dispatch (returns False) before
    reaching the certify block.

    Mutation guard: re-ordering the certify block before the FIRST emit
    guard would make this assertion fail — the certify push would land
    even though the FIRST emit fell through.
    """
    cloud = _RecordingCloudClient()
    handler, conn = _make_handler(tmp_path, cloud_client=cloud)
    # Force the FIRST emit to return None — simulates a transient
    # cloud failure (network timeout, 5xx, sweeper-pending response).
    handler._cloud_emitter.emit_catch_all_first_measurement = MagicMock(
        return_value=None,
    )
    # Tare already set so the existing TARE_AUTO_IMPORT block is a no-op.
    _seed_product(conn, product_id="prod-fail", tare=25.0, net=500.0)
    _seed_cloud_lot(conn, lot_id="LOT-FAIL", product_id="prod-fail")

    handled = handler._dispatch_catch_all_add(
        classification={
            "item_id": "LOT-FAIL",
            "reasoning": "cloud transient failure — needs_certify path",
            "meta": {
                "catch_all_pass": 2,
                "needs_certify": True,
                "catch_all_pass1_item_id": "UNKNOWN",
                "catch_all_pass1_confidence": 0.1,
                "catch_all_pass2_item_id": "LOT-FAIL",
                "catch_all_pass2_confidence": 0.92,
            },
        },
        delta_g=275.0,  # mid-bottle, outside the measured_full window
        event_ts="2026-05-03T18:00:00.000Z",
        event_id="evt-fail",
        session_id="sess-fail",
    )

    # Fail-closed semantics: cloud emit failure must NOT mark handled.
    assert handled is False, (
        "fail-closed: emit_catch_all_first_measurement returning None "
        "must short-circuit the dispatch (return False)"
    )

    # The certify push MUST NOT have fired — otherwise certified=true
    # would now be permanently flipped on a product whose FIRST event
    # was never applied cloud-side.
    cert_calls = [
        c for c in cloud.product_state_calls if c.get("certified") is True
    ]
    assert cert_calls == [], (
        "BUG: certified=true was pushed even though the FIRST emit "
        "failed. The certify side-effect now permanently tags a "
        "product against an event that was never actually applied."
    )

    # Lifecycle row also must NOT have fired — operator audit must not
    # show a CERTIFY_AUTO_IMPORT row for an event that never landed.
    rows = conn.execute(
        "SELECT 1 FROM event_lifecycle WHERE reason_code = ?",
        (ReasonCode.CERTIFY_AUTO_IMPORT,),
    ).fetchall()
    assert rows == [], (
        "no CERTIFY_AUTO_IMPORT lifecycle row when FIRST emit fails"
    )


def test_catch_all_defers_certified_when_tare_is_null(tmp_path):
    """Round-2 audit MED-A (2026-05-04): the certify push must NOT fire
    when ``tare_weight_g`` is still NULL on the local mirror, even with
    ``meta.needs_certify=True``.

    Allowing ``certified=true`` to land before ``tare_weight_g`` leaves a
    "certified but tare-less" cloud row, which the live-shelf classifier's
    certified-tracked filter would treat as ready for active use even
    though the LiveTrack apply path has no tare to subtract from. Defer
    until the next catch-all event after tare propagates locally.

    Mutation guard: dropping the ``current_tare is None`` gate in
    ``_dispatch_catch_all_add`` makes this test fail.
    """
    cloud = _RecordingCloudClient()
    handler, conn = _make_handler(tmp_path, cloud_client=cloud)
    # Tare deliberately NULL — the product is in inventory but never
    # had its tare measured. Pass-2 confidently picked it; the certify
    # push should DEFER until tare lands.
    _seed_product(
        conn, product_id="prod-no-tare", tare=None, net=500.0,
        barcode="HRN-NO-TARE",
    )
    _seed_cloud_lot(conn, lot_id="LOT-NO-TARE", product_id="prod-no-tare")

    handled = handler._dispatch_catch_all_add(
        classification={
            "item_id": "LOT-NO-TARE",
            "reasoning": "pass-2 win on tare-less product",
            "meta": {
                "catch_all_pass": 2,
                "needs_certify": True,
                "catch_all_pass1_item_id": "UNKNOWN",
                "catch_all_pass1_confidence": 0.1,
                "catch_all_pass2_item_id": "LOT-NO-TARE",
                "catch_all_pass2_confidence": 0.94,
            },
        },
        # Reading too low to trigger the measured_full_at stamp (which
        # would also conditionally update tare via the AI estimate). The
        # tare-less branch keeps tare NULL through this dispatch.
        delta_g=275.0,
        event_ts="2026-05-04T01:00:00.000Z",
        event_id="evt-defer-cert-1",
        session_id="sess-defer-cert-1",
    )
    assert handled is True

    # No certify push fired — deferred because tare is NULL.
    cert_calls = [
        c for c in cloud.product_state_calls if c.get("certified") is True
    ]
    assert cert_calls == [], (
        "BUG: certify push fired even though tare_weight_g is NULL on the "
        "local mirror; this would leave a 'certified but tare-less' "
        "cloud row that breaks live-shelf classifier readiness assumptions"
    )

    # Lifecycle: NO CERTIFY_AUTO_IMPORT row (deferred branch logs at INFO
    # level only — the audit row is reserved for the actual flip).
    rows = conn.execute(
        "SELECT actor, reason_code "
        "FROM event_lifecycle WHERE reason_code = ?",
        (ReasonCode.CERTIFY_AUTO_IMPORT,),
    ).fetchall()
    assert rows == [], (
        "no CERTIFY_AUTO_IMPORT lifecycle row when certify is deferred"
    )


# ---------------------------------------------------------------------------
# Layer 9 (audit C-MED-2, 2026-05-04): orchestrator-output → dispatch seam.
#
# All certify-push tests above hand-craft ``meta["needs_certify"]=True``
# on the dispatch input. None of them exercise the SEAM between the
# orchestrator's stamping (``catch_all_fallback.classify_catch_all_with_fallback``)
# and the dispatcher's reading (``_dispatch_catch_all_add``). A field-rename
# regression at that seam — e.g. the orchestrator stamping
# ``need_certify`` (typo) or the dispatcher reading
# ``catch_all_pass2_winner`` instead of ``needs_certify`` — would be
# invisible in every existing test. This block runs the REAL orchestrator
# with a fake Anthropic client scripted to UNKNOWN→pass-2-hit, converts
# the result via ``_classification_to_dict`` (the production helper at
# scale_events.py:6499), and feeds it into ``_dispatch_catch_all_add``
# unchanged.
# ---------------------------------------------------------------------------


_TINY_JPEG = bytes.fromhex(
    "FFD8FFE000104A4649460001010000480048000000FFD9"
)


class _ScriptedClassifierClient:
    """Fake Anthropic client for the catch-all orchestrator.

    Mirrors ``_FakeClient`` in ``test_catch_all_fallback.py`` — replies in
    order with pre-baked JSON strings parsed by ``parse_response``. This
    lets the REAL orchestrator run pass-1 + pass-2 without touching the
    network.
    """

    def __init__(self, responses: list[str]) -> None:
        self._responses = list(responses)
        self.calls: list[dict] = []

    def send(self, payload, *, model=None):
        from server.classifier.anthropic_client import ClassifierCallResult

        self.calls.append({"payload": payload, "model": model})
        if not self._responses:
            raise AssertionError(
                "ScriptedClassifierClient: out of scripted responses"
            )
        nxt = self._responses.pop(0)
        return ClassifierCallResult(
            text=nxt,
            model=model or "claude-sonnet-4-6",
            usage={"input_tokens": 100, "output_tokens": 20},
            raw=None,
        )


class _OrchestratorCandidateSource:
    """CandidateSource wired with the catch-all-specific lot getters.

    ``_NullCandidateSource`` (used by the rest of this file) returns
    empty lists for every method, which is fine for tests that hand-feed
    classifications. For the orchestrator-driven seam test we actually
    need a populated pass-2 pool so the orchestrator can pick a lot.
    """

    def __init__(
        self,
        *,
        in_flight=None,
        certified=None,
        uncertified=None,
    ):
        self._in_flight = list(in_flight or ())
        self._certified = list(certified or ())
        self._uncertified = list(uncertified or ())

    # Live-shelf surface — never used here.
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []

    # Catch-all surface — consulted by the orchestrator pass-1/pass-2.
    def get_catch_all_in_flight_lots(self):
        return list(self._in_flight)

    def get_catch_all_certified_user_inventory_lots(self):
        return list(self._certified)

    def get_catch_all_uncertified_user_inventory_lots(self):
        return list(self._uncertified)


def test_catch_all_dispatch_reads_orchestrator_stamped_meta(tmp_path):
    """End-to-end seam: REAL orchestrator output → ``_classification_to_dict`` →
    ``_dispatch_catch_all_add`` → certify push fires.

    Pins the field names that flow between the orchestrator (which
    stamps ``meta["needs_certify"]=True`` on a pass-2 win) and the
    dispatch reader (which gates the certify auto-import on the same
    field). Existing tests build the meta dict by hand on the dispatch
    input — they would silently pass even if the orchestrator started
    stamping ``need_certify`` (typo) or the dispatcher started reading
    ``catch_all_pass2_winner``. This test fails immediately on either
    rename.

    Mutation guards:
      * Renaming ``meta["needs_certify"]`` in
        ``catch_all_fallback._stamp_meta`` (or the dispatch reader's
        key lookup) → ``cert_calls`` is empty.
      * Dropping ``_classification_to_dict``'s ``meta`` passthrough
        (e.g. its scrubber starts dropping non-``raw_response`` keys)
        → certify never fires because the dispatcher never sees the flag.
      * Renaming ``catch_all_pass2_*`` audit fields on either side →
        the lifecycle row payload becomes empty / mis-keyed and the
        payload assertions fail.
    """
    from server.classifier.candidate_pool import UNKNOWN_SENTINEL  # noqa: F401
    from server.classifier.catch_all_fallback import (
        classify_catch_all_with_fallback,
    )
    from server.classifier.models import (
        ClassifierContext, LotCandidate, ScaleEvent,
    )
    from server.handlers.scale_events import _classification_to_dict

    # --- Test fixtures ----------------------------------------------------
    cloud = _RecordingCloudClient()
    handler, conn = _make_handler(tmp_path, cloud_client=cloud)
    # Tare ALREADY set so the certify-defer-on-null-tare gate (round-2
    # audit MED-A) doesn't intercept us. The seam under test is meta
    # passthrough; we deliberately bypass the tare-deferral path.
    _seed_product(
        conn, product_id="prod-uncert", tare=25.0, net=500.0,
        barcode="HRN-UNCERT",
    )
    _seed_cloud_lot(conn, lot_id="LOT-UNCERT", product_id="prod-uncert")

    # Frames the prompt builder reads via PIL (catch-all is single-frame
    # by design; we only need a real after-frame).
    after_path = tmp_path / "after.jpg"
    after_path.write_bytes(_TINY_JPEG)
    before_path = tmp_path / "before.jpg"
    before_path.write_bytes(_TINY_JPEG)

    # Real orchestrator inputs: a pass-1 pool that's empty (no certified
    # inventory, no in-flight) so pass-1 short-circuits without an API
    # call, and a populated pass-2 pool so pass-2 can match.
    pass2_lot = LotCandidate(
        lot_id="LOT-UNCERT",
        product_id="prod-uncert",
        name="Uncertified Item",
        brand=None,
        expected_weight_g=600.0,
        container_type="bottle",
        status="out",
        reference_image_paths=(),
    )

    # Script the model: pass-1 won't be called (empty pool short-circuits);
    # pass-2 returns a high-confidence in-pool match.
    client = _ScriptedClassifierClient(
        [
            json.dumps(
                {
                    "item_id": "LOT-UNCERT",
                    "action": "added",
                    "confidence": 0.94,
                    "reasoning": "matches the bottle visual",
                }
            ),
        ]
    )

    source = _OrchestratorCandidateSource(uncertified=[pass2_lot])
    ctx = ClassifierContext(
        source=source,
        anthropic_client=client,
        shelf_id="catch_all",
    )
    event = ScaleEvent(
        event_id="evt-seam-1",
        session_id="sess-seam-1",
        ts="2026-05-04T18:00:00.000Z",
        delta_g=275.0,
        before_weight_g=0.0,
        after_weight_g=275.0,
        direction="add",
        before_frame_path=str(before_path),
        after_frame_path=str(after_path),
    )

    # --- Run the REAL orchestrator ---------------------------------------
    result = classify_catch_all_with_fallback(event, ctx)

    # Orchestrator sanity: pass-2 won, needs_certify stamped True.
    assert result.item_id == "LOT-UNCERT"
    assert result.meta.get("needs_certify") is True, (
        "orchestrator must stamp needs_certify=True on a pass-2 win — "
        "this is the field the dispatcher reads"
    )
    assert result.meta.get("catch_all_pass") == 2

    # --- Convert via the production helper -------------------------------
    classification_dict = _classification_to_dict(result)
    # The seam contract: meta carries through asdict() unchanged.
    assert classification_dict["meta"].get("needs_certify") is True, (
        "_classification_to_dict must passthrough meta['needs_certify'] "
        "— the scrubber only drops 'raw_response', no other keys"
    )
    assert classification_dict["meta"].get("catch_all_pass") == 2
    assert classification_dict["meta"].get("catch_all_pass2_item_id") == (
        "LOT-UNCERT"
    )

    # --- Feed the orchestrator dict into the dispatch unchanged ----------
    handled = handler._dispatch_catch_all_add(
        classification=classification_dict,
        delta_g=275.0,  # mid-bottle — outside the measured_full window
        event_ts="2026-05-04T18:00:00.000Z",
        event_id="evt-seam-1",
        session_id="sess-seam-1",
    )
    assert handled is True

    # --- Pin the seam ----------------------------------------------------
    cert_calls = [
        c for c in cloud.product_state_calls if c.get("certified") is True
    ]
    assert len(cert_calls) == 1, (
        "SEAM BUG: orchestrator stamped meta.needs_certify=True but the "
        "dispatcher did not fire the certify push. The field name on one "
        "side has drifted from the other. Inspect:\n"
        "  catch_all_fallback._stamp_meta — key it stamps\n"
        "  scale_events._dispatch_catch_all_add — key it reads"
    )
    assert cert_calls[0]["product_id"] == "prod-uncert"

    # The lifecycle audit row carries pass-2 telemetry pulled from the
    # orchestrator's meta. A renamed audit key (``catch_all_pass2_item_id``
    # → ``pass2_item_id`` on the orchestrator side) would zero this out.
    rows = conn.execute(
        "SELECT payload_json FROM event_lifecycle WHERE reason_code = ?",
        (ReasonCode.CERTIFY_AUTO_IMPORT,),
    ).fetchall()
    assert len(rows) == 1
    payload = json.loads(rows[0][0])
    assert payload["pass2_item_id"] == "LOT-UNCERT", (
        "lifecycle pass2_item_id must round-trip from "
        "meta['catch_all_pass2_item_id'] — a rename on either side "
        "breaks the audit trail"
    )
    assert payload["pass2_confidence"] == pytest.approx(0.94)
