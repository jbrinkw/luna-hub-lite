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
from server.storage.models import ProductIn  # noqa: E402


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
        ("TARE_AUTO_IMPORT",),
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
        ("TARE_AUTO_IMPORT",),
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
        ("MEASURED_FULL_AUTO",),
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
        ("MEASURED_FULL_AUTO",),
    ).fetchall()
    assert rows == []
