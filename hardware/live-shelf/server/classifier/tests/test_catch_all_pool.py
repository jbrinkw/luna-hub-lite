"""Catch-all delta-capture candidate pool builder tests.

Covers ``pool_for_catch_all`` in
``server/classifier/candidate_pool.py``. The catch-all pool is
fundamentally different from the live_shelf pool:

  * Lot-keyed (each candidate's id is a cloud lot_id, not a product_id).
  * Single composition for first AND second events (runtime branching
    happens later in the apply path based on the picked lot's
    ``in_flight_kind``).
  * Sources from cloud_lots only (Tier 1 = catch_all in-flight,
    Tier 2 = qty>0 user-inventory, Tier 3 = UNKNOWN sentinel).
    Tier 2 was widened on 2026-05-02 from certified-not-on-any-shelf
    to all qty>0 inventory (see candidate_pool.py:556-561).
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

    **2026-05-02 (Task 4):** ``pool_for_catch_all`` now sources Tier
    2 from ``get_catch_all_user_inventory_lots`` (widened pool
    covering every qty>0 cloud_lots row, certified or not). The
    legacy ``get_catch_all_inventory_lots`` method is still exposed
    here so tests that introspect the protocol shape pre-Task 4
    keep working — the adapter on the Pi keeps the legacy method
    too. Both methods return the same ``inventory`` list so
    membership assertions in this file stay agnostic to which
    method fires.
    """

    def __init__(self, *, in_flight=(), inventory=()):
        self._in_flight = in_flight
        self._inventory = inventory

    # --- Catch-all-specific surface ----------------------------------
    def get_catch_all_in_flight_lots(self):
        return self._in_flight

    def get_catch_all_inventory_lots(self):
        # Legacy certified-only method. Kept for protocol stability
        # (adapter on the Pi exposes it too) but no longer wired
        # into ``pool_for_catch_all`` after Task 4.
        return self._inventory

    def get_catch_all_user_inventory_lots(self):
        # Task 4 source: widened pool covering every qty>0 cloud_lots
        # row regardless of certification. Mirrors the legacy method
        # in this stub so existing membership assertions still hit.
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
    """Tier 2 — qty>0 user-inventory lots appear in the pool (post 2026-05-02 widening)."""
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

        def get_catch_all_user_inventory_lots(self):
            # Task 4: builder sources Tier 2 from the user-inventory
            # method, so the throwing branch lives here now. Legacy
            # method also raises for completeness — guards against
            # future refactors that briefly fall back to it.
            raise RuntimeError("DB still gone")

        def get_catch_all_inventory_lots(self):
            raise RuntimeError("DB still gone (legacy)")

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


# ----------------------------------------------------------------------
# Codex finding MEDIUM-5 (2026-04-28): Tier 1 / Tier 2 lot dedupe
# ----------------------------------------------------------------------


def test_pool_dedupes_lot_when_present_in_both_tiers():
    """Regression: same lot returned by BOTH the in-flight tier AND the
    inventory tier must appear exactly ONCE in the pool. Pre-fix the
    same lot could be in Tier 1 (in_flight_kind='catch_all') AND Tier 2
    (certified-not-on-shelf was previously also accepting
    in_flight_kind='catch_all'); the duplicate then crowded out a
    real candidate after top-N truncation.

    Mutation guard: the dedupe pass uses a ``seen_lot_ids`` set keyed by
    the candidate's lot_id. Removing the set membership check (or
    reverting Tier 2's source query to permit ``in_flight_kind='catch_all'``
    rows AND removing the post-concat dedupe) re-introduces the
    duplicate and fails the count assertion.
    """
    same_lot = _lot("LOT-DUP", 250.0)
    ctx = ClassifierContext(
        source=_CatchAllStubSource(
            in_flight=[same_lot],
            inventory=[same_lot],  # legitimately exposes the same lot
        ),
    )
    pool = pool_for_catch_all(250.0, ctx)
    ids = [c.candidate_id for c in pool if c.candidate_id != UNKNOWN_CANDIDATE_ID]
    # The lot appears exactly once.
    assert ids.count("LOT-DUP") == 1, (
        f"expected lot LOT-DUP exactly once in pool, got {ids}"
    )


def test_pool_dedupe_prefers_in_flight_tier():
    """When both tiers expose the same lot_id, the dedupe pass keeps
    the FIRST occurrence (Tier 1 — in-flight). The Tier 1 candidate's
    ``why_candidate='in_flight'`` outranks Tier 2's ``inventory_only``,
    so the in-flight semantics drive the apply branch — i.e. SECOND
    measurement wins over FIRST, which is the safer default when
    state is ambiguous.

    Mutation guard: re-ordering the concat to ``inventory_lots +
    in_flight_lots`` would make this test fail because the kept
    candidate's why_candidate would be ``inventory_only`` instead of
    ``in_flight``.
    """
    in_flight_v = _lot("LOT-BOTH", 200.0, status="on_shelf")
    inventory_v = _lot("LOT-BOTH", 200.0, status="out")
    ctx = ClassifierContext(
        source=_CatchAllStubSource(
            in_flight=[in_flight_v],
            inventory=[inventory_v],
        ),
    )
    pool = pool_for_catch_all(200.0, ctx)
    pick = next(c for c in pool if c.candidate_id == "LOT-BOTH")
    assert pick.why_candidate == "in_flight", (
        "in-flight tier must win the dedupe so the SECOND-measurement "
        "branch fires when the lot is mid-session"
    )


# ----------------------------------------------------------------------
# Task 4 (catch-all auto-import, 2026-05-02): pool builder must source
# Tier 2 from the WIDENED user-inventory method, not the certified-only
# legacy method.
# ----------------------------------------------------------------------


class _UserInventoryOnlyStubSource:
    """Catch-all source that exposes ONLY the new ``user_inventory``
    method (no legacy ``get_catch_all_inventory_lots``).

    Locks in the invariant: ``pool_for_catch_all`` MUST consult
    ``get_catch_all_user_inventory_lots`` for Tier 2. If the builder
    still calls the legacy method, this stub's lots are never queried
    and the assertion below fails.
    """

    def __init__(self, *, in_flight=(), user_inventory=()):
        self._in_flight = in_flight
        self._user_inventory = user_inventory

    def get_catch_all_in_flight_lots(self):
        return self._in_flight

    def get_catch_all_user_inventory_lots(self):
        return self._user_inventory

    # Live-shelf surface — must never be queried by pool_for_catch_all.
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def test_pool_for_catch_all_uses_user_inventory_method():
    """Tier 2 must call ``get_catch_all_user_inventory_lots`` (the
    widened pool from Task 3), NOT the legacy
    ``get_catch_all_inventory_lots`` (certified-only).

    Lock-in invariant: uncertified products with qty>0 appear in the
    pool. The certified-only filter from the legacy adapter method
    used to drop them; the new method exposes them and the builder
    must wire that source.

    Mutation guard: reverting the source method name in
    ``pool_for_catch_all`` to ``get_catch_all_inventory_lots`` makes
    this stub's user_inventory invisible to the builder (the legacy
    method is intentionally absent here), the inventory tier yields
    [], and both ``lot-uncert`` / ``lot-cert`` are missing from the
    pool — failing the membership assertions.
    """
    uncertified = _lot("lot-uncert", 500.0, name="Uncertified Pasta")
    certified = _lot("lot-cert", 700.0, name="Certified Olive Oil")
    ctx = ClassifierContext(
        source=_UserInventoryOnlyStubSource(
            in_flight=[],
            user_inventory=[uncertified, certified],
        ),
        shelf_id="catch_all",
    )
    pool = pool_for_catch_all(delta_g=505.0, ctx=ctx)
    pool_ids = [c.candidate_id for c in pool]
    # Both lots present (uncertified + certified are equal-class —
    # the widened pool no longer filters on certification).
    assert "lot-uncert" in pool_ids, (
        "uncertified-product lot missing from catch-all pool. The "
        "widened user-inventory source MUST surface qty>0 lots "
        "regardless of certification status."
    )
    assert "lot-cert" in pool_ids, (
        "certified-product lot missing from catch-all pool — the "
        "widened user-inventory source covers ALL qty>0 lots, "
        "certified included."
    )
    # Sentinel last invariant preserved.
    assert pool[-1].candidate_id == UNKNOWN_CANDIDATE_ID
