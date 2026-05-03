"""Property test: catch-all pool builder never crashes on edge weights.

Background: ``pool_for_catch_all`` (and its weight-proximity scorer
``weight_proximity_score``) accepts a ``delta_g`` for ranking. The
formula divides by the candidate's ``expected_weight_g`` — a naive
implementation could ZeroDivisionError on a zero-or-missing
``expected_weight_g``, or NaN-poison on a non-finite delta. The
production code already gates with ``expected is None or expected
<= 0`` returning 0.0, but the invariant is too important to leave to
fixed-input tests:

  For ANY ``placed_g`` in [0, 100_000] AND any combination of source
  rows (including degenerate weights of 0 / very small / very large),
  ``pool_for_catch_all`` must return a pool (possibly just the
  sentinel) without raising an unhandled exception.

The test catches the broad shape "the pool builder is brittle to
edge weights" rather than a specific numeric output. If the builder
raises a TypeError or ZeroDivisionError it fails immediately.

Mutation hardening: removing the ``expected <= 0`` guard in
``weight_proximity_score`` makes this property fail when Hypothesis
generates a candidate with ``expected_weight_g=0`` — the division
raises ZeroDivisionError under the rebuilt scoring loop.
"""

from __future__ import annotations

import sys
from pathlib import Path

from hypothesis import given, settings, strategies as st

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
        # so the edge-weight property still drives the inventory-tier
        # branch in the pool builder after the swap.
        return self._inventory

    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _lot(lot_id: str, weight_g: float | None) -> LotCandidate:
    return LotCandidate(
        lot_id=lot_id,
        product_id=f"p-{lot_id}",
        name=f"Lot {lot_id}",
        brand=None,
        expected_weight_g=weight_g,
        container_type="tub",
        status="on_shelf",
    )


# Edge-weight grammar: include 0, very small, very large, and None
# (LotCandidate accepts ``expected_weight_g: float | None``). The
# ranking formula divides by expected_weight_g — a brittle
# implementation crashes on zero/None/non-finite.
_edge_weights = st.one_of(
    st.just(None),
    st.just(0.0),
    st.floats(min_value=0.0, max_value=1e-3, allow_nan=False, allow_infinity=False),
    st.floats(min_value=1.0, max_value=100_000.0, allow_nan=False, allow_infinity=False),
)


@st.composite
def _lot_strategy(draw):
    return _lot(draw(st.text(alphabet="ABCDEF", min_size=1, max_size=3)), draw(_edge_weights))


@given(
    in_flight=st.lists(_lot_strategy(), max_size=4),
    inventory=st.lists(_lot_strategy(), max_size=4),
    placed_g=st.floats(
        min_value=0.0, max_value=100_000.0, allow_nan=False, allow_infinity=False
    ),
)
@settings(max_examples=100, deadline=None)
def test_pool_for_catch_all_handles_edge_weights_without_crashing(in_flight, inventory, placed_g):
    """For ANY edge-weight scenario, the pool builder returns a list
    (possibly just the sentinel) without raising."""
    ctx = ClassifierContext(
        source=_CatchAllStubSource(in_flight=in_flight, inventory=inventory),
    )
    pool = pool_for_catch_all(placed_g, ctx)
    # The pool always contains the UNKNOWN sentinel — at minimum.
    assert isinstance(pool, list)
    assert len(pool) >= 1
    assert pool[-1].candidate_id == UNKNOWN_CANDIDATE_ID
