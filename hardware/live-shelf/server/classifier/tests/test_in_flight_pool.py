"""In-flight candidate-pool tests (IN_FLIGHT_TRACKER_PLAN.md §5)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.classifier.candidate_pool import _tier_rank, pool_for_add  # noqa: E402
from server.classifier.models import (  # noqa: E402
    ClassifierContext,
    LotCandidate,
    ProductCandidate,
)


class _StubSource:
    """In-flight-aware CandidateSource stub. Tests customise via constructor."""

    def __init__(
        self,
        *,
        on_shelf=(),
        recently_out=(),
        in_flight=(),
        catalog=(),
    ):
        self._on_shelf = on_shelf
        self._recently_out = recently_out
        self._in_flight = in_flight
        self._catalog = catalog

    def get_on_shelf_lots(self):
        return self._on_shelf

    def get_recently_out_lots(self, window_seconds):
        return self._recently_out

    def get_in_flight_lots(self, max_age_seconds=None):
        return self._in_flight

    def get_certified_not_on_shelf(self):
        return self._catalog


def _lot(lot_id, weight_g, status="in_flight", name=None):
    return LotCandidate(
        lot_id=lot_id,
        product_id=f"p-{lot_id}",
        name=name or f"Lot {lot_id}",
        brand=None,
        expected_weight_g=weight_g,
        container_type="tub",
        status=status,
    )


def test_tier_rank_in_flight_outranks_recently_out():
    assert _tier_rank("in_flight") < _tier_rank("recently_out")
    assert _tier_rank("in_flight") < _tier_rank("catalog_not_on_shelf")
    assert _tier_rank("in_flight") < _tier_rank("currently_on_shelf")


def test_pool_for_add_includes_in_flight_lots():
    ctx = ClassifierContext(
        source=_StubSource(
            in_flight=[_lot("INF-1", 200.0, status="in_flight")],
        ),
    )
    pool = pool_for_add(180.0, ctx)
    ids_and_reasons = [(c.candidate_id, c.why_candidate) for c in pool]
    assert ("INF-1", "in_flight") in ids_and_reasons


def test_pool_for_add_ranks_in_flight_above_recently_out_at_equal_weight():
    ctx = ClassifierContext(
        source=_StubSource(
            in_flight=[_lot("INF-1", 200.0, status="in_flight")],
            recently_out=[_lot("OUT-1", 200.0, status="out")],
        ),
    )
    pool = pool_for_add(200.0, ctx)
    # Strip the sentinel for ordering check.
    non_sentinel = [c for c in pool if c.why_candidate != "sentinel"]
    # In-flight should come FIRST.
    assert non_sentinel[0].candidate_id == "INF-1"
    assert non_sentinel[0].why_candidate == "in_flight"
    # Recently-out is next.
    next_ids = [c.candidate_id for c in non_sentinel[1:]]
    assert "OUT-1" in next_ids


def test_pool_for_add_handles_candidate_source_without_get_in_flight_lots():
    """Older CandidateSource stubs (without get_in_flight_lots) must still
    work — the adapter uses getattr and silently skips the branch."""

    class _OldStub:
        def get_on_shelf_lots(self):
            return []

        def get_recently_out_lots(self, window_seconds):
            return []

        def get_certified_not_on_shelf(self):
            return []

    ctx = ClassifierContext(source=_OldStub())
    pool = pool_for_add(200.0, ctx)
    # Should not raise; should still include at least the sentinel.
    assert len(pool) >= 1
    assert any(c.why_candidate == "sentinel" for c in pool)


def test_pool_for_add_deduplicates_in_flight_wins_over_recently_out():
    """If the same lot_id appears in both in_flight and recently_out
    (status race during migration), the in-flight entry wins because
    it's first in the union order and dedupe keeps the first."""
    same_id = "L1"
    ctx = ClassifierContext(
        source=_StubSource(
            in_flight=[_lot(same_id, 200.0, status="in_flight", name="InF")],
            recently_out=[_lot(same_id, 200.0, status="out", name="OoF")],
        ),
    )
    pool = pool_for_add(200.0, ctx)
    matching = [c for c in pool if c.candidate_id == same_id]
    assert len(matching) == 1
    assert matching[0].why_candidate == "in_flight"
    assert matching[0].name == "InF"
