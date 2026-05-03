"""Unit tests for the opt-in classifier fallback (pass-2).

Covers the six scenarios from the task brief:

  1. Pass-1 high confidence → no pass-2.
  2. Pass-1 UNKNOWN + fallback OFF → no pass-2, returns UNKNOWN.
  3. Pass-1 UNKNOWN + fallback ON + pass-2 high confidence → pass-2 wins.
  4. Pass-1 UNKNOWN + fallback ON + pass-2 low confidence → final UNKNOWN.
  5. Pass-1 0.7 confidence (below trigger) + fallback ON + pass-2 0.95
     → pass-2 wins.
  6. Pass-1 0.7 confidence + fallback OFF → pass-1 result accepted
     (today's behavior).

Plus a mutation guard: if the fallback branch is removed from
``classify_event_with_fallback`` (the toggle is forced to ``False``
internally), at least one of these tests must fail.

The Anthropic client is mocked. Reference images are tiny in-memory
JPEGs the prompt builder reads with PIL — we provide them via the
``frame_paths`` fixture below.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.classifier.anthropic_client import ClassifierCallResult  # noqa: E402
from server.classifier.fallback import (  # noqa: E402
    FALLBACK_ACCEPT_THRESHOLD,
    FALLBACK_TRIGGER_THRESHOLD,
    classify_event_with_fallback,
)
from server.classifier.models import (  # noqa: E402
    UNKNOWN_CANDIDATE_ID,
    ClassifierContext,
    LotCandidate,
    ProductCandidate,
    ScaleEvent,
)


# --- Shared helpers --------------------------------------------------------

_TINY_JPEG = bytes.fromhex("FFD8FFE000104A4649460001010000480048000000FFD9")


@pytest.fixture
def frame_paths(tmp_path: Path) -> tuple[str, str]:
    before = tmp_path / "before.jpg"
    after = tmp_path / "after.jpg"
    before.write_bytes(_TINY_JPEG)
    after.write_bytes(_TINY_JPEG)
    return str(before), str(after)


def _add_event(before: str, after: str, *, delta: float = 700.0) -> ScaleEvent:
    """Build a representative ADD event (Gatorade-sized weight)."""
    return ScaleEvent(
        event_id="evt_fallback_1",
        session_id="sesn_fallback",
        ts="2026-04-27T12:00:00.000Z",
        delta_g=delta,
        before_weight_g=0.0,
        after_weight_g=delta,
        direction="add",
        before_frame_path=before,
        after_frame_path=after,
    )


class _FakeClient:
    """Anthropic client stub — scripts replies in order."""

    def __init__(self, responses: list[Any]) -> None:
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def send(self, payload: dict[str, Any], *, model: str | None = None) -> ClassifierCallResult:
        self.calls.append({"payload": payload, "model": model})
        if not self._responses:
            raise AssertionError("FakeClient: out of scripted responses")
        nxt = self._responses.pop(0)
        if isinstance(nxt, ClassifierCallResult):
            return nxt
        return ClassifierCallResult(
            text=str(nxt),
            model=model or "claude-sonnet-4-6",
            usage={"input_tokens": 100, "output_tokens": 20},
            raw=None,
        )


class _StubSource:
    """Minimal CandidateSource with optional fallback-pool seed."""

    def __init__(
        self,
        *,
        on_shelf: list[LotCandidate] | None = None,
        recently_out: list[LotCandidate] | None = None,
        in_flight: list[LotCandidate] | None = None,
        inventory_only: list[ProductCandidate] | None = None,
        fallback_pool: list[ProductCandidate] | None = None,
    ) -> None:
        self._on_shelf = on_shelf or []
        self._recently_out = recently_out or []
        self._in_flight = in_flight or []
        self._inventory_only = inventory_only or []
        self._fallback_pool = fallback_pool or []
        self.fallback_pool_calls = 0

    def has_catalog(self) -> bool:
        return True

    def get_on_shelf_lots(self, shelf_id=None):
        return list(self._on_shelf)

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return list(self._recently_out)

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return list(self._in_flight)

    def get_inventory_only_products(self, shelf_id=None):
        return list(self._inventory_only)

    def get_certified_not_on_shelf(self):
        return []

    def get_certified_livetrack_tracked(self):
        self.fallback_pool_calls += 1
        return list(self._fallback_pool)


def _gatorade() -> ProductCandidate:
    return ProductCandidate(
        product_id="prod_gatorade",
        name="Gatorade Lemon-Lime",
        brand="Gatorade",
        expected_weight_g=700.0,
        container_type="bottle",
        reference_image_paths=(),
    )


def _success_response(*, item_id: str, confidence: float, action: str = "added") -> str:
    """JSON shape the classifier expects from Anthropic."""
    import json

    return json.dumps(
        {
            "item_id": item_id,
            "action": action,
            "confidence": confidence,
            "reasoning": "stub",
        }
    )


# --- 1. Pass-1 confident → no pass-2 ---------------------------------------


class TestNoFallbackWhenPass1Confident:
    def test_pass1_high_confidence_skips_pass2(self, frame_paths) -> None:
        before, after = frame_paths
        client = _FakeClient([_success_response(item_id="prod_existing", confidence=0.95)])
        source = _StubSource(fallback_pool=[_gatorade()])
        ctx = ClassifierContext(source=source, anthropic_client=client)

        result = classify_event_with_fallback(
            _add_event(before, after), ctx, fallback_enabled=True,
        )

        assert result.item_id == "prod_existing"
        assert result.confidence == pytest.approx(0.95)
        # Only ONE Anthropic call — pass-2 was skipped.
        assert len(client.calls) == 1
        # Audit fields stamp "no fallback pass attempted."
        assert result.meta.get("fallback_pass_attempted") is False
        # The fallback pool fetcher must NOT have been queried.
        assert source.fallback_pool_calls == 0


# --- 2. Pass-1 UNKNOWN + fallback OFF → no pass-2 --------------------------


class TestFallbackOffPreservesUnknown:
    def test_unknown_with_fallback_off_returns_unknown(self, frame_paths) -> None:
        before, after = frame_paths
        client = _FakeClient(
            [_success_response(item_id="UNKNOWN", confidence=0.1, action="unknown")]
        )
        source = _StubSource(fallback_pool=[_gatorade()])
        ctx = ClassifierContext(source=source, anthropic_client=client)

        result = classify_event_with_fallback(
            _add_event(before, after), ctx, fallback_enabled=False,
        )

        assert result.item_id == UNKNOWN_CANDIDATE_ID
        # No pass-2 → only one Anthropic call.
        assert len(client.calls) == 1
        assert result.meta.get("fallback_pass_attempted") is False


# --- 3. Pass-1 UNKNOWN + fallback ON + pass-2 high → pass-2 wins -----------


class TestFallbackRecoversUnknown:
    def test_pass2_high_confidence_wins_over_unknown(self, frame_paths) -> None:
        before, after = frame_paths
        client = _FakeClient(
            [
                _success_response(item_id="UNKNOWN", confidence=0.1, action="unknown"),
                _success_response(item_id="prod_gatorade", confidence=0.95),
            ]
        )
        source = _StubSource(fallback_pool=[_gatorade()])
        ctx = ClassifierContext(source=source, anthropic_client=client)

        result = classify_event_with_fallback(
            _add_event(before, after), ctx, fallback_enabled=True,
        )

        assert result.item_id == "prod_gatorade"
        assert result.confidence == pytest.approx(0.95)
        # Two Anthropic calls — pass-1 + pass-2.
        assert len(client.calls) == 2
        assert result.meta["fallback_pass_attempted"] is True
        assert result.meta["fallback_pass_used"] is True
        assert result.meta["fallback_pass1_item_id"] == UNKNOWN_CANDIDATE_ID


# --- 4. Pass-1 UNKNOWN + fallback ON + pass-2 LOW → final UNKNOWN ----------


class TestFallbackPass2NotConfident:
    def test_pass2_low_confidence_keeps_unknown(self, frame_paths) -> None:
        before, after = frame_paths
        client = _FakeClient(
            [
                _success_response(item_id="UNKNOWN", confidence=0.1, action="unknown"),
                _success_response(item_id="prod_gatorade", confidence=0.5),
            ]
        )
        source = _StubSource(fallback_pool=[_gatorade()])
        ctx = ClassifierContext(source=source, anthropic_client=client)

        result = classify_event_with_fallback(
            _add_event(before, after), ctx, fallback_enabled=True,
        )

        # Pass-1's UNKNOWN result wins because pass-2's confidence
        # (0.5) is below FALLBACK_ACCEPT_THRESHOLD (0.9).
        assert result.item_id == UNKNOWN_CANDIDATE_ID
        assert len(client.calls) == 2
        assert result.meta["fallback_pass_attempted"] is True
        assert result.meta["fallback_pass_used"] is False


# --- 5. Pass-1 0.7 + fallback ON + pass-2 0.95 → pass-2 wins ---------------


class TestFallbackTriggersOnLowConfidence:
    def test_pass1_below_trigger_runs_pass2(self, frame_paths) -> None:
        before, after = frame_paths
        # Pass-1 below FALLBACK_TRIGGER_THRESHOLD (0.85). Pass-2 above
        # FALLBACK_ACCEPT_THRESHOLD (0.9).
        client = _FakeClient(
            [
                _success_response(item_id="prod_wrong_guess", confidence=0.7),
                _success_response(item_id="prod_gatorade", confidence=0.95),
            ]
        )
        source = _StubSource(fallback_pool=[_gatorade()])
        ctx = ClassifierContext(source=source, anthropic_client=client)

        result = classify_event_with_fallback(
            _add_event(before, after), ctx, fallback_enabled=True,
        )

        assert result.item_id == "prod_gatorade"
        assert result.confidence == pytest.approx(0.95)
        assert len(client.calls) == 2
        assert result.meta["fallback_pass_attempted"] is True
        assert result.meta["fallback_pass_used"] is True
        assert result.meta["fallback_pass1_item_id"] == "prod_wrong_guess"
        assert result.meta["fallback_pass1_confidence"] == pytest.approx(0.7)


# --- 6. Pass-1 0.7 + fallback OFF → pass-1 accepted ------------------------


class TestPass1LowAcceptedWhenFallbackOff:
    def test_pass1_low_confidence_accepted_when_off(self, frame_paths) -> None:
        before, after = frame_paths
        client = _FakeClient(
            [_success_response(item_id="prod_wrong_guess", confidence=0.7)]
        )
        source = _StubSource(fallback_pool=[_gatorade()])
        ctx = ClassifierContext(source=source, anthropic_client=client)

        result = classify_event_with_fallback(
            _add_event(before, after), ctx, fallback_enabled=False,
        )

        # Pass-1's low-confidence result is preserved verbatim — the
        # downstream apply path's review queue handles low-confidence
        # routing. fallback off = no behavior change.
        assert result.item_id == "prod_wrong_guess"
        assert result.confidence == pytest.approx(0.7)
        assert len(client.calls) == 1
        assert result.meta.get("fallback_pass_attempted") is False
        assert source.fallback_pool_calls == 0


# --- 7. Threshold sanity ---------------------------------------------------


class TestThresholds:
    def test_thresholds_are_sane(self) -> None:
        # The brief calls out specific values — pin them so a future
        # accidental change of the constants doesn't slip past CI.
        assert FALLBACK_TRIGGER_THRESHOLD == pytest.approx(0.85)
        assert FALLBACK_ACCEPT_THRESHOLD == pytest.approx(0.9)
        # Accept must be >= trigger so we don't promote borderline
        # pass-2 over borderline pass-1.
        assert FALLBACK_ACCEPT_THRESHOLD >= FALLBACK_TRIGGER_THRESHOLD


# --- 8. Mutation guard: forcing fallback off must break tests ---------------
# This is a meta-test that DOCUMENTS the mutation expectation. Running
# the test suite with classify_event_with_fallback hard-coded to
# ignore fallback_enabled would fail TestFallbackRecoversUnknown +
# TestFallbackTriggersOnLowConfidence. We assert the structure that
# makes that mutation detectable rather than running the mutation
# inline (no orchestration framework here).


class TestMutationDocumentation:
    def test_key_assertions_distinguish_fallback_path(self, frame_paths) -> None:
        """If fallback was a no-op, this scenario would yield UNKNOWN.

        Re-runs scenario #3 inline and asserts the two-Anthropic-call
        invariant. A mutant that strips the fallback branch would
        produce ONE call (pass-1 only) and an UNKNOWN result, which
        would fail both ``assert len(client.calls) == 2`` and
        ``assert result.item_id == "prod_gatorade"``.
        """
        before, after = frame_paths
        client = _FakeClient(
            [
                _success_response(item_id="UNKNOWN", confidence=0.1, action="unknown"),
                _success_response(item_id="prod_gatorade", confidence=0.95),
            ]
        )
        source = _StubSource(fallback_pool=[_gatorade()])
        ctx = ClassifierContext(source=source, anthropic_client=client)

        result = classify_event_with_fallback(
            _add_event(before, after), ctx, fallback_enabled=True,
        )

        # Two distinct invariants — drop the branch and BOTH break.
        assert len(client.calls) == 2, (
            "fallback branch missing — only pass-1 ran"
        )
        assert result.item_id == "prod_gatorade", (
            "fallback branch missing — pass-1 UNKNOWN was kept"
        )


# --- 9. Field preservation: estimated_tare_g must thread through ----------
# Regression guard for the Task 7 reviewer's catch: the two
# reconstruction sites (pass-2 wins + _stamp_meta) used to enumerate
# fields manually and silently dropped any field added later. Task 8
# starts consuming ``ClassificationResult.estimated_tare_g`` to seed
# the per-product tare on first sighting, so any drop in the fallback
# path is silent data loss for fallback-enabled users.
#
# These tests pin the contract: fields on the source result MUST
# survive the reconstruction. We use ``estimated_tare_g`` because it's
# the field the reviewer flagged, but the assertion shape is generic
# enough to also fail for any future field that's silently stripped.


def _success_response_with_tare(
    *, item_id: str, confidence: float, tare: float, action: str = "added"
) -> str:
    """Same shape as ``_success_response`` plus ``estimated_tare_g``."""
    import json

    return json.dumps(
        {
            "item_id": item_id,
            "action": action,
            "confidence": confidence,
            "reasoning": "stub-with-tare",
            "estimated_tare_g": tare,
        }
    )


class TestFieldPreservationThroughReconstruction:
    def test_pass2_wins_preserves_estimated_tare_g(self, frame_paths) -> None:
        """When fallback pass-2 supersedes pass-1, the new
        ClassificationResult must carry the estimated_tare_g from pass-2.

        Bug: per-field manual reconstruction at the pass-2-wins site
        silently dropped this field for every fallback-enabled user.
        Caught by Task 7 reviewer; Task 8 will consume this field to
        seed per-product tare on first sighting, so a silent drop is
        silent data loss in production.
        """
        before, after = frame_paths
        # Pass-1 UNKNOWN, pass-2 wins with high confidence + tare.
        client = _FakeClient(
            [
                _success_response(item_id="UNKNOWN", confidence=0.1, action="unknown"),
                _success_response_with_tare(
                    item_id="prod_gatorade", confidence=0.95, tare=28.5,
                ),
            ]
        )
        source = _StubSource(fallback_pool=[_gatorade()])
        ctx = ClassifierContext(source=source, anthropic_client=client)

        result = classify_event_with_fallback(
            _add_event(before, after), ctx, fallback_enabled=True,
        )

        # Sanity: pass-2 actually won.
        assert result.item_id == "prod_gatorade"
        assert result.meta["fallback_pass_used"] is True
        # The bug: estimated_tare_g would be None here pre-fix because
        # the manual ClassificationResult(...) reconstruction omitted it.
        assert result.estimated_tare_g == pytest.approx(28.5), (
            "pass-2-wins reconstruction stripped estimated_tare_g — "
            "use dataclasses.replace so new fields thread through "
            "automatically."
        )

    def test_stamp_meta_preserves_estimated_tare_g_on_pass1_high_confidence(
        self, frame_paths,
    ) -> None:
        """_stamp_meta must not strip estimated_tare_g when stamping
        audit fields onto a result.

        Pass-1 high-confidence path: pass-1 returns a tare estimate,
        no pass-2 runs, but ``_stamp_meta`` still rebuilds the result
        to add ``fallback_pass_attempted=False``. The rebuild must
        preserve every field on the source result.
        """
        before, after = frame_paths
        client = _FakeClient(
            [
                _success_response_with_tare(
                    item_id="prod_existing", confidence=0.95, tare=42.0,
                ),
            ]
        )
        source = _StubSource(fallback_pool=[_gatorade()])
        ctx = ClassifierContext(source=source, anthropic_client=client)

        result = classify_event_with_fallback(
            _add_event(before, after), ctx, fallback_enabled=True,
        )

        # Sanity: pass-2 did NOT run (pass-1 was confident).
        assert result.meta["fallback_pass_attempted"] is False
        # The bug: _stamp_meta's manual reconstruction stripped this
        # field, so apply-path code reading result.estimated_tare_g
        # silently saw None for fallback-enabled users.
        assert result.estimated_tare_g == pytest.approx(42.0), (
            "_stamp_meta stripped estimated_tare_g — use "
            "dataclasses.replace so new fields thread through "
            "automatically."
        )

    def test_stamp_meta_preserves_estimated_tare_g_on_pass2_rejected(
        self, frame_paths,
    ) -> None:
        """_stamp_meta also runs when pass-2 is attempted-but-rejected
        (low-confidence or empty pool). The pass-1 result's tare must
        still survive that reconstruction.

        This exercises a different ``_stamp_meta`` callsite than the
        high-confidence test — pass-1 has tare AND fallback_pass_used
        gets stamped to False, so it covers the
        ``fallback_pass_attempted=True, fallback_pass_used=False``
        branch.
        """
        before, after = frame_paths
        # Pass-1 returns low confidence with a tare estimate.
        # Pass-2 returns gatorade but with low confidence — gets rejected.
        # Result: pass-1 wins, but flows through _stamp_meta with
        # extra audit fields.
        client = _FakeClient(
            [
                _success_response_with_tare(
                    item_id="prod_pass1", confidence=0.3, tare=15.0,
                ),
                _success_response(item_id="prod_gatorade", confidence=0.5),
            ]
        )
        source = _StubSource(fallback_pool=[_gatorade()])
        ctx = ClassifierContext(source=source, anthropic_client=client)

        result = classify_event_with_fallback(
            _add_event(before, after), ctx, fallback_enabled=True,
        )

        # Sanity: pass-2 ran but lost.
        assert result.item_id == "prod_pass1"
        assert result.meta["fallback_pass_attempted"] is True
        assert result.meta["fallback_pass_used"] is False
        # Pass-1's tare must survive _stamp_meta reconstruction.
        assert result.estimated_tare_g == pytest.approx(15.0), (
            "_stamp_meta (pass-2-rejected branch) stripped "
            "estimated_tare_g — use dataclasses.replace so new fields "
            "thread through automatically."
        )
