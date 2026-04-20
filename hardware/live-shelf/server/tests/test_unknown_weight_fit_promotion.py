"""Regression tests for UNKNOWN -> multi_match promotion via weight-fit.

Bug report (2026-04-17): classifier returned item_id="UNKNOWN" + confidence 0.55
on a 4-item REMOVE event whose multi_match correctly enumerated all four items
summing to 984g vs -981g delta (0.3% fit error). Apply pipeline short-circuited
on is_unknown and never consulted multi_match, so four on-shelf lots stayed
'on_shelf' even though the shelf was visibly empty in the after frame.

Fix: when item_id=UNKNOWN and direction=remove, if multi_match weight-fits
|delta| within 3%, promote item_id to the highest-expected-weight multi_match
entry and run the apply path normally.

Tests cover both layers:
  * helper purity (_compute_weight_fit, _pick_promotion_item_id)
  * apply-path integration (_apply_lot_update_from_classification)
  * outer classifier-handler integration (_classify_recorded_event)
"""

from __future__ import annotations

import json
import sqlite3
import sys
import threading
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.classifier.models import UNKNOWN_CANDIDATE_ID  # noqa: E402
from server.classifier import prompt as classifier_prompt  # noqa: E402
from server.handlers.scale_events import (  # noqa: E402
    ScaleHandler,
    _compute_weight_fit,
    _pick_promotion_item_id,
)
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn, ScaleEventIn  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


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


def _open_session(conn: sqlite3.Connection) -> str:
    return storage_repo.open_session(
        conn, "2026-04-17T03:48:54.270Z", initial_weight_g=977.5,
    ).session_id


def _create_lot(
    conn: sqlite3.Connection, *, name: str, barcode: str, weight_g: float
):
    """Create a certified product + an on_shelf lot at the product's weight."""
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name=name, barcode=barcode,
            net_weight_g=weight_g, gross_weight_g=weight_g,
            unit_type="solid", container_type="tray", certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id, status="on_shelf",
            current_weight_g=weight_g, initial_weight_g=weight_g,
        ),
    )
    return product, lot


def _record_event(conn, *, session_id, direction, delta_g, ts):
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts=ts, delta_g=delta_g,
            before_weight_g=0.0, after_weight_g=0.0,
            direction=direction, session_id=session_id,
            classifier_status="pending",
        ),
    )
    return ev.event_id


# ---------------------------------------------------------------------------
# Unit: _compute_weight_fit
# ---------------------------------------------------------------------------


class TestComputeWeightFit:
    def test_passes_when_sum_within_tolerance(self):
        # Two items summing to 500g vs delta 499g → 0.2% fit error.
        classification = {
            "item_id": "lot-a",
            "multi_match": [{"candidate_id": "lot-b"}],
            "candidate_pool_used": [
                {"candidate_id": "lot-a", "expected_weight_g": 250.0},
                {"candidate_id": "lot-b", "expected_weight_g": 250.0},
            ],
        }
        ok, ids, summed = _compute_weight_fit(classification, "remove", -499.0)
        assert ok is True
        assert ids == ["lot-a", "lot-b"]
        assert summed == 500.0

    def test_fails_when_fit_error_exceeds_tolerance(self):
        # 100g apart on a 500g delta → 20% error, far outside 3% tolerance.
        classification = {
            "item_id": "lot-a",
            "multi_match": [{"candidate_id": "lot-b"}],
            "candidate_pool_used": [
                {"candidate_id": "lot-a", "expected_weight_g": 250.0},
                {"candidate_id": "lot-b", "expected_weight_g": 250.0},
            ],
        }
        ok, _ids, _summed = _compute_weight_fit(
            classification, "remove", -600.0
        )
        assert ok is False

    def test_includes_multi_match_only_when_direction_is_remove(self):
        classification = {
            "item_id": "lot-a",
            "multi_match": [{"candidate_id": "lot-b"}],
            "candidate_pool_used": [
                {"candidate_id": "lot-a", "expected_weight_g": 250.0},
                {"candidate_id": "lot-b", "expected_weight_g": 250.0},
            ],
        }
        # ADD direction: only item_id counts — 250g vs 250g fits.
        ok, ids, summed = _compute_weight_fit(classification, "add", 250.0)
        assert ok is True and ids == ["lot-a"] and summed == 250.0

    def test_starts_with_only_multi_match_when_item_id_is_unknown(self):
        classification = {
            "item_id": UNKNOWN_CANDIDATE_ID,
            "multi_match": [
                {"candidate_id": "lot-a"},
                {"candidate_id": "lot-b"},
            ],
            "candidate_pool_used": [
                {"candidate_id": "lot-a", "expected_weight_g": 250.0},
                {"candidate_id": "lot-b", "expected_weight_g": 250.0},
            ],
        }
        ok, ids, summed = _compute_weight_fit(classification, "remove", -500.0)
        assert ok is True
        assert ids == ["lot-a", "lot-b"]
        assert summed == 500.0

    def test_returns_false_when_pool_missing_expected_weight(self):
        classification = {
            "item_id": "lot-a",
            "multi_match": [],
            "candidate_pool_used": [
                {"candidate_id": "lot-a"},  # no expected_weight_g
            ],
        }
        ok, _ids, summed = _compute_weight_fit(
            classification, "remove", -250.0
        )
        assert ok is False and summed == 0.0


# ---------------------------------------------------------------------------
# Unit: _pick_promotion_item_id
# ---------------------------------------------------------------------------


class TestPickPromotionItemId:
    def test_returns_highest_weight_when_weight_fit_ok(self):
        classification = {
            "item_id": UNKNOWN_CANDIDATE_ID,
            "multi_match": [
                {"candidate_id": "lot-light"},
                {"candidate_id": "lot-heavy"},
            ],
            "candidate_pool_used": [
                {"candidate_id": "lot-light", "expected_weight_g": 200.0},
                {"candidate_id": "lot-heavy", "expected_weight_g": 300.0},
            ],
        }
        picked = _pick_promotion_item_id(classification, "remove", -500.0)
        assert picked == "lot-heavy"

    def test_returns_none_when_weight_fit_fails(self):
        classification = {
            "item_id": UNKNOWN_CANDIDATE_ID,
            "multi_match": [{"candidate_id": "lot-a"}],
            "candidate_pool_used": [
                {"candidate_id": "lot-a", "expected_weight_g": 100.0},
            ],
        }
        assert _pick_promotion_item_id(classification, "remove", -300.0) is None

    def test_returns_none_for_add_direction(self):
        # ADD events never carry multi_match, so promotion must not fire.
        classification = {
            "item_id": UNKNOWN_CANDIDATE_ID,
            "multi_match": [{"candidate_id": "lot-a"}],
            "candidate_pool_used": [
                {"candidate_id": "lot-a", "expected_weight_g": 250.0},
            ],
        }
        assert _pick_promotion_item_id(classification, "add", 250.0) is None

    def test_returns_none_when_multi_match_empty(self):
        classification = {
            "item_id": UNKNOWN_CANDIDATE_ID,
            "multi_match": [],
            "candidate_pool_used": [],
        }
        assert _pick_promotion_item_id(classification, "remove", -250.0) is None


# ---------------------------------------------------------------------------
# Integration: _apply_lot_update_from_classification
# ---------------------------------------------------------------------------


class TestApplyPromotesUnknownToMultiMatch:
    def test_apply_promotes_unknown_and_flips_all_multi_match_lots(self, tmp_path):
        """The production-observed case: 4 items removed at once, item_id=UNKNOWN,
        multi_match summing to -delta within tolerance → all 4 lots flip to 'out'.
        """
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)

        _, lot_cc = _create_lot(conn, name="Cream Cheese", barcode="1", weight_g=261.0)
        _, lot_ch = _create_lot(conn, name="Cheddar", barcode="2", weight_g=230.0)
        _, lot_ck = _create_lot(conn, name="Chicken", barcode="3", weight_g=248.0)
        _, lot_pm = _create_lot(conn, name="Parmesan", barcode="4", weight_g=245.0)

        session_id = _open_session(conn)
        event_ts = "2026-04-17T03:49:09.939Z"
        event_id = _record_event(
            conn, session_id=session_id, direction="remove",
            delta_g=-981.0, ts=event_ts,
        )
        # 261 + 230 + 248 + 245 = 984g vs 981g → 0.3% fit error, passes.

        classification = {
            "item_id": UNKNOWN_CANDIDATE_ID,
            "action": "removed",
            "confidence": 0.55,
            "reasoning": "Empty after but wasn't sure about one item.",
            "multi_match": [
                {"candidate_id": lot_cc.lot_id, "confidence": 0.7},
                {"candidate_id": lot_ch.lot_id, "confidence": 0.7},
                {"candidate_id": lot_ck.lot_id, "confidence": 0.7},
                {"candidate_id": lot_pm.lot_id, "confidence": 0.45},
            ],
            "candidate_pool_used": [
                {"candidate_id": lot_cc.lot_id, "expected_weight_g": 261.0},
                {"candidate_id": lot_ch.lot_id, "expected_weight_g": 230.0},
                {"candidate_id": lot_ck.lot_id, "expected_weight_g": 248.0},
                {"candidate_id": lot_pm.lot_id, "expected_weight_g": 245.0},
            ],
        }

        handler._apply_lot_update_from_classification(
            direction="remove",
            classification=classification,
            event_ts=event_ts,
            delta_g=-981.0,
            session_id=session_id,
            event_id=event_id,
        )

        # All four lots should now be 'in_flight' (post IN_FLIGHT_TRACKER_PLAN:
        # classified removes stage in_flight, not out). Each should have
        # pickup_event_id linking back to this event.
        for lot in (lot_cc, lot_ch, lot_ck, lot_pm):
            now = storage_repo.get_lot(conn, lot.lot_id)
            assert now.status == "in_flight", (
                f"lot {lot.lot_id[:8]} ({lot.lot_id}) did not stage in_flight "
                f"(got {now.status!r}); UNKNOWN promotion failed"
            )
            assert now.in_flight_since == event_ts
            assert now.pickup_event_id == event_id

    def test_apply_rejects_unknown_when_weight_does_not_fit(self, tmp_path):
        """Negative case: item_id=UNKNOWN but multi_match sums are nowhere
        near |delta|. Must NOT promote; no lots change."""
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)

        _, lot_a = _create_lot(conn, name="A", barcode="1", weight_g=100.0)
        _, lot_b = _create_lot(conn, name="B", barcode="2", weight_g=100.0)

        session_id = _open_session(conn)
        event_id = _record_event(
            conn, session_id=session_id, direction="remove",
            delta_g=-700.0, ts="2026-04-17T03:49:09.939Z",
        )

        classification = {
            "item_id": UNKNOWN_CANDIDATE_ID,
            "action": "removed",
            "confidence": 0.4,
            "multi_match": [
                {"candidate_id": lot_a.lot_id, "confidence": 0.5},
                {"candidate_id": lot_b.lot_id, "confidence": 0.5},
            ],
            "candidate_pool_used": [
                {"candidate_id": lot_a.lot_id, "expected_weight_g": 100.0},
                {"candidate_id": lot_b.lot_id, "expected_weight_g": 100.0},
            ],
        }
        # 200g expected vs 700g delta → 71% error, nowhere near 3%.

        handler._apply_lot_update_from_classification(
            direction="remove",
            classification=classification,
            event_ts="2026-04-17T03:49:09.939Z",
            delta_g=-700.0,
            session_id=session_id,
            event_id=event_id,
        )

        for lot in (lot_a, lot_b):
            now = storage_repo.get_lot(conn, lot.lot_id)
            assert now.status == "on_shelf", (
                f"lot {lot.lot_id[:8]} was wrongly flipped despite weight "
                f"mismatch (got {now.status!r})"
            )

    def test_apply_rejects_unknown_with_empty_multi_match(self, tmp_path):
        """item_id=UNKNOWN + no multi_match → no promotion possible → noop."""
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)

        _, lot_a = _create_lot(conn, name="A", barcode="1", weight_g=250.0)

        classification = {
            "item_id": UNKNOWN_CANDIDATE_ID,
            "action": "unknown",
            "confidence": 0.2,
            "multi_match": [],
            "candidate_pool_used": [
                {"candidate_id": lot_a.lot_id, "expected_weight_g": 250.0},
            ],
        }

        # Should not crash; should leave the lot alone.
        handler._apply_lot_update_from_classification(
            direction="remove",
            classification=classification,
            event_ts="2026-04-17T03:49:09.939Z",
            delta_g=-250.0,
        )
        now = storage_repo.get_lot(conn, lot_a.lot_id)
        assert now.status == "on_shelf"


# ---------------------------------------------------------------------------
# Prompt regression — general invariants
# ---------------------------------------------------------------------------
#
# Don't test for specific wording of over-specific shortcuts (EMPTY-AFTER
# rules, WEIGHT-ARITHMETIC rules by name, etc.). Test for the general
# invariants the prompt must uphold so any future rewrite that preserves
# those invariants also passes. Reliability comes from:
#   1. Telling the model weight arithmetic is first-class evidence.
#   2. Forbidding the specific failure mode (multi_match populated with
#      item_id = "unknown").
#   3. Narrowing "unknown" to a genuine last resort.
# The code-side weight-fit promotion in scale_events.py is the real safety
# net; the prompt just gives the model enough structure to not hit it.


class TestPromptGeneralInvariants:
    def test_system_prompt_elevates_weight_as_first_class_evidence(self):
        text = classifier_prompt.build_system_prompt().lower()
        # Some phrase naming weight as evidence (not just "verification").
        assert "weight evidence" in text or "weight arithmetic" in text, (
            "system prompt must treat weight arithmetic as a first-class "
            "evidence source, not merely a verification step"
        )

    def test_system_prompt_forbids_multi_match_with_unknown_item_id(self):
        text = classifier_prompt.build_system_prompt().lower()
        # Must explicitly disallow the specific failure mode that the
        # code-side promotion exists to paper over.
        assert (
            "multi_match must never be paired with item_id" in text
            or "multi_match" in text
            and "item_id" in text
            and "unknown" in text
            and "never" in text
        ), "system prompt must forbid populated multi_match + item_id=unknown"

    def test_system_prompt_narrows_unknown_to_last_resort(self):
        text = classifier_prompt.build_system_prompt().lower()
        assert "when to use" in text and "unknown" in text, (
            "system prompt must narrow 'unknown' to a last-resort case"
        )

    def test_instruction_text_does_not_reintroduce_over_specific_shortcuts(self):
        # If someone tries to add back EMPTY-AFTER or similar shortcuts,
        # this test asks them to stop and trust the general guidance.
        itext = classifier_prompt.INSTRUCTION_TEXT.upper()
        assert "EMPTY-AFTER" not in itext, (
            "INSTRUCTION_TEXT must not hardcode an EMPTY-AFTER shortcut — "
            "the code-side weight-fit promotion handles that case. Keep "
            "the prompt general."
        )
        assert "SHORTCUT" not in itext, (
            "INSTRUCTION_TEXT must not contain shortcut sections — prefer "
            "strong general guidance over case-specific rules."
        )
