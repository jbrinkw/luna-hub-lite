"""Catch-all delta-capture candidate pool builder tests.

Covers ``pool_for_catch_all`` in
``server/classifier/candidate_pool.py``. The catch-all pool is
fundamentally different from the live_shelf pool:

  * Lot-keyed (each candidate's id is a cloud lot_id, not a product_id).
  * Single composition for first AND second events (runtime branching
    happens later in the apply path based on the picked lot's
    ``in_flight_kind``).
  * Sources from cloud_lots only (Tier 1 = catch_all in-flight,
    Tier 2 = certified-not-on-any-shelf, Tier 3 = UNKNOWN sentinel).
  * No top-up / recently-out / catalog branches.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.classifier.candidate_pool import pool_for_catch_all  # noqa: E402
from server.classifier.models import (  # noqa: E402
    UNKNOWN_CANDIDATE_ID,
    ClassifierContext,
    LotCandidate,
)


class _CatchAllStubSource:
    """Catch-all-aware CandidateSource stub.

    Implements only the catch-all-specific methods + the legacy
    no-op stubs needed for compatibility with helpers that may
    introspect them.
    """

    def __init__(self, *, in_flight=(), inventory=()):
        self._in_flight = in_flight
        self._inventory = inventory

    # --- Catch-all-specific surface ----------------------------------
    def get_catch_all_in_flight_lots(self):
        return self._in_flight

    def get_catch_all_inventory_lots(self):
        return self._inventory

    # --- Legacy no-ops (none of these should fire from the catch-all
    # pool builder; they exist so the protocol shape is satisfied if
    # something else introspects). -----------------------------------
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _lot(lot_id, weight_g, *, name=None, status="on_shelf"):
    return LotCandidate(
        lot_id=lot_id,
        product_id=f"p-{lot_id}",
        name=name or f"Lot {lot_id}",
        brand=None,
        expected_weight_g=weight_g,
        container_type="tub",
        status=status,
    )


def test_pool_includes_in_flight_tier():
    """Tier 1 — in-flight catch-all lots appear in the pool."""
    ctx = ClassifierContext(
        source=_CatchAllStubSource(
            in_flight=[_lot("IF-1", 350.0)],
        ),
    )
    pool = pool_for_catch_all(350.0, ctx)
    ids = [c.candidate_id for c in pool]
    assert "IF-1" in ids
    # UNKNOWN sentinel always last.
    assert ids[-1] == UNKNOWN_CANDIDATE_ID


def test_pool_includes_inventory_tier():
    """Tier 2 — certified-not-on-any-shelf lots appear in the pool."""
    ctx = ClassifierContext(
        source=_CatchAllStubSource(
            inventory=[_lot("INV-1", 500.0)],
        ),
    )
    pool = pool_for_catch_all(500.0, ctx)
    ids = [c.candidate_id for c in pool]
    assert "INV-1" in ids


def test_pool_is_lot_keyed_not_product_keyed():
    """Catch-all pool's candidate_id MUST be the lot_id (not product_id).

    Apply path uses the picked candidate's id to look up the cloud_lots
    row's in_flight_kind. Collapsing by product would lose the
    discriminator.
    """
    ctx = ClassifierContext(
        source=_CatchAllStubSource(
            in_flight=[_lot("IF-A", 200.0)],
            inventory=[_lot("INV-B", 500.0)],
        ),
    )
    pool = pool_for_catch_all(300.0, ctx)
    ids = [c.candidate_id for c in pool if c.candidate_id != UNKNOWN_CANDIDATE_ID]
    # Both lots present, distinct candidate_ids.
    assert "IF-A" in ids
    assert "INV-B" in ids


def test_pool_in_flight_outranks_inventory():
    """In-flight lots should rank above inventory lots."""
    ctx = ClassifierContext(
        source=_CatchAllStubSource(
            in_flight=[_lot("IF-X", 300.0)],
            inventory=[_lot("INV-Y", 300.0)],
        ),
    )
    pool = pool_for_catch_all(300.0, ctx)
    ids = [c.candidate_id for c in pool if c.candidate_id != UNKNOWN_CANDIDATE_ID]
    assert ids.index("IF-X") < ids.index("INV-Y")


def test_pool_unknown_sentinel_only_once():
    ctx = ClassifierContext(
        source=_CatchAllStubSource(
            in_flight=[_lot("X", 100.0)],
            inventory=[_lot("Y", 100.0)],
        ),
    )
    pool = pool_for_catch_all(100.0, ctx)
    ids = [c.candidate_id for c in pool]
    assert ids.count(UNKNOWN_CANDIDATE_ID) == 1
    assert ids[-1] == UNKNOWN_CANDIDATE_ID


def test_pool_empty_when_no_sources():
    """Empty pool yields just the UNKNOWN sentinel."""
    ctx = ClassifierContext(source=_CatchAllStubSource())
    pool = pool_for_catch_all(100.0, ctx)
    assert [c.candidate_id for c in pool] == [UNKNOWN_CANDIDATE_ID]


def test_pool_does_not_include_live_shelf_branches():
    """No top-up / recently-out / catalog candidates leak in.

    Even if the source happens to expose live_shelf-style sources, the
    catch-all builder must not consult them — that would let a lot
    mid-pickup-on-the-live-shelf get incorrectly resolved as a
    catch-all event.
    """
    class _PoisonedStub(_CatchAllStubSource):
        def get_on_shelf_lots(self, shelf_id=None):
            # Should NEVER be queried by pool_for_catch_all.
            raise RuntimeError("pool_for_catch_all queried get_on_shelf_lots!")

        def get_recently_out_lots(self, window_seconds, shelf_id=None):
            raise RuntimeError(
                "pool_for_catch_all queried get_recently_out_lots!"
            )

        def get_certified_not_on_shelf(self):
            raise RuntimeError(
                "pool_for_catch_all queried get_certified_not_on_shelf!"
            )

    ctx = ClassifierContext(
        source=_PoisonedStub(in_flight=[_lot("X", 100.0)]),
    )
    pool = pool_for_catch_all(100.0, ctx)
    # If any RuntimeError fires, the test fails.
    assert "X" in [c.candidate_id for c in pool]


def test_pool_falls_back_gracefully_on_source_error():
    """A throwing source method must not crash the pool builder."""
    class _ThrowingStub:
        def get_catch_all_in_flight_lots(self):
            raise RuntimeError("DB went away")

        def get_catch_all_inventory_lots(self):
            raise RuntimeError("DB still gone")

    ctx = ClassifierContext(source=_ThrowingStub())
    pool = pool_for_catch_all(100.0, ctx)
    # Empty real candidates → just UNKNOWN.
    assert [c.candidate_id for c in pool] == [UNKNOWN_CANDIDATE_ID]


def test_pool_compatible_with_legacy_source_missing_methods():
    """Source pre-dating catch-all (no get_catch_all_* methods) → empty pool."""
    class _LegacyStub:
        def get_on_shelf_lots(self, shelf_id=None):
            return []

    ctx = ClassifierContext(source=_LegacyStub())
    pool = pool_for_catch_all(100.0, ctx)
    assert [c.candidate_id for c in pool] == [UNKNOWN_CANDIDATE_ID]


def test_pool_lot_id_persists_through_rebuild():
    """The candidate's lot_id field stays populated after the
    lot-keyed rebuild — apply path needs it for the cloud_lots lookup.
    """
    ctx = ClassifierContext(
        source=_CatchAllStubSource(in_flight=[_lot("LOT-Z", 300.0)]),
    )
    pool = pool_for_catch_all(300.0, ctx)
    pick = next(c for c in pool if c.candidate_id == "LOT-Z")
    assert pick.lot_id == "LOT-Z"
