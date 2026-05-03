"""Property test: ``pool_for_catch_all`` never returns duplicate lot_ids.

Background: the catch-all pool builder in
``server/classifier/candidate_pool.py`` queries two source tiers
(in-flight + inventory-only) and dedupes by lot_id before ranking.
A 2026-04-28 belt-and-braces guard added an explicit ``seen_lot_ids``
set after the source-side disjointness was tightened. This test
fuzzes the source returns with Hypothesis and asserts the no-dupes
invariant holds for ANY combination of lot_ids the two tiers could
plausibly return — including the (now source-side prevented but
historically possible) case where the same lot appears in BOTH tiers.

Mutation hardening: dropping the dedupe check (the
``seen_lot_ids`` set OR the ``if lot_id_str in seen_lot_ids: continue``
guard) makes this property fail on the very first generated case
where the in-flight and inventory tiers share a lot_id. fast-shrinks
to the smallest such case for fast debugging.
"""

from __future__ import annotations

import sys
from pathlib import Path

from hypothesis import given, settings, strategies as st

# Make the live-shelf server module importable regardless of where
# pytest is invoked from. Mirrors the conftest.py setup in the parent
# tests/ directory.
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
    """Minimal CandidateSource stub for catch-all pool assembly.

    Only implements the catch-all-specific surface; the live_shelf
    methods return empty lists so the pool builder never crosses
    into them.
    """

    def __init__(self, *, in_flight=(), inventory=()):
        self._in_flight = in_flight
        self._inventory = inventory

    def get_catch_all_in_flight_lots(self):
        return self._in_flight

    def get_catch_all_inventory_lots(self):
        # Legacy method kept for protocol stability. ``pool_for_catch_all``
        # consults ``get_catch_all_user_inventory_lots`` after Task 4.
        return self._inventory

    def get_catch_all_user_inventory_lots(self):
        # Task 4 (2026-05-02) Tier 2 source: widened pool covering
        # every qty>0 cloud_lots row. Mirrors the legacy method here
        # so the property still observes inventory-tier candidates
        # after the swap (otherwise the dedupe property holds
        # vacuously).
        return self._inventory

    # Live-shelf surface — must never be queried by pool_for_catch_all.
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _lot(lot_id: str, weight_g: float, *, status: str = "on_shelf") -> LotCandidate:
    return LotCandidate(
        lot_id=lot_id,
        product_id=f"p-{lot_id}",
        name=f"Lot {lot_id}",
        brand=None,
        expected_weight_g=weight_g,
        container_type="tub",
        status=status,  # type: ignore[arg-type]
    )


# Lot-id alphabet kept small so collisions are likely — Hypothesis
# can shrink to a counterexample quickly. Each draw produces a list
# (possibly with duplicates) for each tier.
_lot_id_st = st.text(alphabet="ABCDE", min_size=1, max_size=2)
_weight_st = st.floats(min_value=10.0, max_value=2_000.0, allow_nan=False, allow_infinity=False)


@st.composite
def _lot_strategy(draw, *, status: str):
    return _lot(draw(_lot_id_st), draw(_weight_st), status=status)


@given(
    in_flight=st.lists(_lot_strategy(status="in_flight"), max_size=6),
    inventory=st.lists(_lot_strategy(status="on_shelf"), max_size=6),
    delta_g=st.floats(min_value=10.0, max_value=2_000.0, allow_nan=False, allow_infinity=False),
)
@settings(max_examples=80, deadline=None)
def test_pool_for_catch_all_has_no_duplicate_lot_ids(in_flight, inventory, delta_g):
    """For ANY (in_flight × inventory) combination, returned candidates
    have unique lot_ids (excluding the UNKNOWN sentinel)."""
    ctx = ClassifierContext(
        source=_CatchAllStubSource(in_flight=in_flight, inventory=inventory),
    )
    pool = pool_for_catch_all(delta_g, ctx)

    # Collect lot_ids from non-sentinel entries only — sentinel has no
    # lot_id and is included once by contract.
    lot_ids = []
    sentinel_count = 0
    for c in pool:
        if c.candidate_id == UNKNOWN_CANDIDATE_ID:
            sentinel_count += 1
            continue
        # candidate_id is the lot_id for catch-all (see _lot_keyed in
        # candidate_pool.pool_for_catch_all — lot-keyed pool, not
        # product-keyed).
        lot_ids.append(c.candidate_id)

    assert len(lot_ids) == len(set(lot_ids)), (
        f"pool_for_catch_all returned duplicate lot_ids: {lot_ids}. "
        f"in_flight={[l.lot_id for l in in_flight]} "
        f"inventory={[l.lot_id for l in inventory]}"
    )
    # UNKNOWN sentinel is included exactly once.
    assert sentinel_count == 1, (
        f"UNKNOWN sentinel must appear exactly once in the pool, "
        f"got {sentinel_count}"
    )
