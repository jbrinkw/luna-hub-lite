"""Tests for the catch-all single-frame classifier prompt.

The catch-all countertop scale is a single-moment event, not a
before/after delta. The shelf prompt frames the task as "what changed
between two frames given a weight delta" — wrong cognitive frame for
catch-all, where the user just placed one item and the system needs
to identify it from a single image.

These tests pin three contracts:

  1. Prompt content — the catch-all system prompt + instruction text
     reflect the single-frame, visual-primary framing (no before/after
     references, no multi_match math, no delta-comparison vocabulary).
     Mutation guard: replacing CATCH_ALL_SYSTEM_PROMPT with the shelf
     SYSTEM_PROMPT flips these text-content assertions.

  2. Payload structure — the catch-all payload sends ONE image (the
     after frame), uses ``CATCH_ALL_INSTRUCTION_TEXT``, and DOES NOT
     include a "[above: before frame]" caption. Mutation guard:
     swapping in the shelf builder produces 2 images + the wrong
     caption.

  3. Dispatcher routing — ``classify_event`` picks the catch-all
     payload builder when ``ctx.shelf_id == 'catch_all'`` and the
     shelf builder otherwise. Mutation guard: dropping the
     ``getattr(ctx, 'shelf_id')`` check routes catch-all events
     through the shelf prompt — the test inspects what was actually
     sent and flips.

The user pointed at production event ``7f5bee47`` whose classifier
reasoning included shelf-flavored "65% of catalog weight" math —
clear evidence the wrong prompt was being used. These tests close
that gap.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from server.classifier.anthropic_client import ClassifierCallResult
from server.classifier.classify import classify_event
from server.classifier.models import (
    Candidate,
    ClassifierContext,
    LotCandidate,
    ScaleEvent,
    UNKNOWN_CANDIDATE_ID,
)
from server.classifier.prompt import (
    CATCH_ALL_INSTRUCTION_TEXT,
    CATCH_ALL_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    build_catch_all_messages_payload,
    build_catch_all_system_prompt,
    build_messages_payload,
)


# Minimal valid JPEG header + end marker. The classifier doesn't decode.
_TINY_JPEG = bytes.fromhex("FFD8FFE000104A4649460001010000480048000000FFD9")


@pytest.fixture
def after_frame_path(tmp_path: Path) -> str:
    """A single after.jpg — catch-all events have no before frame."""
    p = tmp_path / "after.jpg"
    p.write_bytes(_TINY_JPEG)
    return str(p)


def _catch_all_event(after: str, *, delta_g: float = 240.0) -> ScaleEvent:
    """Catch-all event: positive delta, after_weight==delta (placed on
    empty scale), before_frame_path=None (single-frame model)."""
    return ScaleEvent(
        event_id="evt_catch_all_1",
        session_id=None,
        ts="2026-04-28T12:00:00.000Z",
        delta_g=delta_g,
        before_weight_g=0.0,
        after_weight_g=delta_g,
        direction="add",
        before_frame_path=None,
        after_frame_path=after,
    )


def _candidate(cid: str, *, name: str = "Soda 12oz",
               weight: float | None = 355.0,
               why: str = "inventory_only") -> Candidate:
    return Candidate(
        candidate_id=cid,
        name=name,
        brand=None,
        expected_weight_g=weight,
        container_type="can",
        why_candidate=why,  # type: ignore[arg-type]
        reference_image_paths=(),
    )


# ---------------------------------------------------------------------------
# Prompt content — the catch-all prompt is NOT the shelf prompt
# ---------------------------------------------------------------------------


class TestCatchAllSystemPrompt:
    def test_catch_all_prompt_is_distinct_from_shelf_prompt(self):
        """The two prompts must not be the same string. If a future
        refactor accidentally reuses SYSTEM_PROMPT for catch-all
        (e.g. ``CATCH_ALL_SYSTEM_PROMPT = SYSTEM_PROMPT``) this flips.
        """
        assert CATCH_ALL_SYSTEM_PROMPT != SYSTEM_PROMPT
        assert build_catch_all_system_prompt() == CATCH_ALL_SYSTEM_PROMPT

    def test_catch_all_prompt_describes_single_frame_input(self):
        """Mentions a single image / single moment — not before/after."""
        prompt = CATCH_ALL_SYSTEM_PROMPT
        assert "SINGLE image" in prompt or "single image" in prompt.lower()
        assert "single-moment" in prompt.lower() or "one image" in prompt.lower()

    def test_catch_all_prompt_does_not_use_shelf_delta_vocabulary(self):
        """No 'before frame' / 'after frame' / 'multi_match' references —
        those are shelf-event concepts that don't apply to catch-all.

        Mutation guard: copy-pasting SYSTEM_PROMPT into the catch-all
        slot would re-introduce these phrases — assertion flips.
        """
        prompt = CATCH_ALL_SYSTEM_PROMPT
        # Shelf prompt talks about "before and after" extensively.
        # Catch-all prompt may NEGATE that framing ("not a before/after
        # event"), but must not USE it as the operating model.
        # The catch-all prompt should NOT describe the task in terms of
        # comparing two frames.
        assert "compare the before" not in prompt.lower()
        assert "items that moved onto or off of" not in prompt
        # Multi-item REMOVE math is a shelf concept (multiple items leave
        # the shelf in one motion). Catch-all is single-item — the prompt
        # may explicitly forbid multi_match (legitimate negation), but
        # must not USE it as a workflow.
        assert "populate \"multi_match\"" not in prompt
        assert "Multi-item REMOVEs are common" not in prompt

    def test_catch_all_prompt_does_not_use_catalog_weight_subset_math(self):
        """The shelf prompt instructs the model to find a SUBSET of
        candidates whose catalog weights sum to |delta| — this is wrong
        for catch-all (single item, partial fills are normal).

        Production evidence: event 7f5bee47 had reasoning containing
        shelf-flavored weight-fit math ("65% of catalog weight") because
        it was classified with the shelf prompt. The catch-all prompt
        must instead frame catalog weight as a sanity check, not a
        primary discriminator.
        """
        prompt = CATCH_ALL_SYSTEM_PROMPT
        assert "subset of candidates whose weights sum" not in prompt.lower()
        assert "ground truth" not in prompt.lower(), (
            "shelf prompt asserts 'catalog weights are ground truth' — "
            "catch-all should NOT inherit this framing because partial "
            "fills are common"
        )

    def test_catch_all_prompt_demands_strict_json(self):
        """Same structural requirement as the shelf prompt — the parser
        downstream is the same, so the JSON contract must hold."""
        assert "STRICT JSON" in CATCH_ALL_SYSTEM_PROMPT
        assert "JSON object" in CATCH_ALL_SYSTEM_PROMPT
        assert (
            "Do not include any text outside the JSON object."
            in CATCH_ALL_SYSTEM_PROMPT
        )

    def test_catch_all_prompt_lists_unknown_action(self):
        """unknown is the safety valve for empty / unidentifiable images."""
        assert '"unknown"' in CATCH_ALL_SYSTEM_PROMPT
        assert "UNKNOWN" in CATCH_ALL_SYSTEM_PROMPT


# ---------------------------------------------------------------------------
# Payload structure — single image, no before frame
# ---------------------------------------------------------------------------


class TestCatchAllPayloadStructure:
    def test_payload_has_one_image_block_only(self, after_frame_path):
        """Catch-all events send ONE image (the after frame) — never two.

        Mutation guard: reverting build_catch_all_messages_payload to
        emit both ``before_frame_path`` and ``after_frame_path`` (e.g.
        copy-paste from build_messages_payload) flips this — image_count
        becomes 2.
        """
        event = _catch_all_event(after_frame_path)
        candidates = [_candidate("lot_1", name="Coke 12oz")]

        payload = build_catch_all_messages_payload(event, candidates)
        blocks = payload["messages"][0]["content"]

        image_blocks = [b for b in blocks if b["type"] == "image"]
        assert len(image_blocks) == 1, (
            f"catch-all payload should send exactly 1 image (the after "
            f"frame), got {len(image_blocks)}. The before frame must "
            "NOT be included — catch-all events are single-moment."
        )

    def test_payload_ignores_before_frame_path_even_if_set(
        self, after_frame_path, tmp_path
    ):
        """Defense in depth: even if a stale before_frame_path is
        accidentally populated on the ScaleEvent (e.g. from a legacy
        catch-all row written under the dual-frame model before the
        single-frame migration), the catch-all builder must NOT inline
        it as a second image block.
        """
        legacy_before = tmp_path / "stale_before.jpg"
        legacy_before.write_bytes(_TINY_JPEG)

        event = ScaleEvent(
            event_id="evt_legacy",
            session_id=None,
            ts="2026-04-28T12:00:00.000Z",
            delta_g=240.0,
            before_weight_g=0.0,
            after_weight_g=240.0,
            direction="add",
            before_frame_path=str(legacy_before),  # legacy stale field
            after_frame_path=after_frame_path,
        )
        payload = build_catch_all_messages_payload(
            event, [_candidate("lot_1")]
        )
        blocks = payload["messages"][0]["content"]
        image_blocks = [b for b in blocks if b["type"] == "image"]
        assert len(image_blocks) == 1

    def test_payload_does_not_include_before_frame_caption(
        self, after_frame_path
    ):
        """The shelf payload includes "[above: before frame]" /
        "[above: after frame]" captions tying images to the delta. The
        catch-all payload uses a single neutral caption — there's no
        before/after distinction.

        Mutation guard: routing through build_messages_payload (the
        shelf builder) would re-introduce "before frame" — flips.
        """
        event = _catch_all_event(after_frame_path)
        payload = build_catch_all_messages_payload(
            event, [_candidate("lot_1")]
        )
        blocks = payload["messages"][0]["content"]
        text_blocks = [b for b in blocks if b["type"] == "text"]
        joined = "\n".join(b["text"] for b in text_blocks)
        assert "before frame" not in joined.lower()
        assert "[above: after frame]" not in joined
        # And there IS some kind of single-image caption present.
        assert any(
            "scale" in b["text"].lower() and "[above:" in b["text"]
            for b in text_blocks
        ), "expected a [above: ...] caption on the single image block"

    def test_payload_uses_catch_all_instruction_text(self, after_frame_path):
        """Final user block must be CATCH_ALL_INSTRUCTION_TEXT, not
        the shelf-flavored INSTRUCTION_TEXT.

        Mutation guard: pasting INSTRUCTION_TEXT into the catch-all
        builder by accident leaves "before frame" / "multi_match" /
        "ground truth" references in the final block — flips.
        """
        event = _catch_all_event(after_frame_path)
        payload = build_catch_all_messages_payload(
            event, [_candidate("lot_1")]
        )
        blocks = payload["messages"][0]["content"]
        last_text = blocks[-1]
        assert last_text["type"] == "text"
        assert last_text["text"] == CATCH_ALL_INSTRUCTION_TEXT
        # Sanity-check the instruction text doesn't USE shelf delta
        # vocabulary as its operating model. Catch-all may explicitly
        # forbid multi_match (legitimate negation — "do NOT include
        # multi_match"), but must not instruct the model to populate it.
        assert "before frame" not in CATCH_ALL_INSTRUCTION_TEXT.lower()
        assert "populate \"multi_match\"" not in CATCH_ALL_INSTRUCTION_TEXT
        assert "compare the before" not in CATCH_ALL_INSTRUCTION_TEXT.lower()

    def test_payload_uses_catch_all_system_prompt(self, after_frame_path):
        """``payload['system']`` must carry the catch-all system prompt."""
        event = _catch_all_event(after_frame_path)
        payload = build_catch_all_messages_payload(
            event, [_candidate("lot_1")]
        )
        system = payload["system"]
        # cache-on default: list-of-blocks with cache_control.
        assert isinstance(system, list)
        assert system[0]["text"] == CATCH_ALL_SYSTEM_PROMPT

    def test_payload_weight_text_is_absolute_not_delta_compare(
        self, after_frame_path
    ):
        """The weight-context block should describe the ABSOLUTE scale
        reading (the placed item's mass) — not a "shelf gained N g
        from N g to N g" delta narrative. Catch-all is single-moment.
        """
        event = _catch_all_event(after_frame_path, delta_g=355.0)
        payload = build_catch_all_messages_payload(
            event, [_candidate("lot_1", weight=355.0)]
        )
        blocks = payload["messages"][0]["content"]
        text_blocks = [b for b in blocks if b["type"] == "text"]
        joined = "\n".join(b["text"] for b in text_blocks)
        assert "Measured weight on scale" in joined
        # Absolute weight value present.
        assert "355" in joined


# ---------------------------------------------------------------------------
# Dispatcher routing — classify_event picks the catch-all prompt
# ---------------------------------------------------------------------------


class _CatchAllStubSource:
    """Minimal source that returns one in-flight catch-all candidate."""

    def __init__(self, *, in_flight=()):
        self._in_flight = list(in_flight)

    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []

    # Catch-all-specific accessors — see candidate_pool.pool_for_catch_all.
    def get_catch_all_in_flight_lots(self):
        return list(self._in_flight)

    def get_catch_all_inventory_lots(self):
        # Legacy certified-only Tier 2 method (no longer wired into
        # pool_for_catch_all after Task 4). Kept for protocol shape.
        return []

    def get_catch_all_user_inventory_lots(self):
        # Task 4 Tier 2 source. Stub returns empty here — these tests
        # exercise in-flight routing, not Tier-2 contribution.
        return []


class _RecordingClient:
    """Captures the payload sent to .send(...) so tests can inspect
    which system prompt was used.
    """

    def __init__(self, response_text: str):
        self._response = response_text
        self.last_payload: dict[str, Any] | None = None
        self.calls = 0

    def send(self, payload, *, model=None):
        self.last_payload = payload
        self.calls += 1
        return ClassifierCallResult(
            text=self._response,
            model=model or "claude-haiku-4-5",
            usage={"input_tokens": 10, "output_tokens": 5},
            raw=None,
        )


def _ok_response(item_id: str = "lot_1") -> str:
    return json.dumps({
        "item_id": item_id,
        "action": "added",
        "confidence": 0.9,
        "reasoning": "single can visible on countertop scale",
    })


class TestCatchAllDispatcherRouting:
    def test_catch_all_shelf_id_routes_to_catch_all_prompt(
        self, after_frame_path
    ):
        """``ctx.shelf_id == 'catch_all'`` must select the catch-all
        prompt. The recording client captures whatever system prompt
        the dispatcher actually sent.

        Mutation guard: deleting the ``getattr(ctx, 'shelf_id') ==
        'catch_all'`` branch in classify.classify_event routes through
        build_messages_payload — the recorded system prompt becomes
        SYSTEM_PROMPT and this test flips.
        """
        in_flight_lot = LotCandidate(
            lot_id="lot_1",
            product_id="prod_coke",
            name="Coke Can 12oz",
            brand="Coca-Cola",
            expected_weight_g=355.0,
            container_type="can",
            status="in_flight",
            reference_image_paths=(),
        )
        source = _CatchAllStubSource(in_flight=[in_flight_lot])
        client = _RecordingClient(_ok_response("lot_1"))
        ctx = ClassifierContext(
            source=source,
            anthropic_client=client,
            shelf_id="catch_all",
        )
        event = _catch_all_event(after_frame_path)

        result = classify_event(event, ctx)

        assert client.calls == 1
        sent_system = client.last_payload["system"]
        # System block format may be list-of-blocks (cache on) or string.
        sent_text = (
            sent_system[0]["text"] if isinstance(sent_system, list)
            else sent_system
        )
        assert sent_text == CATCH_ALL_SYSTEM_PROMPT, (
            "ctx.shelf_id='catch_all' must route through "
            "build_catch_all_messages_payload — the dispatcher leaked "
            "the shelf prompt into the catch-all path."
        )
        assert result.item_id == "lot_1"

    def test_live_shelf_id_routes_to_shelf_prompt(self, after_frame_path):
        """The shelf path must NOT regress — catch-all routing only
        triggers when ``ctx.shelf_id == 'catch_all'``. With shelf_id
        unset (or set to 'live_shelf') the classifier dispatches the
        original shelf prompt.

        Mutation guard: routing every event through the catch-all
        builder (e.g. dropping the conditional and always using
        build_catch_all_messages_payload) flips this.
        """
        from server.classifier.tests.test_classify import (
            FakeClient, StubSource, _lot,
        )

        before = Path(after_frame_path).parent / "before.jpg"
        before.write_bytes(_TINY_JPEG)
        event = ScaleEvent(
            event_id="evt_shelf_1",
            session_id="sesn_1",
            ts="2026-04-28T12:00:00.000Z",
            delta_g=-340.0,
            before_weight_g=2000.0,
            after_weight_g=1660.0,
            direction="remove",
            before_frame_path=str(before),
            after_frame_path=after_frame_path,
        )
        source = StubSource(on_shelf=[_lot("L1", name="Ketchup", weight=340)])
        client = _RecordingClient(_ok_response("L1"))
        # Wrap in something that exposes .send (RecordingClient does).
        # ClassifierContext default shelf_id is None — that's the
        # pre-catch-all behavior the test pins.
        ctx = ClassifierContext(source=source, anthropic_client=client)

        classify_event(event, ctx)

        assert client.calls == 1
        sent_system = client.last_payload["system"]
        sent_text = (
            sent_system[0]["text"] if isinstance(sent_system, list)
            else sent_system
        )
        assert sent_text == SYSTEM_PROMPT, (
            "shelf events (ctx.shelf_id None or 'live_shelf') must use "
            "the original shelf SYSTEM_PROMPT — the catch-all routing "
            "leaked into the shelf path."
        )

    def test_dispatcher_lifecycle_logs_prompt_variant(self, after_frame_path):
        """The classifier_prompt_prepared lifecycle event payload must
        carry ``prompt_variant`` so operators triaging classifier
        regressions can tell at a glance whether a given event went
        through the shelf or catch-all prompt path.

        Mutation guard: removing the ``prompt_variant`` key from the
        lifecycle payload makes the post-condition fail.
        """
        import server.classifier.classify as classify_mod

        captured: list[dict[str, Any]] = []

        def _sink(event_id, *, actor, reason_code, payload=None):
            captured.append(
                {
                    "event_id": event_id,
                    "actor": actor,
                    "reason_code": reason_code,
                    "payload": payload or {},
                }
            )

        in_flight_lot = LotCandidate(
            lot_id="lot_1",
            product_id="prod_coke",
            name="Coke Can",
            brand=None,
            expected_weight_g=355.0,
            container_type="can",
            status="in_flight",
            reference_image_paths=(),
        )
        source = _CatchAllStubSource(in_flight=[in_flight_lot])
        client = _RecordingClient(_ok_response("lot_1"))
        ctx = ClassifierContext(
            source=source, anthropic_client=client, shelf_id="catch_all",
        )
        event = _catch_all_event(after_frame_path)

        prev_sink = classify_mod._LIFECYCLE_SINK
        classify_mod.set_lifecycle_sink(_sink)
        try:
            classify_event(event, ctx)
        finally:
            classify_mod.set_lifecycle_sink(prev_sink)

        prepared = [
            c for c in captured
            if c["reason_code"] == "classifier_prompt_prepared"
        ]
        assert prepared, "expected a classifier_prompt_prepared lc event"
        assert prepared[0]["payload"].get("prompt_variant") == "catch_all"
