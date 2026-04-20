"""Weight-mismatch review payload must include the event list.

When Pass 4 detects |Σdelta - final_shelf_delta| > 10g, the enqueued
``review_queue`` row carries a ``proposed`` dict whose ``events`` key
lists {event_id, direction, delta_g} for every event in the session.
The dashboard's weight_mismatch template relies on this to render a
per-event breakdown — without it, the review page is useless.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.reconciler.models import (  # noqa: E402
    ClassificationResult,
    MatchCandidate,
    ReviewQueueItem,
    SessionResolution,
)
from server.reconciler.reconcile import reconcile_session  # noqa: E402


@dataclass
class FakeSession:
    session_id: str = "S-wm"
    started_at: str = "2026-04-15T12:00:00Z"
    ended_at: Optional[str] = "2026-04-15T12:05:00Z"
    initial_shelf_weight_g: Optional[float] = 2000.0
    final_shelf_weight_g: Optional[float] = 2000.0
    reconciled: int = 0


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
class FakeRepo:
    session: FakeSession = field(default_factory=FakeSession)
    events: list = field(default_factory=list)
    written: list = field(default_factory=list)
    reviews: list[ReviewQueueItem] = field(default_factory=list)

    def get_session(self, session_id):
        return self.session

    def get_events_for_session(self, session_id):
        return list(self.events)

    def get_lot(self, lot_id):
        return None

    def write_resolution(self, r) -> Optional[str]:
        self.written.append(r)
        return f"res-{len(self.written)}"

    def enqueue_review(self, item: ReviewQueueItem) -> None:
        self.reviews.append(item)

    def update_lot_on_resolution(self, r, lot) -> None:
        pass


def _cls(item_id: Optional[str]) -> ClassificationResult:
    return ClassificationResult(
        item_id=item_id,
        confidence=0.9,
        action="removed" if item_id else "unknown",
        reasoning="",
        multi_match=(),
    )


def test_weight_mismatch_review_includes_events_list():
    """Pair a REMOVE/ADD so the scale math diverges from the session
    weights (init 2000, final 2000, but events net -50). Assert the
    review row's proposed.events has both event_ids + directions +
    delta_g values.
    """
    remove = FakeEvent(
        event_id="E1",
        session_id="S-wm",
        ts="2026-04-15T12:01:00Z",
        delta_g=-300.0,
        before_weight_g=2000.0,
        after_weight_g=1700.0,
        direction="remove",
        classification=_cls("lot-k"),
    )
    add = FakeEvent(
        event_id="E2",
        session_id="S-wm",
        ts="2026-04-15T12:02:00Z",
        delta_g=250.0,
        before_weight_g=1700.0,
        after_weight_g=1950.0,
        direction="add",
        classification=_cls("lot-k"),
    )
    repo = FakeRepo(events=[remove, add])
    reconcile_session("S-wm", repo)

    # Expect exactly one weight_mismatch review enqueued.
    wm = [r for r in repo.reviews if r.kind == "weight_mismatch"]
    assert len(wm) == 1, (
        f"expected 1 weight_mismatch review; got {len(wm)}: {repo.reviews!r}"
    )
    proposed = wm[0].proposed
    assert isinstance(proposed, dict)
    assert "events" in proposed
    events_blob = proposed["events"]
    assert isinstance(events_blob, list)
    assert len(events_blob) == 2

    by_id = {e["event_id"]: e for e in events_blob}
    assert "E1" in by_id
    assert "E2" in by_id
    assert by_id["E1"]["direction"] == "remove"
    assert by_id["E1"]["delta_g"] == -300.0
    assert by_id["E2"]["direction"] == "add"
    assert by_id["E2"]["delta_g"] == 250.0
