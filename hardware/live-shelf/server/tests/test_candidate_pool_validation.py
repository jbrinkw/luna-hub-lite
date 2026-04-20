"""``_apply_lot_update_from_classification`` must reject ids the
classifier returned that weren't in the candidate pool we sent.

The model is not trusted to invent lot_ids — if it hallucinates an id,
mutating a random lot (or minting a phantom one) would corrupt state.
The handler validates both ``item_id`` and every ``multi_match`` entry
against the pool; hallucinations are logged + skipped.
"""

from __future__ import annotations

import sqlite3
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn  # noqa: E402


def _make_handler(conn: sqlite3.Connection, tmp_path: Path) -> ScaleHandler:
    class _NullCandidateSource:
        def get_on_shelf_lots(self):
            return []

        def get_recently_out_lots(self, window_seconds):
            return []

        def get_certified_not_on_shelf(self):
            return []

    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    return ScaleHandler(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
    )


def test_apply_lot_update_rejects_hallucinated_item_id(tmp_path: Path):
    """item_id='not-in-pool' while candidate_pool_used only lists 'A'.
    The method must bail before mutating any lot / minting any phantom.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)

    # Seed product + lot 'A' (these are real, but the classifier's
    # item_id='not-in-pool' is hallucinated).
    product_a = storage_repo.create_product(
        conn,
        ProductIn(
            name="Prod A",
            barcode="11111",
            net_weight_g=100.0,
            gross_weight_g=100.0,
            unit_type="solid",
            container_type="tray",
            certified=1,
        ),
    )
    lot_a = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product_a.product_id,
            status="on_shelf",
            current_weight_g=100.0,
            initial_weight_g=100.0,
        ),
    )

    classification = {
        "item_id": "not-in-pool",
        "action": "removed",
        "confidence": 0.95,
        "reasoning": "hallucinated",
        "multi_match": [],
        "candidate_pool_used": [{"candidate_id": "A"}],
    }

    before_count = conn.execute("SELECT COUNT(*) FROM lots").fetchone()[0]
    handler._apply_lot_update_from_classification(
        direction="remove",
        classification=classification,
        event_ts="2026-04-15T12:00:00.000Z",
        delta_g=-100.0,
    )
    after_count = conn.execute("SELECT COUNT(*) FROM lots").fetchone()[0]

    # No new lot minted.
    assert after_count == before_count

    # Lot A was NOT mutated (still on_shelf — no REMOVE got applied).
    lot_a_now = storage_repo.get_lot(conn, lot_a.lot_id)
    assert lot_a_now is not None
    assert lot_a_now.status == "on_shelf"


def test_apply_lot_update_skips_hallucinated_multi_match(tmp_path: Path):
    """Valid item_id='A' + multi_match includes a hallucinated 'rogue'.
    Lot A should be staged in_flight (valid), rogue must be silently
    skipped (and NOT minted).

    Post IN_FLIGHT_TRACKER_PLAN: classified REMOVEs stage ``in_flight``
    instead of flipping straight to ``out``.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)

    product_a = storage_repo.create_product(
        conn,
        ProductIn(
            name="Prod A",
            barcode="22222",
            net_weight_g=100.0,
            gross_weight_g=100.0,
            unit_type="solid",
            container_type="tray",
            certified=1,
        ),
    )
    lot_a = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product_a.product_id,
            status="on_shelf",
            current_weight_g=100.0,
            initial_weight_g=100.0,
        ),
    )

    classification = {
        "item_id": lot_a.lot_id,
        "action": "removed",
        "confidence": 0.92,
        "reasoning": "primary valid, rogue hallucinated",
        "multi_match": [
            {"candidate_id": lot_a.lot_id, "confidence": 0.92},
            {"candidate_id": "rogue-lot-id", "confidence": 0.4},
        ],
        # Only A is in the pool — 'rogue-lot-id' is not.
        "candidate_pool_used": [{"candidate_id": lot_a.lot_id}],
    }

    before_lots = conn.execute("SELECT COUNT(*) FROM lots").fetchone()[0]
    handler._apply_lot_update_from_classification(
        direction="remove",
        classification=classification,
        event_ts="2026-04-15T12:00:00.000Z",
        delta_g=-100.0,
    )
    after_lots = conn.execute("SELECT COUNT(*) FROM lots").fetchone()[0]

    # No new lots minted for the rogue id.
    assert after_lots == before_lots

    # Lot A is now 'in_flight' — valid item applied via the in-flight
    # staging path (not a direct flip to 'out').
    lot_a_after = storage_repo.get_lot(conn, lot_a.lot_id)
    assert lot_a_after is not None
    assert lot_a_after.status == "in_flight"
