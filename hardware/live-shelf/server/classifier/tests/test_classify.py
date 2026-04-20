"""Tests for the top-level classifier orchestration (plan §4.5)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from server.classifier.anthropic_client import ClassifierCallResult
from server.classifier.classify import (
    MalformedClassifierOutput,
    _extract_json,
    classify_event,
    parse_response,
)
from server.classifier.models import (
    UNKNOWN_CANDIDATE_ID,
    ClassificationResult,
    ClassifierContext,
    LotCandidate,
    ScaleEvent,
)


# --- Shared fixtures / stubs ----------------------------------------------

_TINY_JPEG = bytes.fromhex("FFD8FFE000104A4649460001010000480048000000FFD9")


@pytest.fixture
def frame_paths(tmp_path: Path) -> tuple[str, str]:
    before = tmp_path / "before.jpg"
    after = tmp_path / "after.jpg"
    before.write_bytes(_TINY_JPEG)
    after.write_bytes(_TINY_JPEG)
    return str(before), str(after)


class StubSource:
    def __init__(self, *, on_shelf=(), recently_out=(), catalog=()) -> None:
        self._on_shelf = list(on_shelf)
        self._recently_out = list(recently_out)
        self._catalog = list(catalog)

    def get_on_shelf_lots(self):
        return list(self._on_shelf)

    def get_recently_out_lots(self, window_seconds: int):
        return list(self._recently_out)

    def get_certified_not_on_shelf(self):
        return list(self._catalog)


class FakeClient:
    """Mimics :class:`AnthropicClassifierClient` — only ``.send`` is used."""

    def __init__(self, responses: list[Any]) -> None:
        # Each entry is either a string (text reply), a ClassifierCallResult,
        # or an Exception instance to raise.
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def send(self, payload: dict[str, Any], *, model: str | None = None) -> ClassifierCallResult:
        self.calls.append({"payload": payload, "model": model})
        if not self._responses:
            raise AssertionError("FakeClient: out of scripted responses")
        response = self._responses.pop(0)
        if isinstance(response, Exception):
            raise response
        if isinstance(response, ClassifierCallResult):
            return response
        return ClassifierCallResult(
            text=response,
            model=model or "claude-sonnet-4-6",
            usage={"input_tokens": 100, "output_tokens": 20},
            raw=None,
        )


def _lot(lot_id: str, *, name: str, weight: float) -> LotCandidate:
    return LotCandidate(
        lot_id=lot_id,
        product_id=f"prod_{lot_id}",
        name=name,
        brand=None,
        expected_weight_g=weight,
        container_type="bottle",
        status="on_shelf",
        reference_image_paths=(),
    )


def _event(before: str, after: str, *, direction="remove", delta=-340.0) -> ScaleEvent:
    return ScaleEvent(
        event_id="evt_1",
        session_id="sesn_1",
        ts="2026-04-15T12:00:00.000Z",
        delta_g=delta,
        before_weight_g=2000.0,
        after_weight_g=2000.0 + delta,
        direction=direction,  # type: ignore[arg-type]
        before_frame_path=before,
        after_frame_path=after,
    )


# --- JSON extraction ------------------------------------------------------


class TestJsonExtraction:
    def test_plain_json_passthrough(self):
        text = '{"item_id": "L1"}'
        assert _extract_json(text) == text

    def test_strips_code_fences(self):
        text = '```json\n{"item_id": "L1"}\n```'
        assert _extract_json(text) == '{"item_id": "L1"}'

    def test_strips_bare_code_fences(self):
        text = '```\n{"item_id": "L1"}\n```'
        assert _extract_json(text) == '{"item_id": "L1"}'

    def test_extracts_json_from_preamble_and_trailing_text(self):
        text = 'Here is my answer: {"item_id": "L1", "action": "removed"}.'
        assert _extract_json(text) == '{"item_id": "L1", "action": "removed"}'

    def test_empty_text_raises(self):
        with pytest.raises(MalformedClassifierOutput):
            _extract_json("")

    def test_no_braces_raises(self):
        with pytest.raises(MalformedClassifierOutput):
            _extract_json("the answer is L1")


# --- Response parsing -----------------------------------------------------


class TestParseResponse:
    def test_minimal_valid_json(self):
        result = parse_response(
            json.dumps(
                {
                    "item_id": "L1",
                    "action": "removed",
                    "confidence": 0.9,
                    "reasoning": "Position in before but absent in after.",
                }
            ),
            candidate_pool_used=[],
        )
        assert isinstance(result, ClassificationResult)
        assert result.item_id == "L1"
        assert result.action == "removed"
        assert result.confidence == pytest.approx(0.9)
        assert result.reasoning.startswith("Position")

    def test_confidence_clamped(self):
        result = parse_response(
            json.dumps(
                {
                    "item_id": "L1",
                    "action": "added",
                    "confidence": 95,
                    "reasoning": "n/a",
                }
            ),
            candidate_pool_used=[],
        )
        assert result.confidence == 1.0  # clamped

    def test_multi_match_for_remove(self):
        result = parse_response(
            json.dumps(
                {
                    "item_id": "L1",
                    "action": "removed",
                    "confidence": 0.8,
                    "reasoning": "Two items",
                    "multi_match": [
                        {"candidate_id": "L1", "confidence": 0.8},
                        {"candidate_id": "L2", "confidence": 0.7},
                    ],
                }
            ),
            candidate_pool_used=[],
        )
        assert len(result.multi_match) == 2
        assert result.multi_match[0].candidate_id == "L1"
        assert result.multi_match[1].confidence == pytest.approx(0.7)

    def test_secondary_candidates_for_add(self):
        result = parse_response(
            json.dumps(
                {
                    "item_id": "L1",
                    "action": "added",
                    "confidence": 0.8,
                    "reasoning": "...",
                    "secondary_candidates": [
                        {"candidate_id": "L2", "confidence": 0.1}
                    ],
                }
            ),
            candidate_pool_used=[],
        )
        assert len(result.secondary_candidates) == 1
        assert result.secondary_candidates[0].candidate_id == "L2"

    def test_missing_item_id_rejected(self):
        with pytest.raises(MalformedClassifierOutput):
            parse_response(
                json.dumps({"action": "removed", "confidence": 0.5, "reasoning": ""}),
                candidate_pool_used=[],
            )

    def test_invalid_action_rejected(self):
        with pytest.raises(MalformedClassifierOutput):
            parse_response(
                json.dumps(
                    {
                        "item_id": "L1",
                        "action": "deleted",
                        "confidence": 0.5,
                        "reasoning": "",
                    }
                ),
                candidate_pool_used=[],
            )

    def test_non_numeric_confidence_rejected(self):
        with pytest.raises(MalformedClassifierOutput):
            parse_response(
                json.dumps(
                    {
                        "item_id": "L1",
                        "action": "removed",
                        "confidence": "high",
                        "reasoning": "",
                    }
                ),
                candidate_pool_used=[],
            )

    def test_malformed_json_rejected(self):
        with pytest.raises(MalformedClassifierOutput):
            parse_response("not json at all", candidate_pool_used=[])

    def test_non_object_top_level_rejected(self):
        with pytest.raises(MalformedClassifierOutput):
            parse_response('["L1"]', candidate_pool_used=[])


# --- End-to-end classify_event -------------------------------------------


class TestClassifyEvent:
    def test_valid_response_returns_parsed_result(self, frame_paths):
        before, after = frame_paths
        source = StubSource(on_shelf=[_lot("L1", name="Ketchup", weight=340)])
        response_text = json.dumps(
            {
                "item_id": "L1",
                "action": "removed",
                "confidence": 0.92,
                "reasoning": "Gone from before to after; weight matches.",
            }
        )
        client = FakeClient([response_text])
        ctx = ClassifierContext(source=source, anthropic_client=client)
        event = _event(before, after, direction="remove", delta=-340.0)

        result = classify_event(event, ctx)
        assert result.item_id == "L1"
        assert result.action == "removed"
        assert result.confidence == pytest.approx(0.92)
        assert client.calls, "FakeClient should have been called at least once"
        assert result.candidate_pool_used  # populated for audit

    def test_malformed_output_retries_once_then_succeeds(self, frame_paths):
        before, after = frame_paths
        source = StubSource(on_shelf=[_lot("L1", name="Ketchup", weight=340)])
        good = json.dumps(
            {
                "item_id": "L1",
                "action": "removed",
                "confidence": 0.8,
                "reasoning": "ok",
            }
        )
        client = FakeClient(["not json", good])
        ctx = ClassifierContext(source=source, anthropic_client=client)
        event = _event(before, after)

        result = classify_event(event, ctx)
        assert result.item_id == "L1"
        assert len(client.calls) == 2

    def test_two_malformed_outputs_return_unknown_fallback(self, frame_paths):
        before, after = frame_paths
        source = StubSource(on_shelf=[_lot("L1", name="Ketchup", weight=340)])
        client = FakeClient(["not json", "also not json"])
        ctx = ClassifierContext(source=source, anthropic_client=client)
        event = _event(before, after)

        result = classify_event(event, ctx)
        assert result.item_id == UNKNOWN_CANDIDATE_ID
        assert result.action == "unknown"
        assert result.confidence == 0.0
        assert result.reasoning == "Malformed model output"
        assert len(client.calls) == 2

    def test_api_error_returns_unknown_without_retry(self, frame_paths):
        before, after = frame_paths
        source = StubSource(on_shelf=[_lot("L1", name="Ketchup", weight=340)])
        client = FakeClient([RuntimeError("network down")])
        ctx = ClassifierContext(source=source, anthropic_client=client)
        event = _event(before, after)

        result = classify_event(event, ctx)
        assert result.item_id == UNKNOWN_CANDIDATE_ID
        assert result.action == "unknown"
        assert "network down" in result.reasoning
        assert len(client.calls) == 1  # no retry on transport errors

    def test_empty_remove_pool_returns_unknown(self, frame_paths):
        before, after = frame_paths
        source = StubSource()  # nothing on the shelf
        client = FakeClient([])  # should never be called
        ctx = ClassifierContext(source=source, anthropic_client=client)
        event = _event(before, after, direction="remove", delta=-100.0)

        result = classify_event(event, ctx)
        assert result.item_id == UNKNOWN_CANDIDATE_ID
        assert result.action == "unknown"
        assert client.calls == []

    def test_unknown_item_id_normalised_to_sentinel(self, frame_paths):
        before, after = frame_paths
        source = StubSource(on_shelf=[_lot("L1", name="Ketchup", weight=340)])
        response_text = json.dumps(
            {
                "item_id": "unknown",  # lowercase variant
                "action": "unknown",
                "confidence": 0.0,
                "reasoning": "Could not tell.",
            }
        )
        client = FakeClient([response_text])
        ctx = ClassifierContext(source=source, anthropic_client=client)
        event = _event(before, after)

        result = classify_event(event, ctx)
        assert result.item_id == UNKNOWN_CANDIDATE_ID

    def test_pool_passes_direction_correctly(self, frame_paths):
        before, after = frame_paths
        # Add event → should see a catalog-not-on-shelf candidate + sentinel,
        # not an on-shelf lot.
        from server.classifier.models import ProductCandidate

        product = ProductCandidate(
            product_id="PROD_MAYO",
            name="Mayonnaise",
            brand=None,
            expected_weight_g=450,
            container_type="jar",
            reference_image_paths=(),
        )
        source = StubSource(catalog=[product])
        response_text = json.dumps(
            {
                "item_id": "PROD_MAYO",
                "action": "added",
                "confidence": 0.88,
                "reasoning": "New jar appeared in after frame.",
            }
        )
        client = FakeClient([response_text])
        ctx = ClassifierContext(source=source, anthropic_client=client)
        event = _event(before, after, direction="add", delta=450.0)

        result = classify_event(event, ctx)
        assert result.item_id == "PROD_MAYO"
        # Verify the pool included the sentinel (ADD path) and the product.
        ids = {c.candidate_id for c in result.candidate_pool_used}
        assert UNKNOWN_CANDIDATE_ID in ids
        assert "PROD_MAYO" in ids

    def test_model_override_forwarded_to_client(self, frame_paths):
        before, after = frame_paths
        source = StubSource(on_shelf=[_lot("L1", name="Ketchup", weight=340)])
        client = FakeClient(
            [
                json.dumps(
                    {
                        "item_id": "L1",
                        "action": "removed",
                        "confidence": 0.9,
                        "reasoning": "ok",
                    }
                )
            ]
        )
        ctx = ClassifierContext(source=source, anthropic_client=client)
        event = _event(before, after)

        classify_event(event, ctx, model="claude-haiku-4-5")
        assert client.calls[0]["model"] == "claude-haiku-4-5"


# --- Cold-start guard (deep-audit findings #6 + #7) -----------------------


class TestColdStartGuard:
    """The cold-start guard short-circuits classify_event to UNKNOWN
    when the candidate source isn't ready (e.g. cloud catalog never
    fetched). Two audit findings:
      * #6 — if ``has_catalog()`` raises, the guard previously returned
        False (treat as ready) which bypassed the short-circuit and
        sent the event into the classifier with a broken source. The
        fix flips to True (treat as cold).
      * #7 — the cold-start WARNING now rate-limits to one-per-process
        so a Pi that boots offline for hundreds of events doesn't
        flood the log.
    """

    def test_has_catalog_exception_treated_as_cold(self, frame_paths):
        """Finding #6: exception in has_catalog() → classifier
        short-circuits to UNKNOWN rather than sending a broken source
        downstream."""
        from server.classifier.classify import reset_cold_start_warn_state
        reset_cold_start_warn_state()  # isolate from other tests
        before, after = frame_paths

        class _BrokenSource:
            def has_catalog(self) -> bool:
                raise RuntimeError("catalog query failed")

            def get_on_shelf_lots(self):
                # Must not be reached — the guard should short-circuit
                # BEFORE pool assembly.
                raise AssertionError(
                    "get_on_shelf_lots was called; cold-start guard "
                    "didn't fire"
                )

            def get_recently_out_lots(self, window_seconds):
                raise AssertionError("get_recently_out_lots was called")

            def get_certified_not_on_shelf(self):
                raise AssertionError("get_certified_not_on_shelf was called")

        class _ExplodeClient:
            def send(self, *args, **kwargs):
                raise AssertionError(
                    "Anthropic must not be called during cold start"
                )

        ctx = ClassifierContext(
            source=_BrokenSource(),
            anthropic_client=_ExplodeClient(),
        )
        event = _event(before, after)
        result = classify_event(event, ctx)
        assert result.item_id == UNKNOWN_CANDIDATE_ID
        assert result.action == "unknown"
        assert result.meta.get("cold_start") is True

    def test_cold_start_warn_fires_once_per_process(
        self, frame_paths, caplog
    ):
        """Finding #7: first cold-start event WARNs; subsequent events
        drop to DEBUG until the catalog is fetched. A Pi booting
        offline through 50 scale events must not flood the log."""
        import logging
        from server.classifier.classify import reset_cold_start_warn_state
        reset_cold_start_warn_state()
        before, after = frame_paths

        class _ColdSource:
            def has_catalog(self) -> bool:
                return False

            def get_on_shelf_lots(self):  # pragma: no cover - not reached
                return []

            def get_recently_out_lots(self, window_seconds):  # pragma: no cover
                return []

            def get_certified_not_on_shelf(self):  # pragma: no cover
                return []

        ctx = ClassifierContext(source=_ColdSource())
        event = _event(before, after)

        with caplog.at_level(logging.DEBUG, logger="server.classifier.classify"):
            classify_event(event, ctx)
            classify_event(event, ctx)
            classify_event(event, ctx)

        warn_records = [
            r for r in caplog.records
            if r.name == "server.classifier.classify"
            and r.levelname == "WARNING"
            and "cold-start guard" in r.message
        ]
        debug_records = [
            r for r in caplog.records
            if r.name == "server.classifier.classify"
            and r.levelname == "DEBUG"
            and "cold-start (suppressed)" in r.message
        ]
        assert len(warn_records) == 1  # only the first event
        assert len(debug_records) == 2  # the next two

    def test_reset_after_warm_classify_re_arms_warning(
        self, frame_paths, caplog
    ):
        """If the source goes cold → warm → cold again, a fresh WARNING
        must fire on the second cold event. The module's
        ``classify_event`` does the reset inline for us when it
        observes a non-cold source on a later call."""
        import logging
        from server.classifier.classify import reset_cold_start_warn_state
        reset_cold_start_warn_state()
        before, after = frame_paths

        # Start cold, then transition to warm (real ``has_catalog``
        # controlled by a mutable flag).
        state = {"cold": True}

        class _FlipFlopSource:
            def has_catalog(self) -> bool:
                return not state["cold"]

            def get_on_shelf_lots(self):
                return [_lot("L1", name="K", weight=340)]

            def get_recently_out_lots(self, window_seconds):
                return []

            def get_certified_not_on_shelf(self):
                return []

        warm_response = json.dumps({
            "item_id": "L1", "action": "removed",
            "confidence": 0.9, "reasoning": "ok",
        })
        client = FakeClient([warm_response])
        ctx = ClassifierContext(
            source=_FlipFlopSource(), anthropic_client=client,
        )
        event = _event(before, after)

        with caplog.at_level(logging.DEBUG, logger="server.classifier.classify"):
            classify_event(event, ctx)  # cold → WARN (1st)
            state["cold"] = False
            classify_event(event, ctx)  # warm → reset flag
            state["cold"] = True
            classify_event(event, ctx)  # cold again → WARN (2nd)

        warn_records = [
            r for r in caplog.records
            if r.name == "server.classifier.classify"
            and r.levelname == "WARNING"
            and "cold-start guard" in r.message
        ]
        assert len(warn_records) == 2


# --- Integration (opt-in) -------------------------------------------------


@pytest.mark.skipif(
    not __import__("os").environ.get("ANTHROPIC_API_KEY"),
    reason="No ANTHROPIC_API_KEY — skipping live-API smoke test",
)
def test_live_anthropic_smoke(frame_paths):
    """Optional smoke test — only runs when ANTHROPIC_API_KEY is set.

    This is deliberately a trivial sanity check: we pass an obvious scenario
    and confirm the classifier returns *some* well-formed result. We do not
    assert on the content because real model responses vary.
    """

    before, after = frame_paths
    source = StubSource(on_shelf=[_lot("L1", name="Ketchup", weight=340)])
    ctx = ClassifierContext(source=source)
    event = _event(before, after, direction="remove", delta=-340.0)
    result = classify_event(event, ctx)
    assert isinstance(result, ClassificationResult)
    assert result.action in {"removed", "added", "added_to_existing", "unknown"}
