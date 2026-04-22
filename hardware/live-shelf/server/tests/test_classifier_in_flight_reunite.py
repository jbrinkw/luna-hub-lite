"""Regression tests for the in-flight reunite bug.

Real-world event (2026-04-22): chocolate milk in-flight with
pickup_weight_g=1672g. User drank, placed back at 472.4g. The classifier
received both an in-flight lot candidate (lot_id) and a catalog
product candidate (product_id) for the same SKU; it picked the CATALOG
product_id because the catalog's gross_weight_g (~1537g) looked like a
"partially full bottle" next to the +472.4g delta. The apply path then
minted a brand-new lot and orphaned the in-flight lot — no consumption
was recorded.

This module pins the fix on three layers:
  1. Candidate-pool suppresses the catalog dup when an in-flight lot
     for the same product exists (forces classifier away from the
     ambiguous choice).
  2. Handler-level reunite guard rewrites item_id → in-flight lot_id
     when the classifier still picks the product_id, so the return
     branch runs and consumption is recorded.
  3. Confidence is bumped to 1.0 on redirect so the event lands in
     ``classified`` instead of ``review``.

See ``docs/IN_FLIGHT_TRACKER_PLAN.md`` §5.1 and the commit body for
the full design notes.
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

from server.classifier import candidate_pool as cp  # noqa: E402
from server.classifier.models import (  # noqa: E402
    ClassifierContext,
    LotCandidate,
    ProductCandidate,
    UNKNOWN_CANDIDATE_ID,
)
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn, ScaleEventIn  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


class _NullCandidateSource:
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _make_handler(conn, tmp_path, **kwargs):
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


def _setup_chocolate_milk(conn):
    """Seed the real-world scenario's product + 1672g lot on live_shelf."""
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Chocolate Milk",
            barcode="CM-1",
            # Net weight ≈ 1537.8g per the bug report (the catalog
            # value the classifier anchored on in the real event).
            net_weight_g=1537.8,
            gross_weight_g=1537.8,
            unit_type="liquid",
            container_type="bottle",
            certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id,
            status="on_shelf",
            current_weight_g=1672.0,
            initial_weight_g=1672.0,
            shelf_id="live_shelf",
        ),
    )
    return product, lot


def _open_session(conn, initial_weight_g=1672.0):
    return storage_repo.open_session(
        conn, "2026-04-22T03:00:00.000Z", initial_weight_g=initial_weight_g
    ).session_id


def _record_remove(conn, session_id, *, delta_g, ts, weight_before):
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts=ts, delta_g=delta_g,
            before_weight_g=weight_before,
            after_weight_g=weight_before + delta_g,
            direction="remove", session_id=session_id,
            classifier_status="pending",
        ),
    )
    return ev.event_id


def _record_add(conn, session_id, *, delta_g, ts, weight_before):
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts=ts, delta_g=delta_g,
            before_weight_g=weight_before,
            after_weight_g=weight_before + delta_g,
            direction="add", session_id=session_id,
            classifier_status="pending",
        ),
    )
    return ev.event_id


def _resolutions_for(conn, session_id):
    return [
        dict(row)
        for row in conn.execute(
            "SELECT * FROM session_resolutions WHERE session_id=? "
            "ORDER BY created_at",
            (session_id,),
        )
    ]


def _on_shelf_lots_for_product(conn, product_id):
    return [
        dict(row)
        for row in conn.execute(
            "SELECT lot_id, status, current_weight_g FROM lots "
            "WHERE product_id=? AND status='on_shelf'",
            (product_id,),
        )
    ]


# ---------------------------------------------------------------------------
# Layer 1: candidate-pool suppresses the catalog dup for an in-flight SKU.
# ---------------------------------------------------------------------------


class _InFlightOnlySource:
    """Candidate source that surfaces BOTH the in-flight lot AND the catalog
    product for the same SKU — mirrors the production configuration that
    triggered the bug.
    """

    def __init__(self, product, lot):
        self._product = product
        self._lot = lot

    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return [
            LotCandidate(
                lot_id=self._lot.lot_id,
                product_id=self._product.product_id,
                name=self._product.name,
                brand=self._product.brand,
                expected_weight_g=1672.0,
                container_type=self._product.container_type,
                status="in_flight",
            )
        ]

    def get_certified_not_on_shelf(self):
        return [
            ProductCandidate(
                product_id=self._product.product_id,
                name=self._product.name,
                brand=self._product.brand,
                expected_weight_g=1537.8,
                container_type=self._product.container_type,
            )
        ]


class TestCandidatePoolSuppressesCatalogDup:
    def test_pool_for_add_drops_catalog_when_in_flight_exists(self, tmp_path):
        conn = init_db(":memory:")
        product, lot = _setup_chocolate_milk(conn)
        source = _InFlightOnlySource(product, lot)
        ctx = ClassifierContext(source=source)
        pool = cp.pool_for_add(delta_g=472.4, ctx=ctx)

        # Sentinel is always present.
        assert pool[-1].candidate_id == UNKNOWN_CANDIDATE_ID

        # In-flight lot must be present.
        lot_entry = next(
            (c for c in pool if c.candidate_id == lot.lot_id), None
        )
        assert lot_entry is not None
        assert lot_entry.why_candidate == "in_flight"
        # Pickup weight, not catalog weight.
        assert lot_entry.expected_weight_g == 1672.0

        # Catalog product_id for the SAME SKU must be suppressed — that's
        # the core fix.
        catalog_dup = [
            c for c in pool
            if c.candidate_id == product.product_id
        ]
        assert catalog_dup == [], (
            "catalog product_id should not appear when the same SKU has "
            "an in-flight lot; its presence is what let the classifier "
            "pick the wrong candidate in the bug report"
        )


# ---------------------------------------------------------------------------
# Layer 2: handler reunite guard — even if classifier picks product_id,
# the apply path redirects to the in-flight lot.
# ---------------------------------------------------------------------------


class TestHandlerReuniteGuardWithCorrectClassifierPick:
    """Happy path: classifier picked the in-flight lot_id (as the fixed
    prompt should). Apply path runs the return branch, records the 1199.6g
    of consumption, no new lot minted.
    """

    def test_return_closes_in_flight_and_writes_consumption(self, tmp_path):
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        product, lot = _setup_chocolate_milk(conn)
        session_id = _open_session(conn)

        # Stage the in-flight pickup via the real remove apply path.
        e_remove = _record_remove(
            conn, session_id,
            delta_g=-1672.0,
            ts="2026-04-22T03:01:39.000Z",
            weight_before=1672.0,
        )
        handler._apply_lot_update_from_classification(
            direction="remove",
            classification={
                "item_id": lot.lot_id,
                "action": "removed",
                "confidence": 0.95,
                "multi_match": [],
                "candidate_pool_used": [{"candidate_id": lot.lot_id}],
            },
            event_ts="2026-04-22T03:01:39.000Z",
            delta_g=-1672.0,
            session_id=session_id,
            event_id=e_remove,
        )
        assert storage_repo.get_lot(conn, lot.lot_id).status == "in_flight"

        # Return: 472.4g placed back. Classifier (fixed prompt) picks the
        # in-flight lot_id with action="added".
        e_add = _record_add(
            conn, session_id,
            delta_g=472.4,
            ts="2026-04-22T03:05:00.000Z",
            weight_before=0.0,
        )
        handler._apply_lot_update_from_classification(
            direction="add",
            classification={
                "item_id": lot.lot_id,
                "action": "added",
                "confidence": 0.95,
                "multi_match": [],
                "candidate_pool_used": [
                    {"candidate_id": lot.lot_id,
                     "why_candidate": "in_flight",
                     "product_id": product.product_id,
                     "expected_weight_g": 1672.0},
                ],
            },
            event_ts="2026-04-22T03:05:00.000Z",
            delta_g=472.4,
            session_id=session_id,
            event_id=e_add,
        )

        lot_now = storage_repo.get_lot(conn, lot.lot_id)
        assert lot_now.status == "on_shelf"
        assert lot_now.current_weight_g == pytest.approx(472.4)
        # 1672 - 472.4 = 1199.6 consumed
        assert lot_now.total_consumed_g == pytest.approx(1199.6, rel=1e-3)
        assert lot_now.in_flight_since is None
        assert lot_now.pickup_weight_g is None

        # No new lot minted.
        on_shelf = _on_shelf_lots_for_product(conn, product.product_id)
        assert len(on_shelf) == 1
        assert on_shelf[0]["lot_id"] == lot.lot_id

        # Resolution row written: in_flight_return.
        resolutions = _resolutions_for(conn, session_id)
        patterns = [r["pattern"] for r in resolutions]
        assert "in_flight_pickup" in patterns
        assert "in_flight_return" in patterns
        return_row = next(
            r for r in resolutions if r["pattern"] == "in_flight_return"
        )
        assert return_row["consumed_g"] == pytest.approx(1199.6, rel=1e-3)
        assert return_row["add_event_id"] == e_add


class TestHandlerReuniteGuardWithLegacyClassifierPick:
    """Defense in depth: classifier returned the OLD/WRONG shape
    (item_id = product_id, action = "added", low confidence). The handler's
    reunite guard MUST detect the in-flight lot for this product on this
    shelf and redirect the apply path to close the in-flight lot + record
    consumption, NOT mint a brand-new lot.
    """

    def test_product_id_pick_is_redirected_to_in_flight_lot(self, tmp_path):
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        product, lot = _setup_chocolate_milk(conn)
        session_id = _open_session(conn)

        # Stage the in-flight pickup.
        e_remove = _record_remove(
            conn, session_id,
            delta_g=-1672.0,
            ts="2026-04-22T03:01:39.000Z",
            weight_before=1672.0,
        )
        handler._apply_lot_update_from_classification(
            direction="remove",
            classification={
                "item_id": lot.lot_id,
                "action": "removed",
                "confidence": 0.95,
                "multi_match": [],
                "candidate_pool_used": [{"candidate_id": lot.lot_id}],
            },
            event_ts="2026-04-22T03:01:39.000Z",
            delta_g=-1672.0,
            session_id=session_id,
            event_id=e_remove,
        )
        assert storage_repo.get_lot(conn, lot.lot_id).status == "in_flight"

        # Return: 472.4g placed back. Simulate the buggy classifier:
        # picks the CATALOG product_id with a low confidence and the
        # action "added" — exactly the shape observed in the 2026-04-22
        # real event.
        e_add = _record_add(
            conn, session_id,
            delta_g=472.4,
            ts="2026-04-22T03:05:00.000Z",
            weight_before=0.0,
        )
        handler._apply_lot_update_from_classification(
            direction="add",
            classification={
                "item_id": product.product_id,  # <-- wrong: product_id
                "action": "added",
                "confidence": 0.60,             # <-- below threshold
                "multi_match": [],
                "candidate_pool_used": [
                    {"candidate_id": lot.lot_id,
                     "why_candidate": "in_flight",
                     "product_id": product.product_id,
                     "expected_weight_g": 1672.0},
                    {"candidate_id": product.product_id,
                     "why_candidate": "catalog_not_on_shelf",
                     "product_id": product.product_id,
                     "expected_weight_g": 1537.8},
                ],
            },
            event_ts="2026-04-22T03:05:00.000Z",
            delta_g=472.4,
            session_id=session_id,
            event_id=e_add,
        )

        # The handler's reunite guard should have rewritten the apply
        # path to route through _apply_add_against_in_flight_lot.
        lot_now = storage_repo.get_lot(conn, lot.lot_id)
        assert lot_now.status == "on_shelf", (
            "in-flight lot should be closed back to on_shelf — was the "
            "reunite guard triggered?"
        )
        assert lot_now.current_weight_g == pytest.approx(472.4)
        assert lot_now.total_consumed_g == pytest.approx(1199.6, rel=1e-3)

        # Critical: NO new lot minted for this product.
        on_shelf = _on_shelf_lots_for_product(conn, product.product_id)
        assert len(on_shelf) == 1, (
            "reunite guard failed: a new lot was minted, orphaning the "
            "in-flight one. On-shelf lots for this product: "
            f"{on_shelf}"
        )
        assert on_shelf[0]["lot_id"] == lot.lot_id

        # Resolution log: in_flight_return (NOT new_arrival or similar).
        resolutions = _resolutions_for(conn, session_id)
        patterns = [r["pattern"] for r in resolutions]
        assert "in_flight_pickup" in patterns
        assert "in_flight_return" in patterns
        assert "new_arrival" not in patterns


class TestReuniteGuardSkipsGenuineReplacement:
    """When the placed weight exceeds the in-flight pickup weight by more
    than the replacement ratio, the user swapped in a different / fuller
    item. The reunite guard must NOT redirect — the existing default
    paths (replacement branch if lot_id picked; session dedup + TTL
    reaper if product_id picked) handle it without the in-flight lot
    being mistaken for a returning container.
    """

    def test_reunite_guard_does_not_rewrite_when_delta_exceeds_ratio(
        self, tmp_path
    ):
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)

        # Seed a small in-flight lot (100g pickup). Replacement ratio
        # default is 1.15 → any placement > 115g is treated as a
        # genuine replacement, not a returning lot.
        product = storage_repo.create_product(
            conn,
            ProductIn(
                name="Small Item",
                barcode="SI-1",
                net_weight_g=100.0,
                gross_weight_g=100.0,
                unit_type="solid",
                container_type="jar",
                certified=1,
            ),
        )
        lot = storage_repo.create_lot(
            conn,
            LotIn(
                product_id=product.product_id,
                status="on_shelf",
                current_weight_g=100.0,
                initial_weight_g=100.0,
                shelf_id="live_shelf",
            ),
        )
        # Flip directly to in_flight via the storage helper so we don't
        # need a session for this pure-guard test.
        storage_repo.mark_lot_in_flight(
            conn,
            lot.lot_id,
            pickup_weight_g=100.0,
            pickup_event_id=None,
            pickup_session_id=None,
            in_flight_since="2026-04-22T03:01:39.000Z",
        )

        # Call the guard directly with a 1000g ADD targeting the
        # catalog product_id. 1000 > 100 × 1.15 = 115 → too heavy to
        # be a returning partially-consumed bottle.
        classification = {
            "item_id": product.product_id,
            "action": "added",
            "confidence": 0.90,
            "multi_match": [],
            "candidate_pool_used": [
                {"candidate_id": lot.lot_id,
                 "why_candidate": "in_flight",
                 "product_id": product.product_id,
                 "expected_weight_g": 100.0},
                {"candidate_id": product.product_id,
                 "why_candidate": "catalog_not_on_shelf",
                 "product_id": product.product_id,
                 "expected_weight_g": 100.0},
            ],
        }
        result = handler._maybe_reunite_with_in_flight_lot(
            classification=classification,
            direction="add",
            delta_g=1000.0,
            shelf_id="live_shelf",
        )

        # Guard declined to rewrite — the classification passes through
        # unchanged so the downstream paths can treat the event as a
        # genuine replacement.
        assert result["item_id"] == product.product_id
        assert result["confidence"] == 0.90
        assert "reunite_redirect" not in (result.get("meta") or {})


class TestReuniteGuardIsShelfScoped:
    """An in-flight lot on a different shelf must not trigger the redirect.
    Otherwise a catch-all ADD for a product that happens to have an
    in-flight lot on the live_shelf would erroneously re-unite across
    shelves.
    """

    def test_in_flight_on_other_shelf_does_not_redirect(self, tmp_path):
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        product = storage_repo.create_product(
            conn,
            ProductIn(
                name="Cross-Shelf Item",
                barcode="XS-1",
                net_weight_g=300.0,
                gross_weight_g=300.0,
                unit_type="solid",
                container_type="box",
                certified=1,
            ),
        )
        # In-flight lot on catch_all.
        lot = storage_repo.create_lot(
            conn,
            LotIn(
                product_id=product.product_id,
                status="on_shelf",
                current_weight_g=300.0,
                initial_weight_g=300.0,
                shelf_id="catch_all",
            ),
        )
        storage_repo.mark_lot_in_flight(
            conn,
            lot.lot_id,
            pickup_weight_g=300.0,
            pickup_event_id=None,
            pickup_session_id=None,
            in_flight_since="2026-04-22T03:01:39.000Z",
        )

        # ADD on live_shelf targeting the catalog product_id.
        classification = {
            "item_id": product.product_id,
            "action": "added",
            "confidence": 0.90,
            "multi_match": [],
            "candidate_pool_used": [
                {"candidate_id": product.product_id,
                 "why_candidate": "catalog_not_on_shelf",
                 "product_id": product.product_id,
                 "expected_weight_g": 300.0},
            ],
        }
        result = handler._maybe_reunite_with_in_flight_lot(
            classification=classification,
            direction="add",
            delta_g=250.0,
            shelf_id="live_shelf",  # <-- different shelf than the in-flight
        )

        # Guard must not have rewritten — the in-flight lot belongs to
        # a different shelf.
        assert result["item_id"] == product.product_id
        assert result["confidence"] == 0.90
        assert "reunite_redirect" not in (result.get("meta") or {})


# ---------------------------------------------------------------------------
# Layer 3 (2026-04-22 addendum): even when the classifier correctly returns
# ``item_id=lot_id`` AND the candidate_pool_used dict DOESN'T carry a
# ``product_id`` field (production shape via _from_lot -> asdict), the
# apply-path must still hit _apply_add_against_in_flight_lot and emit the
# cloud consumption event. The prior code bailed with "ambiguous" because
# the in-flight lot's product_id wasn't in valid_product_ids — losing both
# the lot-close and the cloud emit.
# ---------------------------------------------------------------------------


class TestProductionPoolShapeLotBackedPickApplies:
    """Regression for the 2026-04-22 chocolate-milk stuck-in-flight event.

    Real event shape (from scale_events.classification on the Pi):
      - classifier item_id = lot_id (correct pick post 2026-04-21 prompt fix)
      - candidate_pool_used[0] = {candidate_id=lot_id, why_candidate=in_flight, ...}
        NO product_id field (asdict(_from_lot(...)) pre-fix).
      - candidate_pool_used[1..] = catalog_not_on_shelf for OTHER products.
    The apply-path MUST NOT reject the picked lot on "product not in pool"
    grounds — the lot_id itself is in the pool, which is unambiguous.
    """

    def test_production_pool_shape_in_flight_lot_pick_closes_and_emits(
        self, tmp_path
    ):
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        product, lot = _setup_chocolate_milk(conn)
        session_id = _open_session(conn)

        # Stage the pickup.
        e_remove = _record_remove(
            conn, session_id,
            delta_g=-1672.0,
            ts="2026-04-22T03:01:39.000Z",
            weight_before=1672.0,
        )
        handler._apply_lot_update_from_classification(
            direction="remove",
            classification={
                "item_id": lot.lot_id,
                "action": "removed",
                "confidence": 0.95,
                "multi_match": [],
                "candidate_pool_used": [{"candidate_id": lot.lot_id}],
            },
            event_ts="2026-04-22T03:01:39.000Z",
            delta_g=-1672.0,
            session_id=session_id,
            event_id=e_remove,
        )
        assert storage_repo.get_lot(conn, lot.lot_id).status == "in_flight"

        # Spy on cloud emitter so we can assert the consumption event
        # gets enqueued.
        emit_calls: list[dict] = []

        def _spy(**kwargs):
            emit_calls.append(kwargs)
            return None

        handler._cloud_emitter.emit_reconciler_resolution = _spy  # type: ignore[assignment]

        # Return: 472.1g. Classifier (fixed prompt) picks the in-flight
        # lot_id. The candidate_pool_used dict matches the PRODUCTION
        # shape — lot-backed entry has NO product_id, plus two unrelated
        # catalog products. This is the exact shape Jeremy's event had
        # when the bug fired.
        e_add = _record_add(
            conn, session_id,
            delta_g=472.1,
            ts="2026-04-22T04:03:54.000Z",
            weight_before=0.0,
        )
        handler._apply_lot_update_from_classification(
            direction="add",
            classification={
                "item_id": lot.lot_id,
                "action": "added",
                "confidence": 0.92,
                "multi_match": [],
                "candidate_pool_used": [
                    # Lot-backed entry WITHOUT product_id (production shape).
                    {"candidate_id": lot.lot_id,
                     "why_candidate": "in_flight",
                     "expected_weight_g": 1672.494},
                    # Unrelated catalog dups for OTHER products — their
                    # candidate_id IS their product_id per _from_product.
                    {"candidate_id": "aa9f27c3-dba8-4c2f-ba34-333159d685ad",
                     "why_candidate": "catalog_not_on_shelf"},
                    {"candidate_id": "00000000-0000-0000-0000-019db187d973",
                     "why_candidate": "catalog_not_on_shelf"},
                    {"candidate_id": UNKNOWN_CANDIDATE_ID,
                     "why_candidate": "sentinel"},
                ],
            },
            event_ts="2026-04-22T04:03:54.000Z",
            delta_g=472.1,
            session_id=session_id,
            event_id=e_add,
        )

        # Lot transitioned on_shelf with the placed weight and consumption.
        lot_now = storage_repo.get_lot(conn, lot.lot_id)
        assert lot_now.status == "on_shelf", (
            "in-flight lot still stuck — ambiguity guard rejected the "
            "correct classifier pick because the lot's product_id wasn't "
            "in the pool's catalog_not_on_shelf list"
        )
        assert lot_now.current_weight_g == pytest.approx(472.1)
        assert lot_now.total_consumed_g == pytest.approx(1199.9, rel=1e-3)
        assert lot_now.in_flight_since is None
        assert lot_now.pickup_weight_g is None

        # No new lot minted.
        on_shelf = _on_shelf_lots_for_product(conn, product.product_id)
        assert len(on_shelf) == 1
        assert on_shelf[0]["lot_id"] == lot.lot_id

        # Session resolution written: in_flight_return.
        resolutions = _resolutions_for(conn, session_id)
        patterns = [r["pattern"] for r in resolutions]
        assert "in_flight_return" in patterns
        return_row = next(
            r for r in resolutions if r["pattern"] == "in_flight_return"
        )
        assert return_row["consumed_g"] == pytest.approx(1199.9, rel=1e-3)
        assert return_row["add_event_id"] == e_add

        # Cloud emit fired exactly once with the consumption event.
        assert len(emit_calls) == 1, (
            f"expected one cloud emit, got {len(emit_calls)}: {emit_calls}"
        )
        call = emit_calls[0]
        assert call["pattern"] == "in_flight_return"
        assert call["kind"] == "live_shelf"
        assert call["product_id"] == product.product_id
        assert call["delta_g"] == pytest.approx(-1199.9, rel=1e-3)
        assert call["pi_event_id"] == e_add


class TestProductionPoolShapeTopUpPickApplies:
    """Same ambiguity-guard fix, top-up variant: classifier picks lot_id
    with action='added_to_existing', delta slightly above pickup (user
    topped off the bottle).
    """

    def test_top_up_pick_closes_and_emits_refilled(self, tmp_path):
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        product, lot = _setup_chocolate_milk(conn)
        session_id = _open_session(conn)

        # Stage pickup at 1672g.
        e_remove = _record_remove(
            conn, session_id,
            delta_g=-1672.0,
            ts="2026-04-22T03:01:39.000Z",
            weight_before=1672.0,
        )
        handler._apply_lot_update_from_classification(
            direction="remove",
            classification={
                "item_id": lot.lot_id,
                "action": "removed",
                "confidence": 0.95,
                "multi_match": [],
                "candidate_pool_used": [{"candidate_id": lot.lot_id}],
            },
            event_ts="2026-04-22T03:01:39.000Z",
            delta_g=-1672.0,
            session_id=session_id,
            event_id=e_remove,
        )

        emit_calls: list[dict] = []

        def _spy(**kwargs):
            emit_calls.append(kwargs)
            return None

        handler._cloud_emitter.emit_reconciler_resolution = _spy  # type: ignore[assignment]

        # Place back slightly HEAVIER than pickup (user added contents).
        # 1800g is within 1.15× pickup (1922g) so it's still the return
        # branch, not replacement. action='added_to_existing' routes the
        # resolution to topped_up → cloud emits refilled.
        e_add = _record_add(
            conn, session_id,
            delta_g=1800.0,
            ts="2026-04-22T04:03:54.000Z",
            weight_before=0.0,
        )
        handler._apply_lot_update_from_classification(
            direction="add",
            classification={
                "item_id": lot.lot_id,
                "action": "added_to_existing",
                "confidence": 0.92,
                "multi_match": [],
                "candidate_pool_used": [
                    {"candidate_id": lot.lot_id,
                     "why_candidate": "in_flight",
                     "expected_weight_g": 1672.0},
                ],
            },
            event_ts="2026-04-22T04:03:54.000Z",
            delta_g=1800.0,
            session_id=session_id,
            event_id=e_add,
        )

        lot_now = storage_repo.get_lot(conn, lot.lot_id)
        assert lot_now.status == "on_shelf"
        assert lot_now.current_weight_g == pytest.approx(1800.0)
        # Consumption is clamped at 0 for top-ups.
        assert lot_now.total_consumed_g == pytest.approx(0.0, abs=1e-6)

        # Resolution is topped_up.
        resolutions = _resolutions_for(conn, session_id)
        patterns = [r["pattern"] for r in resolutions]
        assert "topped_up" in patterns

        # Cloud emit: refilled with positive delta (added mass).
        assert len(emit_calls) == 1, emit_calls
        call = emit_calls[0]
        assert call["pattern"] == "topped_up"
        assert call["kind"] == "live_shelf"
        assert call["product_id"] == product.product_id
        assert call["delta_g"] == pytest.approx(128.0, rel=1e-2)  # 1800-1672
        assert call["pi_event_id"] == e_add
