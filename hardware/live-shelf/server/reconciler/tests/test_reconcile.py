"""Tests for the Bundle E reconciler.

Coverage target (one test minimum per `session_resolutions.pattern`):

    - no_op                      : empty session
    - consumed_or_removed        : unpaired REMOVE
    - new_arrival                : unpaired ADD of catalog-known product
    - use_return_no_consumption  : REMOVE + ADD, same weight
    - use_return_consumed        : REMOVE + ADD, lighter on return
    - topped_up                  : REMOVE + ADD, heavier on return
    - consumed_or_removed (multi): multi_match REMOVE → N resolutions
    - use_return_consumed (ret)  : unpaired ADD of an 'out' lot
    - swap_out / swap_in         : REMOVE + ADD with different identities
    - unknown                    : classifier couldn't identify
    - weight_mismatch review     : sanity-check enqueue
    - relocation                 : out of scope — covered by a test that
                                   asserts the reconciler does NOT emit it

The fake repo captures all writes in lists so assertions target
behavior (row content, call counts) rather than internal state.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

# Make `server.reconciler` importable when running pytest from the repo root.
# The tests live at `hardware/live-shelf/server/reconciler/tests/...` — the
# package root for `server` is `hardware/live-shelf/`.
ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.reconciler import (  # noqa: E402  (sys.path tweak above)
    ReconcilerRepo,
    SessionResolution,
    ReviewQueueItem,
    classify_pair,
    reconcile_session,
)
from server.reconciler.models import (  # noqa: E402
    ClassificationResult,
    MatchCandidate,
)


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


@dataclass
class FakeEvent:
    event_id: str
    session_id: Optional[str]
    ts: str
    delta_g: float
    before_weight_g: float
    after_weight_g: float
    direction: str
    classification: Any = None


@dataclass
class FakeSession:
    session_id: str
    started_at: str = "2026-04-15T12:00:00.000Z"
    ended_at: Optional[str] = "2026-04-15T12:05:00.000Z"
    initial_shelf_weight_g: Optional[float] = 2000.0
    final_shelf_weight_g: Optional[float] = 2000.0
    # Idempotency guard field — reconcile_session reads it via getattr
    # and bails early if non-zero so duplicate reconciles can't write
    # duplicate session_resolutions rows.
    reconciled: int = 0


@dataclass
class FakeLot:
    lot_id: str
    product_id: str = "product-x"
    status: str = "on_shelf"
    current_weight_g: Optional[float] = 340.0


@dataclass
class FakeRepo:
    session: FakeSession
    events: list[FakeEvent]
    lots: dict[str, FakeLot] = field(default_factory=dict)

    written_resolutions: list[SessionResolution] = field(default_factory=list)
    enqueued_reviews: list[ReviewQueueItem] = field(default_factory=list)
    lot_updates: list[tuple[SessionResolution, Optional[FakeLot]]] = field(
        default_factory=list
    )

    # Protocol surface ----------------------------------------------------

    def get_session(self, session_id: str) -> FakeSession:
        assert session_id == self.session.session_id
        return self.session

    def get_events_for_session(self, session_id: str) -> list[FakeEvent]:
        return sorted(
            [e for e in self.events if e.session_id == session_id],
            key=lambda e: e.ts,
        )

    def get_lot(self, lot_id: str) -> Optional[FakeLot]:
        return self.lots.get(lot_id)

    def write_resolution(self, r: SessionResolution) -> Optional[str]:
        self.written_resolutions.append(r)
        return f"res-{len(self.written_resolutions)}"

    def enqueue_review(self, item: ReviewQueueItem) -> None:
        self.enqueued_reviews.append(item)

    def update_lot_on_resolution(
        self, r: SessionResolution, lot: Optional[FakeLot]
    ) -> None:
        self.lot_updates.append((r, lot))

    def mark_session_reconciled(self, session_id: str) -> None:
        # H3: reconciler calls this as the FIRST write so a crash+retry
        # after this point hits the idempotency guard at the top of
        # _reconcile_session_locked. Flip our FakeSession so a second
        # ``reconcile_session`` call on the same id short-circuits.
        if session_id == self.session.session_id:
            self.session.reconciled = 1


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _cls(
    item_id: Optional[str],
    confidence: float = 0.9,
    multi: Optional[list[tuple[str, float]]] = None,
) -> ClassificationResult:
    return ClassificationResult(
        item_id=item_id,
        confidence=confidence,
        action="removed" if item_id else "unknown",
        multi_match=(
            [MatchCandidate(candidate_id=c, confidence=p) for c, p in multi]
            if multi
            else []
        ),
    )


def _mk_event(
    event_id: str,
    ts: str,
    delta_g: float,
    before: float,
    after: float,
    direction: str,
    classification: Any = None,
    session_id: str = "S1",
) -> FakeEvent:
    return FakeEvent(
        event_id=event_id,
        session_id=session_id,
        ts=ts,
        delta_g=delta_g,
        before_weight_g=before,
        after_weight_g=after,
        direction=direction,
        classification=classification,
    )


def _make_repo(
    events: list[FakeEvent],
    *,
    initial_w: Optional[float] = 2000.0,
    final_w: Optional[float] = 2000.0,
    lots: Optional[dict[str, FakeLot]] = None,
    session_id: str = "S1",
) -> FakeRepo:
    return FakeRepo(
        session=FakeSession(
            session_id=session_id,
            initial_shelf_weight_g=initial_w,
            final_shelf_weight_g=final_w,
        ),
        events=events,
        lots=lots or {},
    )


def _patterns(resolutions: list[SessionResolution]) -> list[str]:
    return [r.pattern for r in resolutions]


# ---------------------------------------------------------------------------
# classify_pair — unit tests
# ---------------------------------------------------------------------------


def test_classify_pair_near_zero_is_no_consumption():
    a = _mk_event("a", "t", -200, 2000, 1800, "remove")
    b = _mk_event("b", "t", 200, 1800, 2000, "add")
    out = classify_pair(0.0, a, b)
    assert out.pattern == "use_return_no_consumption"


def test_classify_pair_positive_is_consumed():
    a = _mk_event("a", "t", -200, 2000, 1800, "remove")
    b = _mk_event("b", "t", 150, 1800, 1950, "add")
    out = classify_pair(50.0, a, b)
    assert out.pattern == "use_return_consumed"
    assert out.consumed_g == 50.0


def test_classify_pair_negative_is_topped_up():
    a = _mk_event("a", "t", -200, 2000, 1800, "remove")
    b = _mk_event("b", "t", 260, 1800, 2060, "add")
    out = classify_pair(-60.0, a, b)
    assert out.pattern == "topped_up"


def test_classify_pair_boundary_rounds_to_no_consumption():
    # |consumed| < 5g → no_consumption, even with 4.9g
    a = _mk_event("a", "t", -200, 2000, 1800, "remove")
    b = _mk_event("b", "t", 195.1, 1800, 1995.1, "add")
    out = classify_pair(4.9, a, b)
    assert out.pattern == "use_return_no_consumption"


# ---------------------------------------------------------------------------
# Pattern coverage — one test per pattern minimum
# ---------------------------------------------------------------------------


def test_no_op_empty_session():
    repo = _make_repo(events=[], initial_w=2000.0, final_w=2000.0)
    out = reconcile_session("S1", repo)
    assert _patterns(out) == ["no_op"]
    assert len(repo.written_resolutions) == 1
    # No review queue items, no lot updates beyond the single no_op.
    assert repo.enqueued_reviews == []
    assert len(repo.lot_updates) == 1


def test_single_remove_only_is_consumed_or_removed():
    ev = _mk_event(
        "E1", "2026-04-15T12:01:00Z", -340.0, 2000.0, 1660.0,
        "remove", classification=_cls("lot-ketchup"),
    )
    repo = _make_repo(
        [ev],
        initial_w=2000.0,
        final_w=1660.0,
        lots={"lot-ketchup": FakeLot("lot-ketchup", current_weight_g=340.0)},
    )
    out = reconcile_session("S1", repo)
    assert _patterns(out) == ["consumed_or_removed"]
    assert out[0].lot_id == "lot-ketchup"
    assert out[0].remove_event_id == "E1"
    assert out[0].consumed_g is None
    assert repo.enqueued_reviews == []


def test_single_add_only_new_arrival():
    ev = _mk_event(
        "E1", "2026-04-15T12:01:00Z", +250.0, 2000.0, 2250.0,
        "add", classification=_cls("lot-newthing"),
    )
    repo = _make_repo(
        [ev],
        initial_w=2000.0,
        final_w=2250.0,
        lots={
            "lot-newthing": FakeLot(
                "lot-newthing", status="on_shelf", current_weight_g=250.0
            )
        },
    )
    out = reconcile_session("S1", repo)
    assert _patterns(out) == ["new_arrival"]
    assert out[0].lot_id == "lot-newthing"
    assert out[0].add_event_id == "E1"


def test_remove_then_matching_add_no_consumption():
    remove = _mk_event(
        "E1", "2026-04-15T12:01:00Z", -340.0, 2000.0, 1660.0,
        "remove", classification=_cls("lot-ketchup"),
    )
    add = _mk_event(
        "E2", "2026-04-15T12:02:00Z", +340.0, 1660.0, 2000.0,
        "add", classification=_cls("lot-ketchup"),
    )
    repo = _make_repo(
        [remove, add],
        initial_w=2000.0,
        final_w=2000.0,
        lots={"lot-ketchup": FakeLot("lot-ketchup")},
    )
    out = reconcile_session("S1", repo)
    assert _patterns(out) == ["use_return_no_consumption"]
    r = out[0]
    assert r.remove_event_id == "E1"
    assert r.add_event_id == "E2"
    assert r.lot_id == "lot-ketchup"
    assert abs(r.consumed_g) < 1e-9  # 340 - 340 = 0


def test_remove_then_add_with_gap_use_return_consumed():
    remove = _mk_event(
        "E1", "2026-04-15T12:01:00Z", -340.0, 2000.0, 1660.0,
        "remove", classification=_cls("lot-yogurt"),
    )
    add = _mk_event(
        "E2", "2026-04-15T12:02:00Z", +300.0, 1660.0, 1960.0,
        "add", classification=_cls("lot-yogurt"),
    )
    repo = _make_repo(
        [remove, add],
        initial_w=2000.0,
        final_w=1960.0,
        lots={"lot-yogurt": FakeLot("lot-yogurt")},
    )
    out = reconcile_session("S1", repo)
    assert _patterns(out) == ["use_return_consumed"]
    assert out[0].consumed_g == 40.0  # |340| - |300|


def test_remove_then_heavier_add_topped_up():
    remove = _mk_event(
        "E1", "2026-04-15T12:01:00Z", -500.0, 2000.0, 1500.0,
        "remove", classification=_cls("lot-syrup"),
    )
    add = _mk_event(
        "E2", "2026-04-15T12:02:00Z", +600.0, 1500.0, 2100.0,
        "add", classification=_cls("lot-syrup"),
    )
    repo = _make_repo(
        [remove, add],
        initial_w=2000.0,
        final_w=2100.0,
        lots={"lot-syrup": FakeLot("lot-syrup")},
    )
    out = reconcile_session("S1", repo)
    assert _patterns(out) == ["topped_up"]
    assert out[0].consumed_g == -100.0  # |500| - |600|


def test_multi_match_remove_emits_one_resolution_per_lot():
    ev = _mk_event(
        "E1", "2026-04-15T12:01:00Z", -500.0, 2000.0, 1500.0,
        "remove",
        classification=_cls(
            "lot-a",
            confidence=0.9,
            multi=[("lot-a", 0.6), ("lot-b", 0.3)],
        ),
    )
    repo = _make_repo(
        [ev],
        initial_w=2000.0,
        final_w=1500.0,
        lots={
            "lot-a": FakeLot("lot-a", current_weight_g=300.0),
            "lot-b": FakeLot("lot-b", current_weight_g=200.0),
        },
    )
    out = reconcile_session("S1", repo)
    assert _patterns(out) == ["consumed_or_removed", "consumed_or_removed"]
    assert {r.lot_id for r in out} == {"lot-a", "lot-b"}
    # split confidence preserved from multi_match
    confs = {r.lot_id: r.confidence for r in out}
    assert confs["lot-a"] == 0.6
    assert confs["lot-b"] == 0.3


def test_weight_mismatch_enqueues_review():
    # Initial 2000, final 2000, but events net to -50 → mismatch of 50g.
    # Use a paired REMOVE/ADD where classifier identifies, so passes 1-3
    # produce clean resolutions but §8 pass 4 still detects the sensor
    # discrepancy against the session weights.
    remove = _mk_event(
        "E1", "2026-04-15T12:01:00Z", -300.0, 2000.0, 1700.0,
        "remove", classification=_cls("lot-ketchup"),
    )
    add = _mk_event(
        "E2", "2026-04-15T12:02:00Z", +250.0, 1700.0, 1950.0,
        "add", classification=_cls("lot-ketchup"),
    )
    repo = _make_repo(
        [remove, add],
        initial_w=2000.0,
        final_w=2000.0,  # sensor says unchanged, but events net -50
        lots={"lot-ketchup": FakeLot("lot-ketchup")},
    )
    out = reconcile_session("S1", repo)
    # Paired resolution is still emitted (pattern=use_return_consumed with
    # 50g consumed); mismatch is enqueued in parallel.
    assert _patterns(out) == ["use_return_consumed"]
    assert len(repo.enqueued_reviews) == 1
    rv = repo.enqueued_reviews[0]
    assert rv.kind == "weight_mismatch"
    assert rv.session_id == "S1"
    assert rv.proposed["expected_delta_g"] == 0.0
    assert rv.proposed["actual_delta_g"] == -50.0


def test_weight_sanity_within_tolerance_no_review():
    # 8g mismatch — under the 10g tolerance → no review row.
    remove = _mk_event(
        "E1", "2026-04-15T12:01:00Z", -300.0, 2000.0, 1700.0,
        "remove", classification=_cls("lot-ketchup"),
    )
    add = _mk_event(
        "E2", "2026-04-15T12:02:00Z", +292.0, 1700.0, 1992.0,
        "add", classification=_cls("lot-ketchup"),
    )
    repo = _make_repo(
        [remove, add],
        initial_w=2000.0,
        final_w=2000.0,  # expected 0, actual -8 → within tolerance
        lots={"lot-ketchup": FakeLot("lot-ketchup")},
    )
    reconcile_session("S1", repo)
    assert repo.enqueued_reviews == []


def test_return_of_previously_out_lot_use_return_consumed():
    # ADD event for a lot whose status is 'out' from a prior session.
    # Consumption is `prior.current_weight_g - after_weight_g`.
    add = _mk_event(
        "E1", "2026-04-15T12:01:00Z", +250.0, 2000.0, 2250.0,
        "add", classification=_cls("lot-leftover"),
    )
    repo = _make_repo(
        [add],
        initial_w=2000.0,
        final_w=2250.0,
        lots={
            "lot-leftover": FakeLot(
                "lot-leftover",
                status="out",
                current_weight_g=400.0,  # prior weight
            )
        },
    )
    out = reconcile_session("S1", repo)
    # ev.after_weight_g=2250 is the shelf weight — the reconciler uses
    # the lot's last known weight minus the event's after, but for an
    # ADD "after" is the SHELF after, not the LOT after. §8 computes
    # `max(0, lot.current_weight_g - ev.after_weight_g)`, which for the
    # demo scenarios typically yields 0 (shelf weight > lot weight).
    # We assert the pattern and that consumption never goes negative.
    assert _patterns(out) == ["use_return_consumed"]
    assert out[0].consumed_g == 0.0  # max(0, 400 - 2250) == 0
    assert out[0].lot_id == "lot-leftover"


def test_return_of_out_lot_with_actual_consumption():
    # Scenario where the returned lot is the only thing on the shelf
    # and weighs less than prior → we detect consumption.
    add = _mk_event(
        "E1", "2026-04-15T12:01:00Z", +300.0, 0.0, 300.0,
        "add", classification=_cls("lot-leftover"),
    )
    repo = _make_repo(
        [add],
        initial_w=0.0,
        final_w=300.0,
        lots={
            "lot-leftover": FakeLot(
                "lot-leftover",
                status="out",
                current_weight_g=400.0,  # prior weight was 400
            )
        },
    )
    out = reconcile_session("S1", repo)
    assert _patterns(out) == ["use_return_consumed"]
    # max(0, 400 - 300) = 100 consumed off-shelf
    assert out[0].consumed_g == 100.0


def test_swap_out_and_swap_in_different_identities():
    # REMOVE of lot-a followed by ADD of lot-b with similar magnitudes
    # in same session → swap pair.
    remove = _mk_event(
        "E1", "2026-04-15T12:01:00Z", -250.0, 2000.0, 1750.0,
        "remove", classification=_cls("lot-a"),
    )
    add = _mk_event(
        "E2", "2026-04-15T12:02:00Z", +260.0, 1750.0, 2010.0,
        "add", classification=_cls("lot-b"),
    )
    repo = _make_repo(
        [remove, add],
        initial_w=2000.0,
        final_w=2010.0,
        lots={
            "lot-a": FakeLot("lot-a", current_weight_g=250.0),
            "lot-b": FakeLot(
                "lot-b", status="on_shelf", current_weight_g=260.0
            ),
        },
    )
    out = reconcile_session("S1", repo)
    patterns = _patterns(out)
    assert "swap_out" in patterns
    assert "swap_in" in patterns
    # Exactly one of each, no leftover consumed_or_removed/new_arrival.
    assert patterns.count("swap_out") == 1
    assert patterns.count("swap_in") == 1
    assert "new_arrival" not in patterns
    assert "consumed_or_removed" not in patterns

    swap_out = next(r for r in out if r.pattern == "swap_out")
    swap_in = next(r for r in out if r.pattern == "swap_in")
    assert swap_out.lot_id == "lot-a"
    assert swap_out.remove_event_id == "E1"
    assert swap_in.lot_id == "lot-b"
    assert swap_in.add_event_id == "E2"


def test_swap_detection_skips_remove_already_paired_in_pass_1():
    """Fix 2: swap detection must not create orphan swap_in rows.

    Scenario:
      1. REMOVE lot-a @ t1 (delta -250g)
      2. ADD lot-a @ t2 (delta +250g)   — Pass 1 pairs these into
         ``use_return_no_consumption``.
      3. ADD lot-b @ t3 (delta +260g)   — no matching REMOVE is left,
         but the *original* REMOVE at t1 has similar magnitude.

    Before Fix 2, swap detection scanned the full ``events`` list and
    found the already-paired REMOVE, appending an orphan ``swap_in`` for
    lot-b while failing to rewrite a non-existent
    ``consumed_or_removed`` resolution. After the fix, the leftover ADD
    falls through to Pass 3 and is emitted as ``new_arrival``.
    """
    remove_a = _mk_event(
        "E1", "2026-04-15T12:01:00Z", -250.0, 2000.0, 1750.0,
        "remove", classification=_cls("lot-a"),
    )
    add_a = _mk_event(
        "E2", "2026-04-15T12:02:00Z", +250.0, 1750.0, 2000.0,
        "add", classification=_cls("lot-a"),
    )
    add_b = _mk_event(
        "E3", "2026-04-15T12:03:00Z", +260.0, 2000.0, 2260.0,
        "add", classification=_cls("lot-b"),
    )
    repo = _make_repo(
        [remove_a, add_a, add_b],
        initial_w=2000.0,
        final_w=2260.0,
        lots={
            "lot-a": FakeLot("lot-a"),
            "lot-b": FakeLot(
                "lot-b", status="on_shelf", current_weight_g=260.0
            ),
        },
    )
    out = reconcile_session("S1", repo)
    patterns = _patterns(out)
    # Paired REMOVE+ADD → one use_return_no_consumption.
    assert patterns.count("use_return_no_consumption") == 1
    # Leftover lot-b ADD must NOT become an orphan swap_in — it should
    # fall through to Pass 3 as a new_arrival.
    assert "swap_in" not in patterns
    assert "swap_out" not in patterns
    assert patterns.count("new_arrival") == 1
    new_arrival = next(r for r in out if r.pattern == "new_arrival")
    assert new_arrival.lot_id == "lot-b"
    assert new_arrival.add_event_id == "E3"


def test_unknown_pattern_when_classifier_cannot_identify_remove():
    ev = _mk_event(
        "E1", "2026-04-15T12:01:00Z", -100.0, 2000.0, 1900.0,
        "remove", classification=_cls(None),
    )
    repo = _make_repo([ev], initial_w=2000.0, final_w=1900.0)
    out = reconcile_session("S1", repo)
    assert _patterns(out) == ["unknown"]
    assert out[0].remove_event_id == "E1"
    assert out[0].lot_id is None


def test_unknown_pattern_when_classifier_cannot_identify_add():
    ev = _mk_event(
        "E1", "2026-04-15T12:01:00Z", +150.0, 2000.0, 2150.0,
        "add", classification=_cls("unknown"),
    )
    repo = _make_repo([ev], initial_w=2000.0, final_w=2150.0)
    out = reconcile_session("S1", repo)
    assert _patterns(out) == ["unknown"]
    assert out[0].add_event_id == "E1"


def test_unknown_sentinel_UPPERCASE_still_emits_unknown():
    ev = _mk_event(
        "E1", "2026-04-15T12:01:00Z", +150.0, 2000.0, 2150.0,
        "add", classification=_cls("UNKNOWN"),
    )
    repo = _make_repo([ev], initial_w=2000.0, final_w=2150.0)
    out = reconcile_session("S1", repo)
    assert _patterns(out) == ["unknown"]


def test_relocation_is_not_emitted_for_single_shelf_demo():
    """§8 notes relocation is out of scope for the single-shelf demo.

    Even if a lot appears in both a REMOVE and a separate session's ADD,
    the reconciler should NOT synthesize a 'relocation' pattern — that's
    reserved for future multi-shelf work.
    """
    remove = _mk_event(
        "E1", "2026-04-15T12:01:00Z", -340.0, 2000.0, 1660.0,
        "remove", classification=_cls("lot-ketchup"),
    )
    repo = _make_repo(
        [remove],
        initial_w=2000.0,
        final_w=1660.0,
        lots={"lot-ketchup": FakeLot("lot-ketchup")},
    )
    out = reconcile_session("S1", repo)
    assert "relocation" not in _patterns(out)


# ---------------------------------------------------------------------------
# Interaction coverage
# ---------------------------------------------------------------------------


def test_mixed_session_with_paired_and_unpaired_events():
    """A realistic session: 2 pairs + 1 leftover remove + 1 new arrival."""
    evs = [
        _mk_event(
            "E1", "2026-04-15T12:01:00Z", -340.0, 2000.0, 1660.0,
            "remove", classification=_cls("lot-ketchup"),
        ),
        _mk_event(
            "E2", "2026-04-15T12:02:00Z", -500.0, 1660.0, 1160.0,
            "remove", classification=_cls("lot-mayo"),
        ),
        _mk_event(
            "E3", "2026-04-15T12:03:00Z", +300.0, 1160.0, 1460.0,
            "add", classification=_cls("lot-ketchup"),  # pairs with E1
        ),
        _mk_event(
            "E4", "2026-04-15T12:04:00Z", +100.0, 1460.0, 1560.0,
            "add", classification=_cls("lot-newitem"),  # new arrival
        ),
    ]
    repo = _make_repo(
        evs,
        initial_w=2000.0,
        # -340 + -500 + 300 + 100 = -440 → 1560
        final_w=1560.0,
        lots={
            "lot-ketchup": FakeLot("lot-ketchup"),
            "lot-mayo": FakeLot("lot-mayo"),
            "lot-newitem": FakeLot("lot-newitem", status="on_shelf"),
        },
    )
    out = reconcile_session("S1", repo)
    patterns = _patterns(out)
    # Exactly one paired remove+add, one unpaired remove, one new arrival.
    assert patterns.count("use_return_consumed") == 1
    assert patterns.count("consumed_or_removed") == 1
    assert patterns.count("new_arrival") == 1
    # Sanity check passed → no review.
    assert repo.enqueued_reviews == []


def test_all_resolutions_are_written_via_repo():
    """Every returned resolution must have been committed via write_resolution."""
    remove = _mk_event(
        "E1", "2026-04-15T12:01:00Z", -200.0, 2000.0, 1800.0,
        "remove", classification=_cls("lot-x"),
    )
    add = _mk_event(
        "E2", "2026-04-15T12:02:00Z", +200.0, 1800.0, 2000.0,
        "add", classification=_cls("lot-x"),
    )
    repo = _make_repo(
        [remove, add],
        lots={"lot-x": FakeLot("lot-x")},
    )
    out = reconcile_session("S1", repo)
    assert out == repo.written_resolutions


def test_update_lot_on_resolution_called_for_each_resolution():
    remove = _mk_event(
        "E1", "2026-04-15T12:01:00Z", -200.0, 2000.0, 1800.0,
        "remove", classification=_cls("lot-x"),
    )
    add = _mk_event(
        "E2", "2026-04-15T12:02:00Z", +200.0, 1800.0, 2000.0,
        "add", classification=_cls("lot-x"),
    )
    lot = FakeLot("lot-x")
    repo = _make_repo([remove, add], lots={"lot-x": lot})
    out = reconcile_session("S1", repo)
    assert len(repo.lot_updates) == len(out)
    r, l = repo.lot_updates[0]
    assert r.lot_id == "lot-x"
    assert l is lot  # repo.get_lot resolved it


def test_raw_dict_classification_is_accepted():
    """Bundle H may hand us classifications as dicts (JSON-decoded)."""
    remove = _mk_event(
        "E1", "2026-04-15T12:01:00Z", -200.0, 2000.0, 1800.0,
        "remove",
        classification={
            "item_id": "lot-x",
            "confidence": 0.9,
            "action": "removed",
            "multi_match": [],
        },
    )
    repo = _make_repo([remove], lots={"lot-x": FakeLot("lot-x")})
    out = reconcile_session("S1", repo)
    assert _patterns(out) == ["consumed_or_removed"]


def test_events_sorted_by_ts_regardless_of_input_order():
    """§8 reads events in timestamp order — if repo returns them shuffled,
    the sort must still pair earlier REMOVE with later ADD."""
    remove = _mk_event(
        "E1", "2026-04-15T12:01:00Z", -200.0, 2000.0, 1800.0,
        "remove", classification=_cls("lot-x"),
    )
    add = _mk_event(
        "E2", "2026-04-15T12:02:00Z", +200.0, 1800.0, 2000.0,
        "add", classification=_cls("lot-x"),
    )
    # Repo's get_events_for_session sorts by ts regardless of insertion
    # order, which mirrors the §3 schema (ordered_by ts in pseudocode).
    repo = _make_repo([add, remove], lots={"lot-x": FakeLot("lot-x")})
    out = reconcile_session("S1", repo)
    assert _patterns(out) == ["use_return_no_consumption"]


def test_reconcile_session_returns_early_when_already_reconciled():
    """Regression guard for the idempotency fix.

    ``session_resolutions`` has no unique constraint on
    (session_id, add_event_id/remove_event_id), so if two concurrent
    callers (a brightness-wobble retry + a crash-recovery sweep, for
    example) both pass the ``reconciled`` read-check they'd both write
    duplicate rows and double-count consumption.

    The fix: ``reconcile_session`` reads ``session.reconciled`` under a
    per-session lock and bails with an empty list if it's already set.
    This test verifies the early-return contract at the repo boundary —
    no ``write_resolution``, ``enqueue_review``, or
    ``update_lot_on_resolution`` call happens on the second pass.
    """
    remove = _mk_event(
        "E1", "2026-04-15T12:01:00Z", -200.0, 2000.0, 1800.0,
        "remove", classification=_cls("lot-x"),
    )
    add = _mk_event(
        "E2", "2026-04-15T12:02:00Z", +200.0, 1800.0, 2000.0,
        "add", classification=_cls("lot-x"),
    )
    repo = FakeRepo(
        # Session starts ALREADY marked reconciled=1, simulating a second
        # concurrent call that arrived after the first one finished.
        session=FakeSession(
            session_id="S1",
            initial_shelf_weight_g=2000.0,
            final_shelf_weight_g=2000.0,
            reconciled=1,
        ),
        events=[remove, add],
        lots={"lot-x": FakeLot("lot-x")},
    )

    out = reconcile_session("S1", repo)

    # Early-return contract: empty resolution list...
    assert out == []
    # ...no resolutions written...
    assert repo.written_resolutions == []
    # ...no review queue entries enqueued (e.g. weight_mismatch)...
    assert repo.enqueued_reviews == []
    # ...and no lot updates applied.
    assert repo.lot_updates == []


def test_reconciler_is_idempotent_across_crash_retry():
    """H3: reconcile twice on the same session — total_consumed_g bumps once.

    Before the H3 fix, ``mark_session_reconciled`` was written by the
    caller in ``app.py`` only AFTER ``reconcile_session`` returned. If
    the process crashed between ``write_resolution`` and the outer mark,
    a retry would replay every resolution and double-count lot
    consumption (``session_resolutions`` has no unique constraint on
    ``(session_id, add_event_id/remove_event_id)``).

    The fix: the reconciler itself calls ``repo.mark_session_reconciled``
    as the VERY FIRST write inside ``_reconcile_session_locked``. A
    crash+retry after that point hits the top-of-function idempotency
    guard on the second run and returns ``[]``. This test simulates that
    by calling ``reconcile_session`` twice back-to-back on the same repo.
    """
    remove = _mk_event(
        "E1", "2026-04-15T12:01:00Z", -200.0, 2000.0, 1800.0,
        "remove", classification=_cls("lot-x"),
    )
    add = _mk_event(
        "E2", "2026-04-15T12:02:00Z", +150.0, 1800.0, 1950.0,
        "add", classification=_cls("lot-x"),
    )
    repo = _make_repo(
        [remove, add],
        initial_w=2000.0,
        final_w=1950.0,
        lots={"lot-x": FakeLot("lot-x")},
    )

    # First reconcile: produces a single use_return_consumed resolution
    # with 50g consumed. FakeRepo.mark_session_reconciled flips the
    # session's ``reconciled`` flag as the first write.
    first = reconcile_session("S1", repo)
    assert _patterns(first) == ["use_return_consumed"]
    first_consumed = sum(
        (r.consumed_g or 0.0) for r in repo.written_resolutions
    )
    assert first_consumed == 50.0
    assert repo.session.reconciled == 1

    # Second call simulates a crash+retry AFTER the first call had
    # already flipped the flag. The idempotency guard at the top of
    # _reconcile_session_locked must short-circuit — zero new writes,
    # zero extra consumption.
    second = reconcile_session("S1", repo)
    assert second == []
    total_consumed = sum(
        (r.consumed_g or 0.0) for r in repo.written_resolutions
    )
    assert total_consumed == 50.0, (
        "crash+retry double-counted consumption — mark_session_reconciled "
        "must be written as the FIRST write inside _reconcile_session_locked"
    )
    # Only the single resolution from the first pass should exist.
    assert len(repo.written_resolutions) == 1


def test_ts_ordering_prevents_pairing_add_before_remove():
    """An ADD earlier than its would-be REMOVE must NOT pair."""
    add = _mk_event(
        "E1", "2026-04-15T12:01:00Z", +200.0, 1800.0, 2000.0,
        "add", classification=_cls("lot-x"),
    )
    remove = _mk_event(
        "E2", "2026-04-15T12:02:00Z", -200.0, 2000.0, 1800.0,
        "remove", classification=_cls("lot-x"),
    )
    # Here the ADD comes BEFORE the REMOVE by ts — the §8 predicate
    # `ev_add.ts > ev_remove.ts` must prevent pairing.
    repo = _make_repo(
        [add, remove],
        initial_w=1800.0,
        final_w=1800.0,
        lots={
            "lot-x": FakeLot(
                "lot-x", status="on_shelf", current_weight_g=200.0
            )
        },
    )
    out = reconcile_session("S1", repo)
    patterns = _patterns(out)
    # ADD alone → new_arrival (lot is on_shelf, not out)
    # REMOVE alone → consumed_or_removed
    # No paired pattern emitted.
    assert "use_return_no_consumption" not in patterns
    assert "use_return_consumed" not in patterns
    assert "topped_up" not in patterns
    assert "new_arrival" in patterns
    assert "consumed_or_removed" in patterns
