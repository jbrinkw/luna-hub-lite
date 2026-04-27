"""Apply-path tests for the ``inventory_only`` mint branch.

When the candidate-pool builder surfaces a product whose only inventory
is a cloud_lots row (no Pi-local lot yet), the classifier picks the
product and the apply path must:

  1. Mint a Pi-local ``lots`` row (status='on_shelf') so this shelf has
     bookkeeping for the placed item going forward.
  2. NOT mint a duplicate cloud stock_lot — the cloud-side resolver's
     step 2/3 promotes the existing cloud lot to live_shelf-tracked
     when the cloud emit lands.
  3. Refuse to mint when no cloud_lots row exists for the product
     (defense for hallucinated picks; preserves decision #45's
     "minting from a place event is forbidden" invariant for the
     no-inventory case).

These tests are the regression coverage that would have caught the
2026-04-27 silent-empty-pool bug at deploy time.
"""

from __future__ import annotations

import sqlite3
import sys
import threading
from pathlib import Path
from unittest.mock import MagicMock

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import (  # noqa: E402
    LotIn,
    ProductIn,
    ScaleEventIn,
)


class _NullCandidateSource:
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_inventory_only_products(self, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _make_handler(
    conn: sqlite3.Connection, tmp_path: Path, **kwargs
) -> ScaleHandler:
    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    defaults = dict(
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
    defaults.update(kwargs)
    return ScaleHandler(**defaults)


def _seed_product(conn, *, name="Test Product", net_weight_g=600.0):
    return storage_repo.create_product(
        conn,
        ProductIn(
            name=name,
            barcode=f"bc-{name.lower().replace(' ', '-')}",
            net_weight_g=net_weight_g,
            gross_weight_g=net_weight_g + 20,
            unit_type="solid",
            container_type="bottle",
            certified=1,
        ),
    )


def _seed_cloud_lot(
    conn, *, lot_id, product_id, qty=1.0, deleted_at=None,
):
    conn.execute(
        """
        INSERT INTO cloud_lots (
            lot_id, product_id, location_id, qty_containers,
            expires_on, in_flight_since, pickup_event_id,
            updated_at, deleted_at, synced_at
        ) VALUES (?, ?, 'loc-1', ?, NULL, NULL, NULL,
                  '2026-04-27T20:00:00+00:00', ?, datetime('now'))
        """,
        (lot_id, product_id, qty, deleted_at),
    )
    conn.commit()


def _open_session(conn):
    return storage_repo.open_session(
        conn, "2026-04-27T20:14:00.000Z", initial_weight_g=0.0,
    ).session_id


def _record_add(conn, session_id, delta_g):
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-27T20:14:22.509Z",
            delta_g=delta_g,
            before_weight_g=7.474,
            after_weight_g=7.474 + delta_g,
            direction="add",
            session_id=session_id,
            classifier_status="pending",
        ),
    )
    return ev.event_id


# ---------------------------------------------------------------------------
# Apply path: classifier picks an inventory_only product
# ---------------------------------------------------------------------------


class TestInventoryOnlyMint:
    def test_classifier_pick_mints_pi_lot_when_cloud_inventory_exists(
        self, tmp_path,
    ):
        """The user's Gatorade scenario: cloud_lots seeded, no Pi lot,
        ADD event with classifier picking the product → Pi lot created."""
        conn = init_db(":memory:")
        try:
            handler = _make_handler(conn, tmp_path)
            product = _seed_product(
                conn, name="Gatorade Frost", net_weight_g=900.0,
            )
            _seed_cloud_lot(
                conn, lot_id="cl-gat", product_id=product.product_id,
            )
            session_id = _open_session(conn)
            event_id = _record_add(conn, session_id, delta_g=663.452)

            # Pre-condition: no Pi lots for this product.
            pre_lots = storage_repo.list_lots_by_product(
                conn, product_id=product.product_id,
            )
            assert pre_lots == []

            handler._apply_lot_update_from_classification(
                direction="add",
                classification={
                    "item_id": product.product_id,
                    "action": "added",
                    "confidence": 0.85,
                    "multi_match": [],
                    "candidate_pool_used": [
                        {
                            "candidate_id": product.product_id,
                            "product_id": product.product_id,
                            "why_candidate": "inventory_only",
                        },
                    ],
                },
                event_ts="2026-04-27T20:14:22.509Z",
                delta_g=663.452,
                session_id=session_id,
                event_id=event_id,
                shelf_id="live_shelf",
            )

            # Post-condition: a Pi lot was minted on live_shelf.
            post_lots = storage_repo.list_lots_by_product(
                conn, product_id=product.product_id, shelf_id="live_shelf",
            )
            assert len(post_lots) == 1
            assert post_lots[0].status == "on_shelf"
            assert post_lots[0].current_weight_g == pytest.approx(663.452)
            assert post_lots[0].shelf_id == "live_shelf"
        finally:
            conn.close()

    def test_classifier_pick_refuses_mint_when_no_cloud_inventory(
        self, tmp_path,
    ):
        """Defense check: classifier hallucinates a product with no
        cloud_lots — the apply path must NOT mint a Pi lot.

        This preserves decision #45's "minting from a place event is
        forbidden" rule for the no-inventory case. The pool builder
        already filters; this test pins the second-line defense in
        ``_mint_pi_lot_for_inventory_only_pick``.
        """
        conn = init_db(":memory:")
        try:
            handler = _make_handler(conn, tmp_path)
            product = _seed_product(conn, name="Phantom Product")
            # NO cloud_lots row → product is NOT in inventory.
            session_id = _open_session(conn)
            event_id = _record_add(conn, session_id, delta_g=600.0)

            handler._apply_lot_update_from_classification(
                direction="add",
                classification={
                    "item_id": product.product_id,
                    "action": "added",
                    "confidence": 0.95,
                    "multi_match": [],
                    "candidate_pool_used": [
                        {
                            "candidate_id": product.product_id,
                            "product_id": product.product_id,
                            "why_candidate": "inventory_only",
                        },
                    ],
                },
                event_ts="2026-04-27T20:14:22.509Z",
                delta_g=600.0,
                session_id=session_id,
                event_id=event_id,
                shelf_id="live_shelf",
            )

            # Post-condition: NO Pi lot minted — refusing-without-cloud
            # invariant holds.
            lots = storage_repo.list_lots_by_product(
                conn, product_id=product.product_id,
            )
            assert lots == []
        finally:
            conn.close()

    def test_zero_qty_cloud_lot_blocks_mint(self, tmp_path):
        """qty_containers=0 cloud_lots row must not unlock the mint.

        Empty cloud lots represent already-consumed inventory. A
        place event must not promote them via the Pi mint path; the
        cloud-side empty-lot-reuse path handles refills via
        ``resolve_add_to_shelf_lot`` step 4.
        """
        conn = init_db(":memory:")
        try:
            handler = _make_handler(conn, tmp_path)
            product = _seed_product(conn, name="Empty Cloud Lot")
            _seed_cloud_lot(
                conn,
                lot_id="cl-empty",
                product_id=product.product_id,
                qty=0.0,
            )
            session_id = _open_session(conn)
            event_id = _record_add(conn, session_id, delta_g=300.0)

            handler._apply_lot_update_from_classification(
                direction="add",
                classification={
                    "item_id": product.product_id,
                    "action": "added",
                    "confidence": 0.9,
                    "multi_match": [],
                    "candidate_pool_used": [
                        {
                            "candidate_id": product.product_id,
                            "product_id": product.product_id,
                            "why_candidate": "inventory_only",
                        },
                    ],
                },
                event_ts="2026-04-27T20:14:22.509Z",
                delta_g=300.0,
                session_id=session_id,
                event_id=event_id,
                shelf_id="live_shelf",
            )

            lots = storage_repo.list_lots_by_product(
                conn, product_id=product.product_id,
            )
            assert lots == []
        finally:
            conn.close()

    def test_tombstoned_cloud_lot_blocks_mint(self, tmp_path):
        """A cloud_lots row with deleted_at set must not unlock the mint.

        Tombstones are normally hard-deleted by the LotSnapshotPoller,
        but the SQL gate must still defend against any stale
        soft-deleted rows that might exist during a poller hiccup.
        """
        conn = init_db(":memory:")
        try:
            handler = _make_handler(conn, tmp_path)
            product = _seed_product(conn, name="Tombstoned Product")
            _seed_cloud_lot(
                conn,
                lot_id="cl-tomb",
                product_id=product.product_id,
                qty=1.0,
                deleted_at="2026-04-27T19:00:00+00:00",
            )
            session_id = _open_session(conn)
            event_id = _record_add(conn, session_id, delta_g=400.0)

            handler._apply_lot_update_from_classification(
                direction="add",
                classification={
                    "item_id": product.product_id,
                    "action": "added",
                    "confidence": 0.9,
                    "multi_match": [],
                    "candidate_pool_used": [
                        {
                            "candidate_id": product.product_id,
                            "product_id": product.product_id,
                            "why_candidate": "inventory_only",
                        },
                    ],
                },
                event_ts="2026-04-27T20:14:22.509Z",
                delta_g=400.0,
                session_id=session_id,
                event_id=event_id,
                shelf_id="live_shelf",
            )

            lots = storage_repo.list_lots_by_product(
                conn, product_id=product.product_id,
            )
            assert lots == []
        finally:
            conn.close()
